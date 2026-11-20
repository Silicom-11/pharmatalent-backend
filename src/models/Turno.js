const mongoose = require('mongoose');
const { SHIFT_ROLE_CODES } = require('../config/formats');

const esquemaAsignacion = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  rol: { type: String, enum: SHIFT_ROLE_CODES, required: true },
  /** El empleado cubre un puesto distinto al suyo (sustitución permitida por el formato) */
  esSustituto: { type: Boolean, default: false },
}, { _id: false });

/** Cobertura de un puesto concreto dentro del turno */
const esquemaCoberturaPuesto = new mongoose.Schema({
  rol: { type: String, required: true },
  etiqueta: String,
  requerido: { type: Number, default: 0 },
  asignados: { type: Number, default: 0 },
  sustituidos: { type: Number, default: 0 },
  brecha: { type: Number, default: 0 },
  cubierto: { type: Boolean, default: false },
  legal: { type: Boolean, default: false },
}, { _id: false });

const esquemaConflicto = new mongoose.Schema({
  rol: String,
  severidad: { type: String, enum: ['CRITICA', 'MAYOR', 'MENOR'] },
  hallazgo: String,
}, { _id: false });

const esquemaTurno = new mongoose.Schema({
  horario: { type: mongoose.Schema.Types.ObjectId, ref: 'Horario', required: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  fecha: { type: Date, required: true },
  tipoTurno: {
    type: String,
    enum: ['MANANA', 'TARDE', 'NOCHE'],
    required: true,
  },
  horaInicio: { type: String, required: true },
  horaFin: { type: String, required: true },
  asignaciones: [esquemaAsignacion],

  // ─── Cobertura evaluada contra el formato del local ───
  cobertura: {
    roles: [esquemaCoberturaPuesto],
    porcentajeCobertura: { type: Number, default: 0 },
    sustitucionesUsadas: { type: Number, default: 0 },
    severidad: { type: String, enum: ['CRITICA', 'MAYOR', 'MENOR', null], default: null },
  },
  conflictos: [esquemaConflicto],
  cumpleNormativa: { type: Boolean, default: false },

  // Indicadores heredados — el QF es la única exigencia legal por turno
  tieneQF: { type: Boolean, default: false },
  conteoQF: { type: Number, default: 0 },

  estado: {
    type: String,
    enum: ['PROGRAMADO', 'EN_CURSO', 'COMPLETADO', 'CANCELADO'],
    default: 'PROGRAMADO',
  },
}, {
  collection: 'turnos',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/**
 * Presencia de Químico Farmacéutico en un turno. Un QF Asistente también la
 * satisface.
 *
 * Se exporta porque la generación semanal inserta los turnos en lote, y
 * `insertMany` no ejecuta el hook de guardado: todos los turnos generados
 * quedaban con tieneQF = false y el panel avisaba de decenas de turnos «sin QF»
 * que sí lo tenían.
 */
function presenciaQF(asignaciones = []) {
  const conteoQF = asignaciones.filter((a) => ['QF', 'QF_ASISTENTE'].includes(a.rol)).length;
  return { conteoQF, tieneQF: conteoQF > 0 };
}

esquemaTurno.pre('save', function () {
  Object.assign(this, presenciaQF(this.asignaciones));
});

/** Dotación total asignada al turno */
esquemaTurno.virtual('conteoDotacion').get(function () {
  return this.asignaciones?.length || 0;
});

esquemaTurno.index({ horario: 1, fecha: 1 });
esquemaTurno.index({ local: 1, fecha: 1, tipoTurno: 1 });
esquemaTurno.index({ 'asignaciones.empleado': 1, fecha: 1 });
esquemaTurno.index({ cumpleNormativa: 1, fecha: 1 });

module.exports = mongoose.model('Turno', esquemaTurno);
module.exports.presenciaQF = presenciaQF;
