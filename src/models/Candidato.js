const mongoose = require('mongoose');

/**
 * Candidato — embudo de reclutamiento masivo
 * Etapas: POSTULADO → FILTRO_CV → ENTREVISTA → EVALUACION_TECNICA → OFERTA → CONTRATADO
 *         (o DESCARTADO / DESISTIO en cualquier punto)
 */

const ETAPAS = ['POSTULADO', 'FILTRO_CV', 'ENTREVISTA', 'EVALUACION_TECNICA', 'OFERTA', 'CONTRATADO', 'DESCARTADO', 'DESISTIO'];

const esquemaHistorialEtapas = new mongoose.Schema({
  etapa: { type: String, enum: ETAPAS, required: true },
  fecha: { type: Date, default: Date.now },
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  nota: String,
}, { _id: false });

const esquemaCandidato = new mongoose.Schema({
  dni: { type: String, required: true, match: /^\d{8}$/ },
  nombres: { type: String, required: true, trim: true },
  apellidos: { type: String, required: true, trim: true },
  correo: { type: String, lowercase: true, trim: true },
  telefono: String,

  requerimiento: { type: mongoose.Schema.Types.ObjectId, ref: 'Requerimiento', required: true },
  origen: {
    type: String,
    enum: ['BOLSA_UNIVERSITARIA', 'PORTAL_WEB', 'REFERIDO', 'FERIA_LABORAL', 'REDES_SOCIALES', 'BASE_INTERNA'],
    default: 'PORTAL_WEB',
  },

  // Perfil profesional
  tipoProfesional: { type: String, enum: ['QF', 'TECNICO', 'OPERARIO', 'ADMINISTRATIVO'], required: true },
  numeroCQF: String,          // requerido para QF
  tieneCapacitacionDigemid: { type: Boolean, default: false },
  anosExperiencia: { type: Number, default: 0 },
  formacion: String,

  etapa: { type: String, enum: ETAPAS, default: 'POSTULADO' },
  historialEtapas: [esquemaHistorialEtapas],

  puntajeEntrevista: { type: Number, min: 0, max: 100 },
  puntajeTecnico: { type: Number, min: 0, max: 100 },
  sueldoEsperado: Number,
  motivoRechazo: String,
  notas: String,

  contratadoComo: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },
}, {
  collection: 'candidatos',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

esquemaCandidato.virtual('nombreCompleto').get(function () {
  return `${this.nombres} ${this.apellidos}`;
});

/** Puntaje global ponderado (entrevista 40% / técnica 60%) */
esquemaCandidato.virtual('puntajeGlobal').get(function () {
  if (this.puntajeEntrevista == null && this.puntajeTecnico == null) return null;
  const i = this.puntajeEntrevista ?? 0;
  const t = this.puntajeTecnico ?? 0;
  if (this.puntajeTecnico == null) return i;
  if (this.puntajeEntrevista == null) return t;
  return Math.round(i * 0.4 + t * 0.6);
});

esquemaCandidato.virtual('diasEnProceso').get(function () {
  return Math.floor((Date.now() - this.creadoEn) / 86400000);
});

esquemaCandidato.index({ requerimiento: 1, etapa: 1 });
esquemaCandidato.index({ dni: 1 });
esquemaCandidato.index({ etapa: 1, creadoEn: -1 });

module.exports = mongoose.model('Candidato', esquemaCandidato);
module.exports.ETAPAS = ETAPAS;
