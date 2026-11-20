#!/usr/bin/env node
require('dotenv').config();
// La zona horaria se impone antes de crear cualquier fecha
require('../src/config/zonaHoraria').fijarZonaHoraria();
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

/**
 * Copia de respaldo de la base de datos.
 *
 * Un sistema que liquida planillas no puede depender de que el servidor no
 * falle: la ley obliga a conservar boletas y contratos cinco años, y esa
 * obligación no se suspende porque se haya perdido un disco.
 *
 * Se escribe en JSON comprimido y no en el formato binario de mongodump por
 * dos razones: no exige tener instaladas las herramientas de MongoDB, y el
 * contenido se puede inspeccionar y restaurar parcialmente si hace falta.
 * Para volúmenes muy grandes, mongodump sigue siendo preferible.
 *
 * Se usa EJSON y no JSON.stringify: éste convierte cada ObjectId y cada fecha
 * en una cadena, de modo que al restaurar las referencias entre documentos
 * dejarían de ser identificadores y todas las relaciones se romperían en
 * silencio. EJSON conserva el tipo.
 *
 *   node scripts/respaldo.js                      copia completa
 *   node scripts/respaldo.js --salida ./copias    en otra carpeta
 *   node scripts/respaldo.js --listar             lista las copias existentes
 */

const CARPETA_POR_DEFECTO = path.join(__dirname, '..', 'respaldos');

/** Colecciones cuyo contenido no vale la pena copiar */
const PRESCINDIBLES = ['notifications'];

const args = process.argv.slice(2);
const opcion = (nombre, pordefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : pordefecto;
};
const bandera = (nombre) => args.includes(`--${nombre}`);

const dosDigitos = (n) => String(n).padStart(2, '0');
const marcaDeTiempo = () => {
  const f = new Date();
  return `${f.getFullYear()}${dosDigitos(f.getMonth() + 1)}${dosDigitos(f.getDate())}`
    + `-${dosDigitos(f.getHours())}${dosDigitos(f.getMinutes())}${dosDigitos(f.getSeconds())}`;
};

const enMegas = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

function listarCopias(carpeta) {
  if (!fs.existsSync(carpeta)) {
    console.log(`No hay copias todavía (${carpeta} no existe).`);
    return;
  }
  const copias = fs.readdirSync(carpeta)
    .filter((f) => f.endsWith('.json.gz'))
    .map((f) => ({ nombre: f, ...fs.statSync(path.join(carpeta, f)) }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!copias.length) return console.log('No hay copias en ' + carpeta);

  console.log(`\nCopias en ${carpeta}\n`);
  for (const c of copias) {
    const dias = Math.floor((Date.now() - c.mtime) / 86400000);
    console.log(`  ${c.nombre.padEnd(42)} ${enMegas(c.size).padStart(10)}   `
      + `${dias === 0 ? 'hoy' : `hace ${dias} día(s)`}`);
  }
  console.log(`\n  ${copias.length} copia(s), la más reciente de ${copias[0].mtime.toLocaleString('es-PE')}\n`);
}

async function respaldar() {
  const carpeta = path.resolve(opcion('salida', CARPETA_POR_DEFECTO));
  fs.mkdirSync(carpeta, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const nombreBase = mongoose.connection.name;

  const colecciones = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const volcado = {
    formato: 'pharmatalent/respaldo@1',
    baseDeDatos: nombreBase,
    generado: new Date().toISOString(),
    colecciones: {},
  };

  console.log(`\nRespaldando «${nombreBase}»\n`);
  let documentos = 0;

  for (const nombre of colecciones) {
    if (PRESCINDIBLES.includes(nombre)) {
      console.log(`  ${nombre.padEnd(24)} omitida (se regenera sola)`);
      continue;
    }
    const docs = await db.collection(nombre).find({}).toArray();
    volcado.colecciones[nombre] = docs;
    documentos += docs.length;
    console.log(`  ${nombre.padEnd(24)} ${String(docs.length).padStart(6)} documento(s)`);
  }

  // EJSON conserva ObjectId y Date; JSON.stringify los aplanaría a texto
  const json = EJSON.stringify(volcado, { relaxed: false });
  const comprimido = zlib.gzipSync(json, { level: 9 });

  // La huella permite comprobar después que el archivo no se corrompió
  const huella = crypto.createHash('sha256').update(comprimido).digest('hex');
  const archivo = path.join(carpeta, `${nombreBase}-${marcaDeTiempo()}.json.gz`);

  fs.writeFileSync(archivo, comprimido);
  fs.writeFileSync(`${archivo}.sha256`, `${huella}  ${path.basename(archivo)}\n`);

  console.log(`\n  ${documentos} documentos en ${colecciones.length - PRESCINDIBLES.length} colecciones`);
  console.log(`  ${enMegas(json.length)} sin comprimir → ${enMegas(comprimido.length)} comprimido`);
  console.log(`\n  ${archivo}`);
  console.log(`  sha256 ${huella.slice(0, 32)}…\n`);
  console.log('  Guárdelo FUERA de este servidor. Una copia que se pierde con la máquina');
  console.log('  que respalda no es una copia de respaldo.\n');

  await mongoose.disconnect();
}

if (bandera('listar')) {
  listarCopias(path.resolve(opcion('salida', CARPETA_POR_DEFECTO)));
} else {
  respaldar().catch((err) => {
    console.error('\nNo se pudo respaldar:', err.message, '\n');
    process.exit(1);
  });
}
