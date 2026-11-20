#!/usr/bin/env node
require('dotenv').config();
// La zona horaria se impone antes de crear cualquier fecha
require('../src/config/zonaHoraria').fijarZonaHoraria();
const mongoose = require('mongoose');

/**
 * Revisión de coherencia de los datos.
 *
 * Mongo no impone claves foráneas: una referencia puede apuntar a un documento
 * que ya no existe y nada avisa. En un sistema de RRHH eso se traduce en una
 * boleta sin dueño, un contrato de alguien que ya no está o una botica sin
 * Director Técnico designado. Esto lo busca y lo dice; no corrige nada solo.
 *
 *   node scripts/integridad.js
 */

const problemas = [];
const anotar = (gravedad, asunto, detalle) => problemas.push({ gravedad, asunto, detalle });

async function revisar() {
  await mongoose.connect(process.env.MONGODB_URI);
  const {
    Empleado, Usuario, Boleta, Contrato, Local, Cargo, Vacacion, Asistencia,
  } = require('../src/models');

  const idsEmpleado = new Set((await Empleado.find().select('_id').lean()).map((e) => String(e._id)));
  const idsLocal = new Set((await Local.find().select('_id').lean()).map((l) => String(l._id)));
  const idsPuesto = new Set((await Cargo.find().select('_id').lean()).map((p) => String(p._id)));

  const colgante = (id, conjunto) => id && !conjunto.has(String(id));

  // ─── Referencias rotas ───
  for (const [Modelo, campo, conjunto, nombre] of [
    [Boleta, 'empleado', idsEmpleado, 'boleta'],
    [Contrato, 'empleado', idsEmpleado, 'contrato'],
    [Vacacion, 'empleado', idsEmpleado, 'descanso'],
    [Asistencia, 'empleado', idsEmpleado, 'marca de asistencia'],
    [Usuario, 'empleado', idsEmpleado, 'cuenta'],
    [Empleado, 'localActual', idsLocal, 'empleado (centro)'],
    [Empleado, 'cargoActual', idsPuesto, 'empleado (puesto)'],
  ]) {
    const docs = await Modelo.find().select(`_id ${campo}`).lean();
    const rotas = docs.filter((d) => colgante(d[campo], conjunto));
    if (rotas.length) {
      anotar('GRAVE', `${rotas.length} ${nombre}(s) apuntan a un registro inexistente`,
        rotas.slice(0, 3).map((d) => `${d._id} → ${campo}=${d[campo]}`).join(', '));
    }
  }

  // ─── Cuentas ───
  const conCuenta = new Set((await Usuario.find().select('empleado').lean())
    .map((u) => String(u.empleado)).filter((x) => x !== 'undefined'));
  const activos = await Empleado.find({ estado: 'ACTIVO' }).select('_id nombres apellidos').lean();
  const sinCuenta = activos.filter((e) => !conCuenta.has(String(e._id)));
  if (sinCuenta.length) {
    anotar('AVISO', `${sinCuenta.length} empleado(es) activos no pueden entrar al sistema`,
      'Sin cuenta no marcan asistencia ni ven su boleta');
  }

  const cesadosConAcceso = await Usuario.find({ activo: true }).populate('empleado', 'estado nombres apellidos').lean();
  const fantasmas = cesadosConAcceso.filter((u) => u.empleado?.estado === 'CESADO');
  if (fantasmas.length) {
    anotar('GRAVE', `${fantasmas.length} cuenta(s) activas pertenecen a personal cesado`,
      fantasmas.slice(0, 3).map((u) => u.correo).join(', '));
  }

  const admins = await Usuario.countDocuments({ rol: 'ADMIN', activo: true });
  if (admins === 0) anotar('GRAVE', 'No hay ningún administrador activo', 'Nadie puede gestionar cuentas');

  // ─── Duplicados que deberían ser únicos ───
  for (const [Modelo, campo, nombre] of [
    [Empleado, 'dni', 'empleados con el mismo DNI'],
    [Usuario, 'correo', 'cuentas con el mismo correo'],
    [Local, 'codigo', 'centros con el mismo código'],
  ]) {
    const repes = await Modelo.aggregate([
      { $match: { [campo]: { $ne: null } } },
      { $group: { _id: `$${campo}`, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    if (repes.length) {
      anotar('GRAVE', `${repes.length} ${nombre}`, repes.slice(0, 3).map((r) => r._id).join(', '));
    }
  }

  // ─── Coherencia laboral ───
  const sinContrato = [];
  for (const e of activos) {
    const n = await Contrato.countDocuments({ empleado: e._id, estado: { $in: ['VIGENTE', 'POR_VENCER'] } });
    if (n === 0) sinContrato.push(`${e.nombres} ${e.apellidos}`);
  }
  if (sinContrato.length) {
    anotar('GRAVE', `${sinContrato.length} empleado(es) activos sin contrato vigente`,
      sinContrato.slice(0, 3).join(', '));
  }

  const boletasDuplicadas = await Boleta.aggregate([
    { $group: { _id: { empleado: '$empleado', periodo: '$periodo' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (boletasDuplicadas.length) {
    anotar('GRAVE', `${boletasDuplicadas.length} empleado(es) tienen más de una boleta en el mismo período`,
      'Se estaría pagando dos veces el mismo mes');
  }

  // ─── Descansos superpuestos de una misma persona ───
  // Dos vacaciones autorizadas que se cruzan descuentan dos veces el saldo y
  // duplican la ausencia en el cronograma. Un paso de datos que no reconocía su
  // propio registro llegó a crear tres copias de la misma vacación.
  const vigentes = await Vacacion.find({ estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL', 'APROBADO', 'EN_CURSO', 'COMPLETADO'] } })
    .select('empleado fechaInicio fechaFin').sort({ empleado: 1, fechaInicio: 1 }).lean();
  const cruzados = new Set();
  for (let i = 1; i < vigentes.length; i++) {
    const a = vigentes[i - 1];
    const b = vigentes[i];
    if (String(a.empleado) === String(b.empleado) && b.fechaInicio <= a.fechaFin) cruzados.add(String(b.empleado));
  }
  if (cruzados.size) {
    anotar('GRAVE', `${cruzados.size} empleado(es) con descansos que se superponen`,
      'Se descontaría dos veces el saldo vacacional');
  }

  // ─── Días trabajados que ninguna boleta cubre ───
  const { diasSinLiquidar } = require('../src/services/periodo');
  const periodos = (await Boleta.distinct('periodo')).sort().slice(-6);
  for (const periodo of periodos) {
    const r = await diasSinLiquidar(periodo);
    if (r.casos?.length) {
      anotar('GRAVE', `${r.casos.length} empleado(es) con días de ${periodo} sin liquidar`,
        r.casos.slice(0, 3).map((c) => `${c.nombre} (${c.totalDias} día(s))`).join(', '));
    }
  }

  // ─── DIGEMID ───
  const boticas = await Local.find({ tipo: 'BOTICA', activo: { $ne: false } })
    .select('nombre directorTecnico').lean();
  const sinDT = boticas.filter((l) => !l.directorTecnico);
  if (sinDT.length) {
    anotar('AVISO', `${sinDT.length} botica(s) sin Director Técnico designado`,
      sinDT.slice(0, 3).map((l) => l.nombre).join(', '));
  }

  const dtInexistente = boticas.filter((l) => colgante(l.directorTecnico, idsEmpleado));
  if (dtInexistente.length) {
    anotar('GRAVE', `${dtInexistente.length} botica(s) designan a un Director Técnico que ya no existe`,
      dtInexistente.map((l) => l.nombre).join(', '));
  }

  await mongoose.disconnect();
}

revisar()
  .then(() => {
    const graves = problemas.filter((p) => p.gravedad === 'GRAVE');
    const avisos = problemas.filter((p) => p.gravedad === 'AVISO');

    console.log('\nREVISIÓN DE COHERENCIA\n');
    if (!problemas.length) {
      console.log('  Sin incoherencias: las referencias, las cuentas y los contratos cuadran.\n');
      return process.exit(0);
    }

    for (const p of [...graves, ...avisos]) {
      console.log(`  ${p.gravedad === 'GRAVE' ? '✗' : '·'} ${p.asunto}`);
      if (p.detalle) console.log(`      ${p.detalle}`);
    }
    console.log(`\n  ${graves.length} problema(s) grave(s), ${avisos.length} aviso(s)\n`);
    // Sólo lo grave hace fallar: sirve para encadenarlo a un despliegue
    process.exit(graves.length ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nNo se pudo revisar:', err.message, '\n');
    process.exit(2);
  });
