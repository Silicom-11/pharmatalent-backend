const Asistencia = require('../models/Asistencia');
const Vacacion = require('../models/Vacacion');
const DescansoMedico = require('../models/DescansoMedico');
const Contrato = require('../models/Contrato');
const P = require('../config/payrollParams');
const { shiftRoleOf } = require('./staffing');

/**
 * Motor de planilla — Perú.
 *
 * Consolida en una boleta lo que el mes dejó registrado: asistencia marcada,
 * horas extra, tardanzas, descansos médicos con su reparto entre empleador y
 * EsSalud, y vacaciones gozadas. Sobre esa base aplica los descuentos de ley
 * y separa lo que aporta el empleador, que nunca se descuenta al trabajador.
 */

const redondear = (n) => Math.round((n || 0) * 100) / 100;
const DIA = 86400000;

/** Primer y último instante de un período 'YYYY-MM' */
function rangoDelPeriodo(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  return { desde: new Date(y, m - 1, 1), hasta: new Date(y, m, 0, 23, 59, 59, 999), year: y, month: m };
}

/** Días de un rango de ausencia que caen dentro del período */
function diasEnPeriodo(inicio, fin, desde, hasta) {
  const a = new Date(Math.max(new Date(inicio), desde));
  const b = new Date(Math.min(new Date(fin), hasta));
  if (b < a) return 0;
  return Math.floor((b - a) / DIA) + 1;
}

/**
 * Impuesto a la renta de quinta categoría, prorrateado al mes.
 *
 * Se proyecta el ingreso anual (remuneración por los meses que restan más las
 * gratificaciones del ejercicio), se deducen 7 UIT y se aplica la escala.
 */
/**
 * Impuesto anual sobre una base imponible, recorriendo la escala progresiva.
 * Se extrae aparte porque la liquidación por cese necesita el mismo recorrido
 * sobre una base distinta, y dos implementaciones del mismo tramo acaban
 * divergiendo.
 */
function impuestoSobreBase(baseImponible, uit = P.UIT) {
  const { tramos } = P.RENTA_QUINTA;
  if (baseImponible <= 0) return 0;

  let impuesto = 0;
  let restante = baseImponible;
  let limiteAnterior = 0;
  for (const tramo of tramos) {
    const limite = tramo.hastaUIT === Infinity ? Infinity : tramo.hastaUIT * uit;
    const gravado = Math.min(restante, limite - limiteAnterior);
    if (gravado <= 0) break;
    impuesto += gravado * tramo.tasa;
    restante -= gravado;
    limiteAnterior = limite;
    if (restante <= 0) break;
  }
  return impuesto;
}

function rentaQuintaMensual(remuneracionMensual, mes, uit = P.UIT) {
  const { deduccionUIT, gratificacionesAlAnio } = P.RENTA_QUINTA;
  const mesesRestantes = 12 - mes + 1;

  // Proyección: lo ya percibido más lo que resta del año, con gratificaciones
  const proyeccionAnual = remuneracionMensual * 12 + remuneracionMensual * gratificacionesAlAnio;
  const baseImponible = proyeccionAnual - deduccionUIT * uit;
  if (baseImponible <= 0) return { anual: 0, mensual: 0, baseImponible: 0, proyeccionAnual };

  const impuesto = impuestoSobreBase(baseImponible, uit);

  return {
    anual: redondear(impuesto),
    mensual: redondear(impuesto / Math.max(1, mesesRestantes)),
    baseImponible: redondear(baseImponible),
    proyeccionAnual: redondear(proyeccionAnual),
  };
}

/** Reparte las horas extra entre los dos tramos de recargo */
function calcularHorasExtra(horas, sueldoMensual) {
  const { primerTramoHoras, recargoPrimerTramo, recargoSegundoTramo } = P.HORAS_EXTRA;
  const hora = P.valorHora(sueldoMensual);

  const tramo1 = Math.min(horas, primerTramoHoras);
  const tramo2 = Math.max(0, horas - primerTramoHoras);

  const monto1 = tramo1 * hora * (1 + recargoPrimerTramo);
  const monto2 = tramo2 * hora * (1 + recargoSegundoTramo);

  return {
    horas: redondear(horas),
    horasAl25: redondear(tramo1),
    horasAl35: redondear(tramo2),
    valorHora: redondear(hora),
    monto: redondear(monto1 + monto2),
  };
}

/** Descuento previsional del trabajador */
function calcularPension(remuneracionAfecta, sistema) {
  const cfg = P.PENSIONES[sistema] || P.PENSIONES.ONP;
  const baseSeguro = Math.min(remuneracionAfecta, P.TOPE_PRIMA_SEGURO);

  const aporte = remuneracionAfecta * cfg.aporte;
  const comision = remuneracionAfecta * cfg.comision;
  const prima = baseSeguro * cfg.primaSeguro;

  return {
    sistema,
    etiqueta: cfg.etiqueta,
    aporte: redondear(aporte),
    comision: redondear(comision),
    primaSeguro: redondear(prima),
    total: redondear(aporte + comision + prima),
  };
}

