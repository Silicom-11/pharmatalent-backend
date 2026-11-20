require('dotenv').config();
require('../src/config/zonaHoraria');

const path = require('path');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');

/**
 * Traslada la base de datos al castellano.
 *
 * El código ya nombra en español sus entidades y atributos; los documentos
 * guardados, no. Mientras no se ejecute esto, cada consulta busca `empleado`
 * en documentos que tienen `employee` y no encuentra nada: la aplicación
 * arranca, no da error, y muestra todo vacío. Por eso la migración es parte del
 * cambio y no un añadido opcional.
 *
 * Renombra en dos tiempos:
 *   1. Las colecciones, con `renameCollection`, que es una operación de
 *      metadatos: no copia los documentos ni deja el sistema a medias.
 *   2. Los campos dentro de cada documento, en profundidad, incluidos los
 *      subdocumentos y los arreglos.
 *
 * Lo que NO toca, deliberadamente:
 *   · `antes` y `despues` de la bitácora. Guardan lo que se envió en su
 *     momento, con los nombres que existían ese día. Reescribirlos sería
 *     falsificar el registro que precisamente existe para no poder alterarse.
 *   · Los nombres de módulo (`payroll`, `welfare`): son vocabulario de la
 *     matriz de permisos, no atributos de ninguna entidad.
 *
 * Uso:
 *   node scripts/migrar-idioma.js              simula y no escribe nada
 *   node scripts/migrar-idioma.js --aplicar    ejecuta
 */

const GLOSARIO = require(path.join(__dirname, '..', '..', 'traduccion', 'glosario.json'));

const CAMPOS = GLOSARIO.campos;
const MODELOS = GLOSARIO.modelos;
const VALORES = GLOSARIO.valores;

const COLECCIONES = {
  employees: 'empleados',
  users: 'usuarios',
  positions: 'puestos',
  locations: 'locales',
  zones: 'zonas',
  schedules: 'horarios',
  shifts: 'turnos',
  attendances: 'asistencias',
  vacations: 'vacaciones',
  evaluations: 'evaluaciones',
  contracts: 'contratos',
  settlements: 'liquidaciones',
  payrolls: 'boletas',
  trainings: 'capacitaciones',
  notifications: 'notificaciones',
  requisitions: 'requerimientos',
  candidates: 'candidatos',
  medicalleaves: 'descansosmedicos',
  auditvisits: 'visitasauditoria',
  auditlogs: 'bitacoras',
};

/** Rutas cuyo contenido se copia tal cual, sin renombrar sus claves */
const INTOCABLES = new Set(['antes', 'despues']);

/** Campos cuyo valor nombra un modelo y hay que traducir también */
const VALOR_ES_MODELO = new Set(['relatedModel', 'modeloRelacionado']);

const aplicar = process.argv.includes('--aplicar');

let clavesRenombradas = 0;
let valoresRenombrados = 0;

/**
 * Copia un valor renombrando claves en profundidad.
 * `intocable` corta la recursión: dentro de la bitácora se conserva el original.
 */
