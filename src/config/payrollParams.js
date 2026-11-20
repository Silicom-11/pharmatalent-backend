/**
 * Parámetros legales de planilla — Perú.
 *
 * Se agrupan aquí porque cambian por norma (no por código): la Remuneración
 * Mínima Vital, la UIT y las tasas de AFP se actualizan periódicamente y deben
 * poder ajustarse sin tocar el motor de cálculo.
 *
 * Referencias: D.S. 003-97-TR (LPCL), D.Leg. 713 (descansos), D.Leg. 650 (CTS),
 * Ley 27735 (gratificaciones), D.Leg. 892 (utilidades), TUO del Impuesto a la Renta.
 */

// ─── Valores de referencia, con su vigencia ──────────────────────────────────
/**
 * Mantenimiento adaptativo MNT-2026-014 (13/11/2026).
 *
 * Antes la RMV y la UIT eran dos constantes (1130 y 5350). El 01/10/2026 la
 * RMV subió a S/ 1,230 y la UIT de 2026 ya era S/ 5,500: el sistema seguía
 * calculando con los valores viejos y aceptaba sueldos bajo el mínimo legal.
 * Ahora cada valor lleva la norma que lo fija y desde cuándo rige; cada
 * cálculo usa el que regía en su fecha (la planilla de setiembre con 1130, la
 * de octubre con 1230). Cuando salga otra norma se agrega una fila, sin tocar
 * el motor.
 */
const VIGENCIAS_RMV = [
  { desde: '2022-05-01', valor: 1025, norma: 'D.S. 003-2022-TR' },
  { desde: '2025-01-01', valor: 1130, norma: 'D.S. 006-2024-TR' },
  { desde: '2026-10-01', valor: 1230, norma: 'D.S. 015-2026-TR' },
];
const VIGENCIAS_UIT = [
  { anio: 2024, valor: 5150, norma: 'D.S. 309-2023-EF' },
  { anio: 2025, valor: 5350, norma: 'D.S. 260-2024-EF' },
  { anio: 2026, valor: 5500, norma: 'D.S. 301-2025-EF' },
];

const aFecha = (f) => (f instanceof Date ? f : new Date(f ?? Date.now()));
const fechaLocal = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

/** La RMV que regía en una fecha, con su norma */
function rmvVigenteDetalle(fecha = new Date()) {
  const f = aFecha(fecha);
  const vigente = [...VIGENCIAS_RMV].reverse().find((v) => fechaLocal(v.desde) <= f) || VIGENCIAS_RMV[0];
  return vigente;
}
const rmvVigente = (fecha) => rmvVigenteDetalle(fecha).valor;

/**
 * La UIT de un ejercicio. Si el año aún no tiene la suya registrada se usa la
 * última conocida y `registrada` lo dice: la rutina preventiva lo avisa.
 */
function uitDetalle(anio = new Date().getFullYear()) {
  const exacta = VIGENCIAS_UIT.find((u) => u.anio === Number(anio));
  if (exacta) return { ...exacta, registrada: true };
  const anterior = [...VIGENCIAS_UIT].reverse().find((u) => u.anio < Number(anio)) || VIGENCIAS_UIT[0];
  return { ...anterior, registrada: false };
}
const uitDe = (anio) => uitDetalle(anio).valor;

/** La RMV que rige al cierre de un período 'YYYY-MM' */
function rmvDelPeriodo(periodo) {
  const [y, m] = String(periodo).split('-').map(Number);
  return rmvVigente(new Date(y, m, 0));
}

// Los valores de hoy, para lo que no depende de un período
const YEAR = new Date().getFullYear();
const RMV = rmvVigente(new Date());   // Remuneración Mínima Vital
const UIT = uitDe(YEAR);              // Unidad Impositiva Tributaria

// ─── Jornada ─────────────────────────────────────────────────────────────────
const JORNADA = {
  horasDiarias: 8,
  horasSemanales: 48,
  diasMes: 30,             // la planilla peruana liquida sobre mes de 30 días
};

// ─── Horas extra (art. 10 D.S. 007-2002-TR) ──────────────────────────────────
// Las dos primeras se pagan con 25% de recargo; a partir de la tercera, 35%.
const HORAS_EXTRA = {
  primerTramoHoras: 2,
  recargoPrimerTramo: 0.25,
  recargoSegundoTramo: 0.35,
};

