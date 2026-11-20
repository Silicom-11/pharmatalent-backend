#!/usr/bin/env node
require('dotenv').config();
require('../src/config/zonaHoraria').fijarZonaHoraria();
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');

/**
 * Rutina de mantenimiento preventivo (GP 08: «prevención de errores futuros»).
 *
 * Ejecuta las revisiones periódicas del plan (src/config/mantenimiento.js) y
 * deja su resultado como un mantenimiento PREVENTIVO cerrado, con una línea
 * por tarea. La pantalla Mantenimiento → Plan preventivo lee de ahí cuándo se
 * hizo cada revisión y cuándo toca la siguiente.
 *
 *   npm run preventivo                   todas las tareas de la rutina
 *   npm run preventivo -- --sin-respaldo sin la copia de seguridad
 *   npm run preventivo -- --sin-red      sin consultar npm (sin internet)
 *
 * Programado en el servidor (cron / Programador de tareas), una vez por semana.
 */

const BASE = path.join(__dirname, '..');
const RAIZ = path.join(BASE, '..');
const args = process.argv.slice(2);
const DIA = 86400000;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function correr(cmd, argumentos, cwd = BASE) {
  const r = spawnSync(cmd, argumentos, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && cmd === NPM, timeout: 180000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

/** npm audit de un proyecto: vulnerabilidades por severidad */
function auditoria(carpeta) {
  const r = correr(NPM, ['audit', '--json', '--omit=dev'], path.join(RAIZ, carpeta));
  try {
    const j = JSON.parse(r.salida.slice(r.salida.indexOf('{')));
    const v = j.metadata?.vulnerabilities || {};
    return { ok: true, criticas: v.critical || 0, altas: v.high || 0, moderadas: v.moderate || 0, bajas: v.low || 0, total: v.total || 0 };
  } catch {
    return { ok: false };
  }
}

function desactualizadas(carpeta) {
  const r = correr(NPM, ['outdated', '--json'], path.join(RAIZ, carpeta));
  try {
    const j = JSON.parse(r.salida.slice(r.salida.indexOf('{')) || '{}');
    return Object.entries(j).map(([nombre, d]) => ({ nombre, actual: d.current, deseada: d.wanted, ultima: d.latest }));
  } catch {
    return null;
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Mantenimiento = require('../src/models/Mantenimiento');
  const ErrorSistema = require('../src/models/ErrorSistema');
  const Notificacion = require('../src/models/Notificacion');
  const Usuario = require('../src/models/Usuario');
  const M = require('../src/config/mantenimiento');
  const { parametrosLegales, VERSION } = require('../src/services/salud');
  const ahora = new Date();
  const tareas = [];
  const anota = (codigo, ok, detalle) => { tareas.push({ codigo, ok, detalle }); console.log(`  ${ok ? '✓' : '!'} ${codigo.padEnd(13)} ${detalle}`); };

  console.log(`\nMANTENIMIENTO PREVENTIVO · PharmaTalent ${VERSION} · ${ahora.toLocaleString('es-PE')}\n`);

  // 1 · Copia de seguridad
  if (!args.includes('--sin-respaldo')) {
    const r = correr(process.execPath, ['scripts/respaldo.js']);
    const archivo = (r.salida.match(/pharmatalent-\d{8}-\d{6}\.json\.gz/) || [])[0];
    anota('RESPALDO', r.codigo === 0, r.codigo === 0 ? `Copia ${archivo || 'creada'}` : 'La copia falló: revisar el espacio en disco y la conexión');
  }

  // 2 · Registro de errores
  const desde = new Date(ahora - 7 * DIA);
  const [errores7d, sinAtender, porRuta] = await Promise.all([
    ErrorSistema.countDocuments({ creadoEn: { $gte: desde } }),
    ErrorSistema.countDocuments({ atendido: false }),
    ErrorSistema.aggregate([{ $match: { creadoEn: { $gte: desde } } }, { $group: { _id: '$ruta', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }]),
  ]);
  anota('ERRORES', sinAtender === 0,
    `${errores7d} error(es) en 7 días, ${sinAtender} sin atender${porRuta.length ? ` · más frecuentes: ${porRuta.map((r) => `${r._id} (${r.n})`).join(', ')}` : ''}`);

  // 3 · Integridad de los datos
  const integ = correr(process.execPath, ['scripts/integridad.js']);
  const resumenInteg = (integ.salida.match(/\d+ problema\(s\) grave\(s\), \d+ aviso\(s\)/) || integ.salida.match(/Sin incoherencias[^\n]*/) || ['sin resumen'])[0];
  anota('INTEGRIDAD', integ.codigo === 0, resumenInteg);

  // 4 · Parámetros legales vigentes
  const legal = parametrosLegales(ahora);
  anota('NORMATIVA', legal.avisos.length === 0,
    `RMV S/ ${legal.rmv.valor} (${legal.rmv.norma}) · UIT ${legal.uit.anio} S/ ${legal.uit.valor} (${legal.uit.norma})${legal.avisos.length ? ` · ${legal.avisos.join(' ')}` : ''}`);

  // 5 · Limpieza: notificaciones ya leídas hace más de 180 días
  const limite = new Date(ahora - M.DIAS_NOTIFICACION_LEIDA * DIA);
  const limpias = await Notificacion.deleteMany({ leido: true, $or: [{ leidoEn: { $lt: limite } }, { leidoEn: null, creadoEn: { $lt: limite } }] });
  anota('LIMPIEZA', true, `${limpias.deletedCount} notificación(es) leídas con más de ${M.DIAS_NOTIFICACION_LEIDA} días eliminadas`);

  // 6 · Dependencias y parches de seguridad
  if (!args.includes('--sin-red')) {
    const back = auditoria('pharmatalent-backend');
    const front = auditoria('pharmatalent-frontend');
    const atrasadasB = desactualizadas('pharmatalent-backend') || [];
    const atrasadasF = desactualizadas('pharmatalent-frontend') || [];
    if (!back.ok || !front.ok) {
      anota('DEPENDENCIAS', false, 'No se pudo consultar el registro de npm (¿sin internet?)');
    } else {
      const graves = back.criticas + back.altas + front.criticas + front.altas;
      const atrasadas = [...atrasadasB, ...atrasadasF].filter((d) => d.actual !== d.deseada);
      anota('DEPENDENCIAS', graves === 0,
        `npm audit: backend ${back.total} y frontend ${front.total} vulnerabilidad(es) (${graves} altas o críticas) · `
        + `${atrasadas.length} paquete(s) con parche o versión menor pendiente${atrasadas.length ? `: ${atrasadas.map((d) => `${d.nombre} ${d.actual}→${d.deseada}`).join(', ')}` : ''}`);
    }
  }

  const observadas = tareas.filter((t) => !t.ok);
  const admin = await Usuario.findOne({ rol: 'ADMIN', activo: true }).select('_id').lean();
  const etapas = M.TIPOS.PREVENTIVO.etapas;
  const quien = 'Rutina programada (npm run preventivo)';
  const registro = await Mantenimiento.create({
    tipo: 'PREVENTIVO',
    titulo: `Rutina preventiva del ${ahora.toLocaleDateString('es-PE')}`,
    descripcion: `Revisión periódica del plan preventivo: ${tareas.map((t) => t.codigo.toLowerCase()).join(', ')}.`,
    area: 'infraestructura', prioridad: observadas.length ? 'MEDIA' : 'BAJA', origen: 'PLAN',
    estado: 'CERRADO', etapa: etapas.length,
    reportadoPor: admin?._id, responsable: admin?._id,
    contexto: { versionSistema: VERSION },
    analisis: tareas.filter((t) => ['ERRORES', 'INTEGRIDAD', 'NORMATIVA', 'DEPENDENCIAS'].includes(t.codigo)).map((t) => `${t.codigo}: ${t.detalle}`).join('\n'),
    solucion: tareas.filter((t) => ['RESPALDO', 'LIMPIEZA'].includes(t.codigo)).map((t) => `${t.codigo}: ${t.detalle}`).join('\n') || 'Sin acciones de aplicación en esta ejecución',
    pruebas: observadas.length ? `Con observaciones: ${observadas.map((t) => t.codigo).join(', ')}` : 'Todas las revisiones sin observaciones',
    version: VERSION,
    tareas,
    cerradoEn: new Date(),
    historial: [
      { etapa: 0, accion: 'REGISTRO', nota: 'Ejecución programada', porNombre: quien, en: ahora },
      ...etapas.map((e, i) => ({ etapa: i, accion: i === etapas.length - 1 ? 'CIERRE' : 'AVANCE', nota: e.etiqueta, porNombre: quien, en: new Date() })),
    ],
  });
  console.log(`\n  Registrado como ${registro.codigo}${observadas.length ? ` · ${observadas.length} tarea(s) con observaciones` : ' · sin observaciones'}\n`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error('La rutina preventiva falló:', err.message); process.exit(1); });