function traducir(valor, intocable = false) {
  if (Array.isArray(valor)) return valor.map((v) => traducir(v, intocable));

  if (valor === null || typeof valor !== 'object') {
    if (typeof valor === 'string' && VALORES[valor] !== undefined) {
      valoresRenombrados += 1;
      return VALORES[valor];
    }
    return valor;
  }

  // Los tipos propios de BSON (ObjectId, Date, Decimal128) se dejan intactos:
  // recorrer sus entrañas los convertiría en objetos planos
  if (valor._bsontype || valor instanceof Date) return valor;

  const salida = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (intocable) {
      salida[clave] = v;
      continue;
    }

    let nuevaClave = clave;
    if (Object.prototype.hasOwnProperty.call(VALORES, clave)) {
      nuevaClave = VALORES[clave];          // la clave «MAÑANA» del horario
      clavesRenombradas += 1;
    } else if (Object.prototype.hasOwnProperty.call(CAMPOS, clave) && clave !== '_id') {
      nuevaClave = CAMPOS[clave];
      clavesRenombradas += 1;
    }

    if (VALOR_ES_MODELO.has(clave) && typeof v === 'string' && MODELOS[v]) {
      salida[nuevaClave] = MODELOS[v];
      valoresRenombrados += 1;
      continue;
    }

    salida[nuevaClave] = traducir(v, INTOCABLES.has(clave));
  }
  return salida;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Falta MONGODB_URI');

  const cliente = new MongoClient(uri);
  await cliente.connect();
  const db = cliente.db();

  console.log('Base de datos : %s', db.databaseName);
  console.log('Modo          : %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const existentes = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const resumen = [];

  for (const [vieja, nueva] of Object.entries(COLECCIONES)) {
    const origen = existentes.has(vieja) ? vieja : (existentes.has(nueva) ? nueva : null);
    if (!origen) {
      resumen.push([vieja, nueva, '—', 'no existe']);
      continue;
    }

    // Renombrar la colección primero: es metadato, no mueve documentos
    if (origen === vieja && vieja !== nueva) {
      if (existentes.has(nueva)) {
        resumen.push([vieja, nueva, '—', 'DESTINO YA EXISTE, se omite']);
        continue;
      }
      if (aplicar) await db.collection(vieja).rename(nueva);
    }

    const coleccion = db.collection(aplicar || origen === nueva ? nueva : vieja);

    /**
     * Los índices viejos se retiran ANTES de reescribir, no después.
     *
     * Se aprendió por las malas: `usuarios` conservaba el índice único
     * `email_1`, y en cuanto el primer documento cambió `email` por `correo`,
     * el segundo entró con `email: null` —igual que el primero— y MongoDB lo
     * rechazó por duplicado. La migración se detuvo a medio camino.
     */
    if (aplicar) {
      const indices = await coleccion.indexes();
      for (const i of indices) {
        if (i.name === '_id_') continue;
        await coleccion.dropIndex(i.name);
      }
    }

    const documentos = await coleccion.find({}).toArray();

    let tocados = 0;
    for (const doc of documentos) {
      const traducido = traducir(doc);
      const cambio = JSON.stringify(Object.keys(doc)) !== JSON.stringify(Object.keys(traducido))
        || JSON.stringify(doc) !== JSON.stringify(traducido);
      if (!cambio) continue;
      tocados += 1;
      if (aplicar) await coleccion.replaceOne({ _id: doc._id }, traducido);
    }

    resumen.push([vieja, nueva, documentos.length, `${tocados} documento(s) reescrito(s)`]);
  }

  console.log('%s %s %s  %s', 'ANTES'.padEnd(16), 'AHORA'.padEnd(18), 'DOCS'.padStart(5), 'RESULTADO');
  for (const [a, b, n, r] of resumen) {
    console.log('%s %s %s  %s', a.padEnd(16), b.padEnd(18), String(n).padStart(5), r);
  }

  console.log('\nclaves renombradas : %d', clavesRenombradas);
  console.log('valores traducidos : %d', valoresRenombrados);

  // Los índices viejos apuntan a campos que ya no existen: se rehacen desde
  // los esquemas, que son ahora la única definición válida
  if (aplicar) {
    console.log('\nReconstruyendo índices…');
    await mongoose.connect(uri);
    const modelos = require('../src/models');
    const Bitacora = require('../src/models/Bitacora');
    // Se recogen los fallos en vez de abortar: si un índice está mal definido,
    // el resto de las colecciones debe quedar indexado igualmente, y el
    // problema tiene que verse entero y no de uno en uno
    const fallidos = [];
    for (const [nombre, M] of Object.entries({ ...modelos, Bitacora })) {
      try {
        await M.syncIndexes();
        console.log('  %s', nombre);
      } catch (e) {
        fallidos.push([nombre, e.message.split('\n')[0]]);
        console.log('  %s  ← FALLÓ', nombre);
      }
    }
    await mongoose.disconnect();
    if (fallidos.length) {
      console.log('\nÍndices que no se pudieron crear:');
      for (const [n, m] of fallidos) console.log('  %s: %s', n, m);
      await cliente.close();
      process.exit(1);
    }
  }

  await cliente.close();
  console.log('\n%s', aplicar ? 'Migración terminada.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('\nFALLÓ:', e.message); process.exit(1); });