/**
 * Boleta de un empleado para un período.
 *
 * @param {Object} employee  documento de Employee (con currentPosition poblado si se puede)
 * @param {String} period    'YYYY-MM'
 */
async function computePayroll(empleado, periodo) {
  const { desde, hasta, month, year } = rangoDelPeriodo(periodo);
  const diasMes = P.JORNADA.diasMes;
  // La RMV y la UIT del período, no las de hoy (MNT-2026-014)
  const rmv = P.rmvVigente(hasta);
  const uit = P.uitDe(year);

  // El sueldo vigente sale del contrato del período; si no hay, del maestro
  const contrato = await Contrato.findOne({
    empleado: empleado._id,
    fechaInicio: { $lte: hasta },
    $or: [{ fechaFin: null }, { fechaFin: { $gte: desde } }],
  }).sort({ fechaInicio: -1 });
  const sueldoBase = contrato?.sueldo || empleado.sueldoBasico || 0;

  // ── Lo que el mes dejó registrado ──
  const [marcas, ausencias, descansos] = await Promise.all([
    Asistencia.find({ empleado: empleado._id, fecha: { $gte: desde, $lte: hasta } })
      .select('estado horasTrabajadas horasExtra minutosTardanza'),
    Vacacion.find({
      empleado: empleado._id,
      estado: { $in: ['APROBADO', 'EN_CURSO', 'COMPLETADO'] },
      fechaInicio: { $lte: hasta }, fechaFin: { $gte: desde },
    }).select('tipo fechaInicio fechaFin'),
    DescansoMedico.find({
      empleado: empleado._id,
      estado: { $in: ['VALIDADO', 'CERRADO'] },
      fechaInicio: { $lte: hasta }, fechaFin: { $gte: desde },
    }).select('fechaInicio fechaFin subsidio diasTotales'),
  ]);

  const presentes = marcas.filter((m) => ['PRESENTE', 'TARDANZA'].includes(m.estado)).length;
  const faltas = marcas.filter((m) => m.estado === 'AUSENTE').length;
  const horasExtraMes = marcas.reduce((a, m) => a + (m.horasExtra || 0), 0);
  const minutosTardanza = marcas.reduce((a, m) => a + (m.minutosTardanza || 0), 0);

  const diasVacaciones = ausencias
    .filter((v) => v.tipo === 'VACACIONES')
    .reduce((a, v) => a + diasEnPeriodo(v.fechaInicio, v.fechaFin, desde, hasta), 0);
  const diasPermiso = ausencias
    .filter((v) => v.tipo === 'LICENCIA_SIN_GOCE')
    .reduce((a, v) => a + diasEnPeriodo(v.fechaInicio, v.fechaFin, desde, hasta), 0);

  // Descanso médico: se separa lo que asume el empleador de lo que subsidia EsSalud
  let diasDescansoEmpleador = 0;
  let diasDescansoSubsidiado = 0;
  for (const d of descansos) {
    const enPeriodo = diasEnPeriodo(d.fechaInicio, d.fechaFin, desde, hasta);
    if (!enPeriodo) continue;
    const proporcion = enPeriodo / (d.diasTotales || enPeriodo);
    diasDescansoEmpleador += Math.round((d.subsidio?.diasEmpleador || 0) * proporcion);
    diasDescansoSubsidiado += Math.round((d.subsidio?.diasEssalud || 0) * proporcion);
  }

  // Quien ingresó a mitad de mes cobra desde su ingreso, no el mes completo
  const ingreso = empleado.fechaIngreso ? new Date(empleado.fechaIngreso) : null;
  const diasAntesDelIngreso = !ingreso || ingreso <= desde ? 0
    : ingreso > hasta ? diasMes
      : Math.min(diasMes, ingreso.getDate() - 1);

  // Días efectivamente remunerados: el descanso médico a cargo del empleador
  // y las vacaciones se pagan; la licencia sin goce y las faltas, no.
  // Los días que subsidia EsSalud tampoco son remuneración: se pagan como
  // subsidio, aparte. Antes quedaban también dentro del básico y esos días
  // se cobraban dos veces.
  const diasNoRemunerados = Math.min(diasMes, faltas + diasPermiso + diasDescansoSubsidiado + diasAntesDelIngreso);
  const diasRemunerados = Math.max(0, diasMes - diasNoRemunerados);

  // ── Ingresos ──
  const basico = redondear(P.valorDia(sueldoBase) * diasRemunerados);

  const asignacionFamiliar = empleado.tieneHijos
    ? redondear(rmv * P.ASIGNACION_FAMILIAR.porcentajeRMV)
    : 0;

  const extras = calcularHorasExtra(horasExtraMes, sueldoBase);

  // El subsidio lo adelanta el empleador y luego lo recupera de EsSalud
  const subsidioEsSalud = redondear(P.valorDia(sueldoBase) * diasDescansoSubsidiado);

  const totalIngresos = redondear(basico + asignacionFamiliar + extras.monto + subsidioEsSalud);

  // ── Descuentos del trabajador ──
  // El subsidio de EsSalud no es remuneración: no está afecto a pensión ni renta.
  const remuneracionAfecta = redondear(basico + asignacionFamiliar + extras.monto);

  const sistema = empleado.sistemaPensiones || 'ONP';
  const pension = calcularPension(remuneracionAfecta, sistema);

  const renta = rentaQuintaMensual(sueldoBase + asignacionFamiliar, month, uit);

  // Tardanza: se descuenta el tiempo no laborado por encima de la tolerancia mensual
  const minutosDescontables = Math.max(0, minutosTardanza - P.TARDANZA.descuentaDesdeMinutosMes);
  const descuentoTardanza = redondear((minutosDescontables / 60) * P.valorHora(sueldoBase));

  const totalDescuentos = redondear(pension.total + renta.mensual + descuentoTardanza);

  // ── Aportes del empleador (fuera del neto del trabajador) ──
  const baseEsSalud = Math.max(remuneracionAfecta, rmv);
  const esSalud = redondear(baseEsSalud * P.APORTES_EMPLEADOR.esSalud);

  const cargo = shiftRoleOf(empleado);
  const enRiesgo = P.PUESTOS_RIESGO.includes(cargo);
  const sctr = enRiesgo
    ? redondear(remuneracionAfecta * (P.APORTES_EMPLEADOR.sctrSalud + P.APORTES_EMPLEADOR.sctrPension))
    : 0;

  // ── Conceptos del período ──
  const esMesGratificacion = P.GRATIFICACIONES.meses.includes(month);
  const gratificacion = esMesGratificacion
    ? (() => {
        const monto = sueldoBase + asignacionFamiliar;
        const bonif = monto * P.GRATIFICACIONES.bonificacionExtraordinaria;
        return { aplica: true, monto: redondear(monto), bonificacionExtraordinaria: redondear(bonif), total: redondear(monto + bonif) };
      })()
    : { aplica: false, monto: 0, bonificacionExtraordinaria: 0, total: 0 };

  const esMesCts = P.CTS.meses.includes(month);
  const cts = esMesCts
    ? (() => {
        const base = sueldoBase + asignacionFamiliar + (sueldoBase * P.CTS.sextoGratificacion);
        return { aplica: true, base: redondear(base), monto: redondear(base / 2) };
      })()
    : { aplica: false, base: 0, monto: 0 };

  const netoAPagar = redondear(totalIngresos - totalDescuentos);

  return {
    empleado: empleado._id,
    periodo,
    sueldoBasico: sueldoBase,

    dias: {
      calendario: diasMes,
      remunerados: diasRemunerados,
      marcados: presentes,
      faltas,
      vacaciones: diasVacaciones,
      licenciaSinGoce: diasPermiso,
      antesDelIngreso: diasAntesDelIngreso,
      descansoMedicoEmpleador: diasDescansoEmpleador,
      descansoMedicoSubsidiado: diasDescansoSubsidiado,
    },

    ingresos: {
      basico,
      asignacionFamiliar,
      horasExtra: extras,
      subsidioEsSalud,
      bonificaciones: 0,
      total: totalIngresos,
    },

    descuentos: {
      pension,
      rentaQuinta: { monto: renta.mensual, baseImponible: renta.baseImponible, proyeccionAnual: renta.proyeccionAnual },
      tardanza: { minutos: minutosTardanza, minutosDescontados: minutosDescontables, monto: descuentoTardanza },
      otros: 0,
      total: totalDescuentos,
    },

    aportesEmpleador: {
      esSalud,
      sctr,
      enRiesgo,
      total: redondear(esSalud + sctr),
    },

    gratificacion,
    cts,

    remuneracionAfecta,
    netoAPagar,
    costoEmpresa: redondear(totalIngresos + esSalud + sctr + gratificacion.total + cts.monto),

    // Campos que conserva el modelo anterior
    diasTrabajados: diasRemunerados,
    horasExtra: extras.horas,
    pagoHorasExtra: extras.monto,
    bonos: 0,
    descuentosSimples: {
      afp: pension.total,
      salud: 0,               // EsSalud es aporte del empleador, no descuento
      impuestos: renta.mensual,
      otro: descuentoTardanza,
    },
  };
}

module.exports = {
  impuestoSobreBase, computePayroll, rentaQuintaMensual, calcularHorasExtra, calcularPension, rangoDelPeriodo };
