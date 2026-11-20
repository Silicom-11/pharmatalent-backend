const Boleta = require('../models/Boleta');
const Asistencia = require('../models/Asistencia');
const Empleado = require('../models/Empleado');
const { aFechaLocal, comoTexto, inicioDelDia, finDelDia } = require('../utils/fechas');

/**
 * Cierre de un período de planilla y lo que se queda fuera.
 *
 * Una boleta consolida lo que el mes dejó registrado. Una vez pagada, el
 * recálculo del período queda bloqueado —y con razón: el documento ya se
 * entregó al trabajador y se declaró a SUNAT.
 *
 * Eso deja una rendija estrecha pero silenciosa. Si la planilla de agosto se
 * paga el 29 y alguien trabaja el 30 y el 31, esos días existen en el registro
 * de asistencia y no los cubre ninguna boleta. Nadie se entera hasta que la
 * persona reclama.
 *
 * Aquí no se bloquea la marca: el trabajador trabajó y el registro tiene que
 * existir. Lo que se hace es encontrar esos días para que se paguen como
 * reintegro en el período siguiente, que es como se corrige sin reescribir el
 * pasado.
 */

/** «2026-08» a partir de cualquier fecha */
function periodoDe(fecha) {
  const f = aFechaLocal(fecha) || new Date();
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`;
}

/** Primer y último instante del período, en hora local */
function limitesDelPeriodo(periodo) {
  const [a, m] = String(periodo).split('-').map(Number);
  return {
    desde: inicioDelDia(new Date(a, m - 1, 1)),
    hasta: finDelDia(new Date(a, m, 0)),   // día 0 del mes siguiente = último del actual
  };
}

/**
 * ¿El período ya se pagó?
 * Devuelve null si sigue abierto, o el detalle del cierre si no.
 */
async function cierreDelPeriodo(fechaOPeriodo) {
  const periodo = /^\d{4}-\d{2}$/.test(String(fechaOPeriodo))
    ? String(fechaOPeriodo)
    : periodoDe(fechaOPeriodo);

  // Basta una boleta pagada: parte del período ya salió
  const primera = await Boleta.findOne({ periodo: periodo, estado: 'PAGADO' })
    .select('pagadoEn').sort({ pagadoEn: 1 }).lean();
  if (!primera) return null;

  const [total, pagadas] = await Promise.all([
    Boleta.countDocuments({ periodo: periodo }),
    Boleta.countDocuments({ periodo: periodo, estado: 'PAGADO' }),
  ]);

  return {
    periodo,
    pagadoDesde: primera.pagadoEn,
    boletasPagadas: pagadas,
    boletasDelPeriodo: total,
    completo: pagadas === total,
  };
}

/**
 * Días trabajados que ninguna boleta cubre.
 *
 * Busca marcas de asistencia posteriores al pago de su propio período: son las
 * que se quedaron fuera de la liquidación y hay que reintegrar.
 */
async function diasSinLiquidar(periodo) {
  const cierre = await cierreDelPeriodo(periodo);
  if (!cierre) return { periodo, cerrado: false, casos: [] };

  const { desde, hasta } = limitesDelPeriodo(cierre.periodo);
  const pagadoDesde = new Date(cierre.pagadoDesde);

  // Marcas del período registradas después de que la planilla se pagara
  const posteriores = await Asistencia.find({
    fecha: { $gte: desde, $lte: hasta },
    creadoEn: { $gt: pagadoDesde },
    estado: { $ne: 'AUSENTE' },
  })
    .select('empleado fecha horasTrabajadas horasExtra estado')
    .lean();

  if (!posteriores.length) {
    return { periodo: cierre.periodo, cerrado: true, cierre, casos: [] };
  }

  // Se agrupa por persona: lo que interesa es a quién hay que reintegrar
  const porPersona = new Map();
  for (const m of posteriores) {
    const clave = String(m.empleado);
    if (!porPersona.has(clave)) porPersona.set(clave, { empleado: m.empleado, dias: [], horas: 0, horasExtra: 0 });
    const c = porPersona.get(clave);
    c.dias.push(comoTexto(m.fecha));
    c.horas += m.horasTrabajadas || 0;
    c.horasExtra += m.horasExtra || 0;
  }

  const personas = await Empleado.find({ _id: { $in: [...porPersona.keys()] } })
    .select('nombres apellidos dni').lean();
  const nombres = new Map(personas.map((p) => [String(p._id), p]));

  const casos = [...porPersona.values()].map((c) => {
    const p = nombres.get(String(c.empleado));
    return {
      empleado: c.empleado,
      nombre: p ? `${p.nombres} ${p.apellidos}` : 'Empleado no encontrado',
      dni: p?.dni,
      dias: c.dias.sort(),
      totalDias: c.dias.length,
      horas: Math.round(c.horas * 100) / 100,
      horasExtra: Math.round(c.horasExtra * 100) / 100,
    };
  }).sort((a, b) => b.totalDias - a.totalDias);

  return {
    periodo: cierre.periodo,
    cerrado: true,
    cierre,
    casos,
    aviso: `${casos.length} empleado(es) registraron días de ${cierre.periodo} después de que `
      + `la planilla se pagara el ${comoTexto(cierre.pagadoDesde)}. Esos días no están liquidados: `
      + 'corresponden a un reintegro en el período en curso.',
  };
}

module.exports = { periodoDe, limitesDelPeriodo, cierreDelPeriodo, diasSinLiquidar };