// ─── Asignación familiar (Ley 25129) ─────────────────────────────────────────
// 10% de la RMV para quien tiene hijos menores de 18 años, o hasta 24 si cursan
// estudios superiores. Es un monto fijo, no proporcional al número de hijos.
const ASIGNACION_FAMILIAR = { porcentajeRMV: 0.10 };

// ─── Sistemas previsionales (descuento al trabajador) ────────────────────────
const PENSIONES = {
  ONP: {
    etiqueta: 'ONP — Sistema Nacional de Pensiones',
    aporte: 0.13,
    comision: 0,
    primaSeguro: 0,
  },
  AFP_INTEGRA:   { etiqueta: 'AFP Integra',   aporte: 0.10, comision: 0.0155, primaSeguro: 0.0174 },
  AFP_PRIMA:     { etiqueta: 'AFP Prima',     aporte: 0.10, comision: 0.0160, primaSeguro: 0.0174 },
  AFP_PROFUTURO: { etiqueta: 'AFP Profuturo', aporte: 0.10, comision: 0.0169, primaSeguro: 0.0174 },
  AFP_HABITAT:   { etiqueta: 'AFP Habitat',   aporte: 0.10, comision: 0.0147, primaSeguro: 0.0174 },
};
// La prima de seguro se calcula sobre una remuneración tope fijada por la SBS
const TOPE_PRIMA_SEGURO = 12570;

// ─── Aportes del empleador (no se descuentan al trabajador) ──────────────────
const APORTES_EMPLEADOR = {
  esSalud: 0.09,           // base mínima: la RMV
  sctrSalud: 0.0130,       // sólo actividades de riesgo (almacén, reparto)
  sctrPension: 0.0163,
};

// ─── Impuesto a la renta de quinta categoría ─────────────────────────────────
// Se proyecta el ingreso anual, se deducen 7 UIT y se aplica la escala.
const RENTA_QUINTA = {
  deduccionUIT: 7,
  tramos: [
    { hastaUIT: 5,        tasa: 0.08 },
    { hastaUIT: 20,       tasa: 0.14 },
    { hastaUIT: 35,       tasa: 0.17 },
    { hastaUIT: 45,       tasa: 0.20 },
    { hastaUIT: Infinity, tasa: 0.30 },
  ],
  gratificacionesAlAnio: 2,
};

// ─── Gratificaciones (Ley 27735) ─────────────────────────────────────────────
// Julio y diciembre, una remuneración completa cada una, más la bonificación
// extraordinaria del 9% que el empleador habría aportado a EsSalud.
const GRATIFICACIONES = {
  meses: [7, 12],
  bonificacionExtraordinaria: 0.09,
  mesesPorPeriodo: 6,
};

// ─── Compensación por Tiempo de Servicios (D.Leg. 650) ───────────────────────
// Depósitos en mayo y noviembre. La base incluye un sexto de la gratificación.
const CTS = {
  meses: [5, 11],
  mesesPorPeriodo: 6,
  sextoGratificacion: 1 / 6,
};

// ─── Descanso médico (EsSalud) ───────────────────────────────────────────────
const SUBSIDIO = {
  diasACargoEmpleador: 20,   // los primeros 20 días del año los asume la empresa
  plazoCanjeMeses: 6,
};

// ─── Descuento por tardanza ──────────────────────────────────────────────────
// El descuento procede sobre el tiempo no laborado; se aplica una tolerancia
// diaria acumulable antes de descontar.
const TARDANZA = {
  toleranciaMinutosDia: 5,
  descuentaDesdeMinutosMes: 30,
};

/** Puestos considerados de riesgo para el SCTR */
const PUESTOS_RIESGO = ['AUX_ALMACEN', 'MOTORIZADO', 'OPERARIO_CEDI', 'PREVENCIONISTA'];

/** Valor diario y por hora de una remuneración mensual */
const valorDia = (sueldoMensual) => sueldoMensual / JORNADA.diasMes;
const valorHora = (sueldoMensual) => valorDia(sueldoMensual) / JORNADA.horasDiarias;

module.exports = {
  YEAR, RMV, UIT, VIGENCIAS_RMV, VIGENCIAS_UIT,
  rmvVigente, rmvVigenteDetalle, rmvDelPeriodo, uitDe, uitDetalle,
  JORNADA, HORAS_EXTRA, ASIGNACION_FAMILIAR,
  PENSIONES, TOPE_PRIMA_SEGURO, APORTES_EMPLEADOR, RENTA_QUINTA,
  GRATIFICACIONES, CTS, SUBSIDIO, TARDANZA, PUESTOS_RIESGO,
  valorDia, valorHora,
};
