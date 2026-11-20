require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');

/**
 * Renombra en la base de datos la colección «colaboradores» a «empleados» y
 * «puestos» a «cargos», con los campos que las referencian.
 *
 * Se ejecuta después de renombrar el código y antes de volver a levantar la
 * aplicación. Con el código buscando la colección nueva y los documentos aún en
 * la vieja, el sistema arranca sin errores y lo muestra todo vacío, que es la
 * forma más incómoda de fallar: parece que se perdieron los datos.
 *
 * Uso:
 *   node scripts/migrar-empleado-cargo.js              simula
 *   node scripts/migrar-empleado-cargo.js --aplicar    ejecuta
 */

const COLECCIONES = {
  colaboradores: 'empleados',
  puestos: 'cargos',
};

/** Claves de documento que cambian de nombre, en cualquier profundidad */
const CAMPOS = {
  colaborador: 'empleado',
  colaboradorConforme: 'empleadoConforme',
  colaboradorContratado: 'empleadoContratado',
  comentarioColaborador: 'comentarioEmpleado',
  firmadoPorColaborador: 'firmadoPorEmpleado',
  puesto: 'cargo',
  puestoActual: 'cargoActual',
  historialPuestos: 'historialCargos',
};

/**
 * `antes` y `despues` de la bitácora guardan lo que se envió el día que se
 * envió. Reescribirlos sería alterar el registro que existe justamente para no
 * poder alterarse.
 */
const INTOCABLES = new Set(['antes', 'despues']);

/** Campos cuyo valor de texto nombra un modelo */
const VALOR_ES_MODELO = new Set(['modeloRelacionado']);
const MODELOS = { Colaborador: 'Empleado', Puesto: 'Cargo' };

const aplicar = process.argv.includes('--aplicar');
let claves = 0;
let valores = 0;

function traducir(valor, intocable = false) {
  if (Array.isArray(valor)) return valor.map((v) => traducir(v, intocable));
  if (valor === null || typeof valor !== 'object') return valor;
  if (valor._bsontype || valor instanceof Date) return valor;

  const salida = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (intocable) { salida[clave] = v; continue; }

    let nueva = clave;
    if (Object.prototype.hasOwnProperty.call(CAMPOS, clave)) {
      nueva = CAMPOS[clave];
      claves += 1;
    }

    if (VALOR_ES_MODELO.has(clave) && typeof v === 'string' && MODELOS[v]) {
      salida[nueva] = MODELOS[v];
      valores += 1;
      continue;
    }

    salida[nueva] = traducir(v, INTOCABLES.has(clave));
  }
  return salida;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const cliente = new MongoClient(uri);
  await cliente.connect();
  const db = cliente.db();

  console.log('Base de datos : %s', db.databaseName);
  console.log('Modo          : %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const existentes = new Set((await db.listCollections().toArray()).map((c) => c.name));

  // 1 · Renombrar las dos colecciones afectadas
  for (const [vieja, nueva] of Object.entries(COLECCIONES)) {
    if (!existentes.has(vieja)) {
      console.log('  %s -> %s   (ya renombrada o inexistente)', vieja, nueva);
      continue;
    }
    if (existentes.has(nueva)) {
      console.log('  %s -> %s   DESTINO YA EXISTE, se omite', vieja, nueva);
      continue;
    }
    if (aplicar) await db.collection(vieja).rename(nueva);
    console.log('  %s -> %s', vieja, nueva);
  }

  // 2 · Los campos cambian en TODAS las colecciones, no sólo en las renombradas:
  //     `empleado` es la clave foránea que usan contratos, boletas, turnos…
  console.log();
  const todas = (await db.listCollections().toArray()).map((c) => c.name).sort();
  for (const nombre of todas) {
    const coleccion = db.collection(nombre);

    // Los índices viejos nombran campos que dejan de existir. Se retiran antes
    // de reescribir: un índice único sobre un campo que pasa a faltar convierte
    // el segundo documento en un duplicado y detiene la migración.
    if (aplicar) {
      for (const i of await coleccion.indexes()) {
        if (i.name !== '_id_') await coleccion.dropIndex(i.name);
      }
    }

    const documentos = await coleccion.find({}).toArray();
    let tocados = 0;
    for (const doc of documentos) {
      const nuevo = traducir(doc);
      if (JSON.stringify(doc) === JSON.stringify(nuevo)) continue;
      tocados += 1;
      if (aplicar) await coleccion.replaceOne({ _id: doc._id }, nuevo);
    }
    console.log('  %s %s %s', nombre.padEnd(20), String(documentos.length).padStart(5),
      tocados ? `${tocados} reescrito(s)` : '—');
  }

  console.log('\nclaves renombradas : %d', claves);
  console.log('valores traducidos : %d', valores);

  if (aplicar) {
    console.log('\nReconstruyendo índices…');
    await mongoose.connect(uri);
    const modelos = require('../src/models');
    const Bitacora = require('../src/models/Bitacora');
    const fallidos = [];
    for (const [n, M] of Object.entries({ ...modelos, Bitacora })) {
      try { await M.syncIndexes(); } catch (e) { fallidos.push([n, e.message.split('\n')[0]]); }
    }
    await mongoose.disconnect();
    console.log('  %d modelos indexados', Object.keys(modelos).length + 1 - fallidos.length);
    for (const [n, m] of fallidos) console.log('  FALLÓ %s: %s', n, m);
  }

  await cliente.close();
  console.log('\n%s', aplicar ? 'Migración terminada.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('\nFALLÓ:', e.message); process.exit(1); });
