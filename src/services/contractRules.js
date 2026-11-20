const Contrato = require('../models/Contrato');
const Asistencia = require('../models/Asistencia');
const Evaluacion = require('../models/Evaluacion');

/**
 * Reglas de contratación — Perú (D.S. 003-97-TR, Ley de Productividad y
 * Competitividad Laboral).
 *
 * Los contratos sujetos a modalidad tienen un tope acumulado de cinco años con
 * el mismo empleador. Superado ese plazo —o si el trabajador continúa laborando
 * tras el vencimiento sin renovación— la relación se considera de duración
 * indeterminada, y el despido pasa a requerir causa justa.
 */

const DIA = 86400000;
const ANIO = 365.25 * DIA;

const TOPE_PLAZO_FIJO_ANIOS = 5;
const MODALIDADES_SUJETAS_A_TOPE = ['PLAZO_FIJO', 'PART_TIME'];
const AVISO_PREVIO_DIAS = 30;   // plazo razonable para comunicar la decisión

/** Meses acumulados bajo contrato sujeto a modalidad */
async function tiempoAcumuladoModal(employeeId) {
  const contratos = await Contrato.find({
    empleado: employeeId,
    tipo: { $in: MODALIDADES_SUJETAS_A_TOPE },
  }).select('fechaInicio fechaFin estado');

  let ms = 0;
  const ahora = Date.now();
  for (const c of contratos) {
    const fin = c.fechaFin ? Math.min(new Date(c.fechaFin).getTime(), ahora) : ahora;
    const inicio = new Date(c.fechaInicio).getTime();
    if (fin > inicio) ms += fin - inicio;
  }
  return { anios: ms / ANIO, meses: Math.round(ms / (30 * DIA)) };
}

/**
 * Evalúa si un contrato puede renovarse bajo la misma modalidad y qué
 * consecuencia tiene la decisión.
 */
async function evaluarRenovacion(contrato, nuevaFechaFin = null) {
  const acumulado = await tiempoAcumuladoModal(contrato.empleado._id || contrato.empleado);
  const esModal = MODALIDADES_SUJETAS_A_TOPE.includes(contrato.tipo);

  const inicio = new Date(contrato.fechaInicio);
  const finPropuesto = nuevaFechaFin ? new Date(nuevaFechaFin) : null;
  const aniosTrasRenovar = finPropuesto
    ? acumulado.anios + (finPropuesto - new Date(contrato.fechaFin || Date.now())) / ANIO
    : acumulado.anios;

  const superaTope = esModal && aniosTrasRenovar > TOPE_PLAZO_FIJO_ANIOS;

  const avisos = [];
  if (!esModal) {
    avisos.push('El contrato es de duración indeterminada: no requiere renovación.');
  }
  if (esModal && acumulado.anios >= TOPE_PLAZO_FIJO_ANIOS) {
    avisos.push(
      `El empleado acumula ${acumulado.anios.toFixed(1)} años bajo contrato modal. ` +
      'Superado el tope legal de cinco años, la relación se considera de duración indeterminada.'
    );
  } else if (superaTope) {
    avisos.push(
      `Renovar hasta esa fecha llevaría el acumulado a ${aniosTrasRenovar.toFixed(1)} años y superaría ` +
      'el tope legal de cinco años. Corresponde convertir el contrato a indeterminado.'
    );
  } else if (esModal && aniosTrasRenovar > TOPE_PLAZO_FIJO_ANIOS - 1) {
    avisos.push(
      `Tras esta renovación quedarían ${(TOPE_PLAZO_FIJO_ANIOS - aniosTrasRenovar).toFixed(1)} años ` +
      'antes del tope legal. Conviene planificar el paso a indeterminado.'
    );
  }

  return {
    acumuladoAnios: Math.round(acumulado.anios * 10) / 10,
    acumuladoMeses: acumulado.meses,
    topeAnios: TOPE_PLAZO_FIJO_ANIOS,
    esModal,
    superaTope,
    debeSerIndeterminado: esModal && (acumulado.anios >= TOPE_PLAZO_FIJO_ANIOS || superaTope),
    avisos,
  };
}

/**
 * Antecedentes del empleado que dan sustento a la decisión de renovar:
 * asistencia del último semestre y última evaluación de desempeño.
 */
async function antecedentes(employeeId) {
  const desde = new Date(Date.now() - 180 * DIA);

  const [marcas, evaluacion] = await Promise.all([
    Asistencia.find({ empleado: employeeId, fecha: { $gte: desde } })
      .select('estado minutosTardanza horasTrabajadas horasExtra'),
    Evaluacion.findOne({ empleado: employeeId }).sort({ 'periodo.fechaFin': -1 }),
  ]);

  const conMarca = marcas.filter((m) => ['PRESENTE', 'TARDANZA'].includes(m.estado));
  const tardanzas = marcas.filter((m) => m.estado === 'TARDANZA').length;
  const faltas = marcas.filter((m) => m.estado === 'AUSENTE').length;

  const puntaje = evaluacion?.kpis?.length
    ? Math.round(evaluacion.kpis.reduce((a, k) => a + (k.real * k.peso) / 100, 0))
    : null;

  return {
    marcas: marcas.length,
    puntualidad: conMarca.length ? Math.round(((conMarca.length - tardanzas) / conMarca.length) * 100) : null,
    tardanzas,
    faltas,
    horasExtra: Math.round(marcas.reduce((a, m) => a + (m.horasExtra || 0), 0) * 10) / 10,
    evaluacion: evaluacion ? { periodo: evaluacion.periodo?.nombre, puntaje, estado: evaluacion.estado } : null,
  };
}

/** Días que faltan para el vencimiento y el nivel de urgencia asociado */
function urgencia(contrato) {
  if (!contrato.fechaFin) return { dias: null, nivel: 'SIN_PLAZO' };
  const dias = Math.ceil((new Date(contrato.fechaFin) - Date.now()) / DIA);
  const nivel = dias < 0 ? 'VENCIDO'
    : dias <= 7 ? 'CRITICA'
      : dias <= AVISO_PREVIO_DIAS ? 'ALTA'
        : dias <= 60 ? 'MEDIA' : 'BAJA';
  return { dias, nivel };
}

module.exports = {
  TOPE_PLAZO_FIJO_ANIOS, AVISO_PREVIO_DIAS, MODALIDADES_SUJETAS_A_TOPE,
  tiempoAcumuladoModal, evaluarRenovacion, antecedentes, urgencia,
};
