const Boleta = require('../models/Boleta');
const Planilla = require('../models/Planilla');

/**
 * Pone la planilla del mes al día con sus boletas.
 *
 * La planilla mensual sólo la escribían los scripts de datos: calcular,
 * aprobar o pagar desde la pantalla cambiaba las boletas, pero la planilla se
 * quedaba en BORRADOR con totales en cero. Su estado sale del de las boletas:
 *
 *   todas pagadas                → PAGADA
 *   todas aprobadas o pagadas    → APROBADA
 *   alguna calculada             → CALCULADA
 *
 * Una planilla CERRADA no se toca: el cierre es posterior al pago y lo
 * decide RRHH, no el estado de las boletas.
 *
 * @param {string} periodo  AAAA-MM
 * @param {object} [quien]  usuario que hizo el cambio
 * @returns {Promise<object|null>} la planilla, o null si el período no tiene boletas
 */
async function sincronizarPlanilla(periodo, quien) {
  const [t] = await Boleta.aggregate([
    { $match: { periodo, estado: { $ne: 'BORRADOR' } } },
    { $group: {
      _id: null,
      n: { $sum: 1 },
      pagadas: { $sum: { $cond: [{ $eq: ['$estado', 'PAGADO'] }, 1, 0] } },
      aprobadas: { $sum: { $cond: [{ $eq: ['$estado', 'APROBADO'] }, 1, 0] } },
      ingresos: { $sum: '$ingresos.total' },
      descuentos: { $sum: '$descuentos.total' },
      neto: { $sum: '$netoAPagar' },
      costo: { $sum: '$costoEmpresa' },
      ultimoPago: { $max: '$pagadoEn' },
    } },
  ]);
  if (!t) return null;

  const r2 = (n) => Math.round((n || 0) * 100) / 100;
  const estado = t.pagadas === t.n ? 'PAGADA'
    : t.pagadas + t.aprobadas === t.n ? 'APROBADA'
      : 'CALCULADA';

  let planilla = await Planilla.findOne({ periodo });
  if (planilla?.estado === 'CERRADA') return planilla;
  if (!planilla) {
    // Un período calculado por primera vez desde la pantalla: hereda el
    // presupuesto del mes anterior, que es lo que se habría aprobado
    const [anio, mes] = periodo.split('-').map(Number);
    const anterior = await Planilla.findOne({ periodo: { $lt: periodo } }).sort({ periodo: -1 }).select('presupuesto').lean();
    planilla = new Planilla({ periodo, anio, mes, presupuesto: anterior?.presupuesto || 0 });
  }

  const antes = planilla.estado;
  Object.assign(planilla, {
    estado,
    empleadosIncluidos: t.n,
    totalIngresos: r2(t.ingresos),
    totalDescuentos: r2(t.descuentos),
    totalNeto: r2(t.neto),
    costoEmpresa: r2(t.costo),
  });
  const ahora = new Date();
  if (estado === 'CALCULADA' && antes !== 'CALCULADA') { planilla.calculadaEn = ahora; planilla.calculadaPor = quien?._id; }
  if (['APROBADA', 'PAGADA'].includes(estado) && !planilla.aprobadaEn) { planilla.aprobadaEn = ahora; planilla.aprobadaPor = quien?._id; }
  if (estado === 'PAGADA' && !planilla.pagadaEn) planilla.pagadaEn = t.ultimoPago || ahora;
  await planilla.save();
  return planilla;
}

module.exports = { sincronizarPlanilla };
