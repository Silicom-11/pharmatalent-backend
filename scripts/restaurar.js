#!/usr/bin/env node
require('dotenv').config();
// La zona horaria se impone antes de crear cualquier fecha
require('../src/config/zonaHoraria').fijarZonaHoraria();
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

/**
 * Restauración desde una copia.
 *
 * Restaurar BORRA lo que hay. Una copia que nunca se ha probado a restaurar no
 * es una copia: es un archivo. Por eso este guión existe y por eso pide
 * confirmación escrita en vez de un simple sí.
 *
 *   node scripts/restaurar.js copia.json.gz --revisar     comprueba sin tocar nada
 *   node scripts/restaurar.js copia.json.gz               restaura (pide confirmar)
 *   node scripts/restaurar.js copia.json.gz --si          sin preguntar (para guiones)
 */

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const bandera = (n) => args.includes(`--${n}`);

if (!archivo) {
  console.error('\nIndique el archivo de copia.\n  node scripts/restaurar.js respaldos/pharmatalent-20260830-120000.json.gz\n');
  process.exit(1);
}

const ruta = path.resolve(archivo);
if (!fs.existsSync(ruta)) {
  console.error(`\nNo existe el archivo ${ruta}\n`);
  process.exit(1);
}

/** Comprueba la huella y descomprime */
function leerCopia() {
  const comprimido = fs.readFileSync(ruta);
  const huellaCalculada = crypto.createHash('sha256').update(comprimido).digest('hex');

  const archivoHuella = `${ruta}.sha256`;
  if (fs.existsSync(archivoHuella)) {
    const esperada = fs.readFileSync(archivoHuella, 'utf8').trim().split(/\s+/)[0];
    if (esperada !== huellaCalculada) {
      console.error('\nLa huella no coincide: el archivo está corrupto o fue alterado.');
      console.error(`  esperada  ${esperada}`);
      console.error(`  calculada ${huellaCalculada}\n`);
      process.exit(1);
    }
    console.log('  huella verificada');
  } else {
    console.log('  sin archivo .sha256: no se pudo verificar la integridad');
  }

  const volcado = EJSON.parse(zlib.gunzipSync(comprimido).toString('utf8'), { relaxed: false });
  if (volcado.formato !== 'pharmatalent/respaldo@1') {
    console.error(`\nFormato no reconocido: «${volcado.formato}»\n`);
    process.exit(1);
  }
  return volcado;
}

function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => rl.question(texto, (r) => { rl.close(); resolver(r); }));
}

// EJSON.parse ya devuelve ObjectId y Date con su tipo: no hay que reconstruirlos

(async () => {
  console.log(`\nLeyendo ${path.basename(ruta)}\n`);
  const volcado = leerCopia();

  const resumen = Object.entries(volcado.colecciones)
    .map(([nombre, docs]) => ({ nombre, total: docs.length }))
    .sort((a, b) => b.total - a.total);
  const totalDocs = resumen.reduce((a, c) => a + c.total, 0);

  console.log(`  base original : ${volcado.baseDeDatos}`);
  console.log(`  generada el   : ${new Date(volcado.generado).toLocaleString('es-PE')}`);
  console.log(`  contiene      : ${totalDocs} documentos en ${resumen.length} colecciones\n`);
  resumen.forEach((c) => console.log(`    ${c.nombre.padEnd(24)} ${String(c.total).padStart(6)}`));

  if (bandera('revisar')) {
    console.log('\n  Revisión sin cambios: la copia es legible y consistente.\n');
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const destino = mongoose.connection.name;

  // Lo que se va a perder, dicho antes de perderlo
  const actuales = (await db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
  let aBorrar = 0;
  for (const c of actuales) aBorrar += await db.collection(c.name).countDocuments();

  console.log(`\n  DESTINO: ${destino}`);
  console.log(`  Contiene ahora ${aBorrar} documentos que se ELIMINARÁN.\n`);

  if (!bandera('si')) {
    const r = await preguntar(`  Escriba el nombre de la base para confirmar («${destino}»): `);
    if (r.trim() !== destino) {
      console.log('\n  Cancelado: no se tocó nada.\n');
      await mongoose.disconnect();
      return;
    }
  }

  console.log('');
  for (const [nombre, docs] of Object.entries(volcado.colecciones)) {
    const coleccion = db.collection(nombre);
    await coleccion.deleteMany({});
    if (docs.length) await coleccion.insertMany(docs, { ordered: false });
    console.log(`  ${nombre.padEnd(24)} ${String(docs.length).padStart(6)} restaurado(s)`);
  }

  console.log(`\n  Restauración terminada: ${totalDocs} documentos en «${destino}».`);
  console.log('  Compruebe que puede entrar al sistema antes de dar por buena la operación.\n');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('\nNo se pudo restaurar:', err.message, '\n');
  process.exit(1);
});
