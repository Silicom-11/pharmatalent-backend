require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');

/**
 * Cierra los últimos huecos de cobertura que `enriquecer-datos.js` no cubre.
 *
 * Son casos que dependen de datos ya existentes —una liquidación necesita un
 * empleado cesado, un conflicto de horario necesita un cronograma— y por eso
 * van después y no dentro del enriquecimiento general.
 *
 *   node scripts/enriquecer-cierre.js --aplicar
 */

const { Empleado, Usuario, Liquidacion, Horario, Contrato } = require('../src/models');

const aplicar = process.argv.includes('--aplicar');
const HOY = new Date();
const dia = (n) => {
  const f = new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate());
  f.setDate(f.getDate() + n);
  return f;
};

/**
 * Las cuatro causas de cese que faltaban.
 *
 * No son adorno: cada una liquida distinto. El despido justificado no
 * indemniza, la jubilación cierra el vínculo por edad, el fallecimiento paga a
 * los herederos y el cese en período de prueba no genera indemnización ni
 * preaviso. Un examinador que pregunte «¿qué se paga en cada caso?» necesita
 * verlas todas.
 */
const CASOS = [
  { causa: 'DESPIDO_JUSTIFICADO', estado: 'APROBADA', medio: 'DEPOSITO_CUENTA',
    motivo: 'Falta grave acreditada con carta de preaviso y descargo (art. 25 LPCL).' },
  { causa: 'JUBILACION', estado: 'PAGADA', medio: 'EFECTIVO',
    motivo: 'Cese por jubilación a solicitud del trabajador.' },
  { causa: 'FALLECIMIENTO', estado: 'APROBADA', medio: 'CHEQUE',
    motivo: 'Extinción del vínculo por fallecimiento; se paga a los herederos.' },
  { causa: 'PERIODO_PRUEBA', estado: 'BORRADOR', medio: undefined,
    motivo: 'Cese dentro de los tres primeros meses; no genera indemnización.' },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Modo: %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const admin = await Usuario.findOne({ rol: 'ADMIN' }).lean();
  const rrhh = await Usuario.findOne({ rol: 'GERENTE_RRHH' }).lean() || admin;

  // ─── Liquidaciones con las causas que faltaban ──────────────────────────
  const candidatos = await Empleado.find({ estado: 'ACTIVO', dni: { $lt: '80000000' } })
    .sort({ dni: -1 }).limit(CASOS.length * 2).lean();

  let liq = 0;
  for (let i = 0; i < CASOS.length; i++) {
    const c = CASOS[i];
    const yaExiste = await Liquidacion.findOne({ causa: c.causa });
    if (yaExiste) { console.log('  %s ya tiene liquidación', c.causa); continue; }

    const e = candidatos[i];
    if (!e) break;
    const cese = dia(-(6 + i * 4));
    const basico = e.sueldoBasico || 1500;
    const anos = Math.max(1, HOY.getFullYear() - new Date(e.fechaIngreso).getFullYear());
    const enPrueba = c.causa === 'PERIODO_PRUEBA';

    const cts = enPrueba ? 0 : Math.round(basico * 0.5 * anos * 100) / 100;
    const vac = Math.round(basico * (enPrueba ? 0.08 : 0.4) * 100) / 100;
    const grat = enPrueba ? 0 : Math.round(basico * 0.3 * 100) / 100;
    const conceptos = [
      { concepto: 'Vacaciones truncas', monto: vac, base: basico, norma: 'D.Leg. 713',
        afectaPension: true, afectaRenta: true },
    ];
    if (!enPrueba) {
      conceptos.unshift({ concepto: 'Compensación por Tiempo de Servicios', monto: cts,
        base: basico, norma: 'D.Leg. 650', afectaPension: false, afectaRenta: false });
      conceptos.push({ concepto: 'Gratificación trunca', monto: grat, base: basico,
        norma: 'Ley 27735', afectaPension: false, afectaRenta: true });
    }
    const bruto = Math.round(conceptos.reduce((s, x) => s + x.monto, 0) * 100) / 100;

    if (aplicar) {
      await Liquidacion.create({
        empleado: e._id,
        causa: c.causa,
        fechaCese: cese,
        motivoDetallado: c.motivo,
        tiempoDeServicio: enPrueba ? '2 meses' : `${anos} año(s)`,
        mesesDeServicio: enPrueba ? 2 : anos * 12,
        enPeriodoPrueba: enPrueba,
        remuneracionComputable: { basico, asignacionFamiliar: e.tieneHijos ? 113 : 0,
          sextoGratificacion: Math.round(basico / 6), ordinaria: basico, paraCTS: basico },
        conceptos,
        descuentos: [],
        totales: { bruto, descuentos: 0, neto: bruto, afectoPension: vac, afectoRenta: vac + grat },
        parametrosVigentes: { rmv: 1130, uit: 5350, anio: 2026 },
        estado: c.estado,
        calculadaPor: rrhh?._id,
        calculadaEn: dia(-(5 + i * 4)),
        aprobadaPor: c.estado === 'BORRADOR' ? undefined : admin?._id,
        aprobadaEn: c.estado === 'BORRADOR' ? undefined : dia(-(4 + i * 4)),
        pagadaEn: c.estado === 'PAGADA' ? dia(-(3 + i * 4)) : undefined,
        pagadaPor: c.estado === 'PAGADA' ? admin?._id : undefined,
        medioDePago: c.medio,
        referenciaPago: c.medio ? `OP-2026-${6100 + i}` : undefined,
        firmadaPorTrabajador: c.estado === 'PAGADA',
        firmadaEn: c.estado === 'PAGADA' ? dia(-(3 + i * 4)) : undefined,
        observacionTrabajador: c.causa === 'DESPIDO_JUSTIFICADO'
          ? 'Firmo la recepción dejando constancia de mi desacuerdo con la causal.' : undefined,
        avisos: c.causa === 'FALLECIMIENTO'
          ? ['El pago corresponde a los herederos; se requiere sucesión intestada.'] : [],
      });
      await Empleado.updateOne({ _id: e._id }, { $set: { estado: 'CESADO' } });
      await Contrato.updateMany({ empleado: e._id, estado: { $in: ['VIGENTE', 'POR_VENCER'] } },
        { $set: { estado: 'TERMINADO', motivoTermino: c.motivo } });
    }
    liq += 1;
    console.log('  %s  %s  S/ %s  (%s)', c.causa.padEnd(21), c.estado.padEnd(9),
      bruto.toFixed(2).padStart(9), c.medio || 'sin pagar');
  }

  // ─── Un cronograma con conflicto de severidad menor ─────────────────────
  const horario = await Horario.findOne({ 'validacion.conflictos.severidad': { $ne: 'MENOR' } })
    .sort({ inicioSemana: -1 });
  let hor = 0;
  if (horario) {
    const yaTiene = await Horario.countDocuments({ 'validacion.conflictos.severidad': 'MENOR' });
    if (!yaTiene && aplicar) {
      horario.validacion = horario.validacion || {};
      horario.validacion.conflictos = [
        ...(horario.validacion.conflictos || []),
        {
          fecha: dia(-2),
          tipoTurno: 'TARDE',
          rol: 'CAJERO',
          severidad: 'MENOR',
          hallazgo: 'Un cajero menos del recomendado en hora punta; no incumple la norma',
        },
      ];
      horario.validacion.conteoMenores = (horario.validacion.conteoMenores || 0) + 1;
      await horario.save();
      hor = 1;
    }
    console.log('\n  conflicto de severidad MENOR: %s', hor ? 'añadido' : 'ya existía');
  }

  console.log('\n%d liquidación(es) nueva(s)', liq);
  await mongoose.disconnect();
  console.log('%s', aplicar ? 'Aplicado.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
