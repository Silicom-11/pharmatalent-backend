const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const P = require('../config/payrollParams');
const M = require('../config/mantenimiento');

/**
 * Monitoreo del sistema para el mantenimiento: lo que el administrador
 * revisa antes de que algo falle.
 *
 * Responde de un vistazo a las preguntas del plan preventivo: ¿hay copia de
 * hoy?, ¿qué está fallando?, ¿los parámetros legales siguen vigentes?, ¿qué
 * revisión periódica está atrasada?
 */

const DIA = 86400000;
const RAIZ = path.join(__dirname, '..', '..');
const VERSION = require(path.join(RAIZ, 'package.json')).version;
const CARPETA_RESPALDOS = process.env.DIR_RESPALDOS || path.join(RAIZ, 'respaldos');
const INICIO = new Date();

/** La copia más reciente de la carpeta de respaldos */
function ultimoRespaldo() {
  try {
    const copias = fs.readdirSync(CARPETA_RESPALDOS)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => {
        const st = fs.statSync(path.join(CARPETA_RESPALDOS, f));
        return { archivo: f, fecha: st.mtime, tamanoMB: Math.round((st.size / 1048576) * 100) / 100 };
      })
      .sort((a, b) => b.fecha - a.fecha);
    return { total: copias.length, ultima: copias[0] || null };
  } catch {
    return { total: 0, ultima: null };
  }
}

/**
 * Última ejecución de cada tarea del plan preventivo.
 * La copia de seguridad se toma también de la carpeta: `npm run respaldo`
 * puede correr solo, programado en el servidor.
 */
async function planPreventivo(Mantenimiento, respaldo, ahora = new Date()) {
  const ultimas = await Mantenimiento.aggregate([
    { $match: { tipo: 'PREVENTIVO', 'tareas.0': { $exists: true } } },
    { $unwind: '$tareas' },
    { $sort: { creadoEn: -1 } },
    { $group: { _id: '$tareas.codigo', en: { $first: '$creadoEn' }, ok: { $first: '$tareas.ok' }, detalle: { $first: '$tareas.detalle' }, codigo: { $first: '$codigo' } } },
  ]);
  const porTarea = new Map(ultimas.map((u) => [u._id, u]));
  return M.PLAN_PREVENTIVO.map((t) => {
    let ultima = porTarea.get(t.codigo) || null;
    if (t.codigo === 'RESPALDO' && respaldo.ultima && (!ultima || respaldo.ultima.fecha > ultima.en)) {
      ultima = { en: respaldo.ultima.fecha, ok: true, detalle: respaldo.ultima.archivo };
    }
    const proxima = ultima ? new Date(new Date(ultima.en).getTime() + t.cadaDias * DIA) : null;
    return {
      ...t,
      ultima: ultima ? { en: ultima.en, ok: ultima.ok, detalle: ultima.detalle, registro: ultima.codigo } : null,
      proxima,
      vencida: !proxima || proxima < ahora,
    };
  });
}

/** Los parámetros legales que el sistema está usando hoy, con su norma */
function parametrosLegales(hoy = new Date()) {
  const rmv = P.rmvVigenteDetalle(hoy);
  const uit = P.uitDetalle(hoy.getFullYear());
  const avisos = [];
  if (!uit.registrada) {
    avisos.push(`No está registrada la UIT de ${hoy.getFullYear()}: se usa la de ${uit.anio}. Agréguela en src/config/payrollParams.js.`);
  }
  return {
    rmv: { valor: rmv.valor, desde: rmv.desde, norma: rmv.norma },
    uit: { valor: uit.valor, anio: uit.anio, norma: uit.norma, registrada: uit.registrada },
    asignacionFamiliar: Math.round(rmv.valor * P.ASIGNACION_FAMILIAR.porcentajeRMV * 100) / 100,
    avisos,
  };
}

async function estadoDelSistema() {
  const Mantenimiento = require('../models/Mantenimiento');
  const ErrorSistema = require('../models/ErrorSistema');
  const ahora = new Date();
  const db = mongoose.connection.db;

  const [info, stats, errores7d, sinAtender, porRuta, abiertos, vencidos] = await Promise.all([
    db.admin().buildInfo().catch(() => null),
    db.stats().catch(() => null),
    ErrorSistema.countDocuments({ creadoEn: { $gte: new Date(ahora - 7 * DIA) } }),
    ErrorSistema.countDocuments({ atendido: false }),
    ErrorSistema.aggregate([
      { $match: { creadoEn: { $gte: new Date(ahora - 30 * DIA) } } },
      { $group: { _id: { metodo: '$metodo', ruta: '$ruta' }, veces: { $sum: 1 }, ultima: { $max: '$creadoEn' } } },
      { $sort: { veces: -1 } }, { $limit: 5 },
    ]),
    Mantenimiento.countDocuments({ estado: { $in: ['ABIERTO', 'EN_CURSO'] } }),
    Mantenimiento.countDocuments({ estado: { $in: ['ABIERTO', 'EN_CURSO'] }, fechaLimite: { $lt: ahora } }),
  ]);

  const respaldo = ultimoRespaldo();
  respaldo.reciente = Boolean(respaldo.ultima) && ahora - respaldo.ultima.fecha <= 2 * DIA;
  const plan = await planPreventivo(Mantenimiento, respaldo, ahora);
  const legal = parametrosLegales(ahora);

  // Semáforo: rojo si algo exige actuar hoy, ámbar si hay que mirar
  const alertas = [];
  if (!respaldo.reciente) alertas.push({ nivel: 'ALTA', texto: 'No hay copia de seguridad de los últimos dos días.' });
  if (sinAtender > 0) alertas.push({ nivel: 'MEDIA', texto: `${sinAtender} error(es) del sistema sin atender.` });
  if (vencidos > 0) alertas.push({ nivel: 'MEDIA', texto: `${vencidos} mantenimiento(s) fuera de plazo.` });
  for (const a of legal.avisos) alertas.push({ nivel: 'ALTA', texto: a });
  const atrasadas = plan.filter((t) => t.vencida);
  if (atrasadas.length) alertas.push({ nivel: 'BAJA', texto: `Revisiones preventivas por hacer: ${atrasadas.map((t) => t.etiqueta.toLowerCase()).join('; ')}.` });

  return {
    version: VERSION,
    entorno: process.env.NODE_ENV || 'development',
    node: process.version,
    mongo: info?.version || null,
    activoDesde: INICIO,
    base: stats ? {
      nombre: stats.db,
      colecciones: stats.collections,
      documentos: stats.objects,
      datosMB: Math.round((stats.dataSize / 1048576) * 10) / 10,
      almacenamientoMB: Math.round((stats.storageSize / 1048576) * 10) / 10,
    } : null,
    respaldo,
    errores: { ultimos7Dias: errores7d, sinAtender, rutasQueMasFallan: porRuta.map((r) => ({ ...r._id, veces: r.veces, ultima: r.ultima })) },
    mantenimientos: { abiertos, vencidos },
    parametrosLegales: legal,
    plan,
    alertas,
    semaforo: alertas.some((a) => a.nivel === 'ALTA') ? 'ROJO' : alertas.some((a) => a.nivel === 'MEDIA') ? 'AMBAR' : 'VERDE',
  };
}

module.exports = { estadoDelSistema, parametrosLegales, planPreventivo, ultimoRespaldo, VERSION };
