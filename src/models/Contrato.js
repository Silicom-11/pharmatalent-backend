const mongoose = require('mongoose');

const esquemaRenovacion = new mongoose.Schema({
  fechaFinAnterior: { type: Date, required: true },
  nuevaFechaFin: { type: Date, required: true },
  renovadoEn: { type: Date, default: Date.now },
  aprobadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  notas: String,
}, { _id: false });

const esquemaContrato = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  tipo: {
    type: String,
    enum: ['PLAZO_FIJO', 'INDETERMINADO', 'PRACTICAS', 'PART_TIME'],
    required: true,
  },
  fechaInicio: { type: Date, required: true },
  fechaFin: Date, // null for INDETERMINADO
  cargo: { type: mongoose.Schema.Types.ObjectId, ref: 'Cargo' },
  sueldo: { type: Number, required: true },
  estado: {
    type: String,
    enum: ['VIGENTE', 'POR_VENCER', 'VENCIDO', 'RENOVADO', 'TERMINADO'],
    default: 'VIGENTE',
  },
  historialRenovaciones: [esquemaRenovacion],
  alertasEnviadas: [{
    tipo: { type: String, enum: ['30_DIAS', '15_DIAS', '7_DIAS', 'VENCIDO'] },
    enviadoEn: { type: Date, default: Date.now },
  }],
  /**
   * Decisión de renovación.
   * El local recomienda porque conoce a la persona; Recursos Humanos resuelve.
   */
  decisionRenovacion: {
    recomendacion: { type: String, enum: ['RENOVAR', 'NO_RENOVAR', 'INDETERMINADO'] },
    recomendadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    recomendadoEn: Date,
    notaRecomendacion: String,
    decision: { type: String, enum: ['RENOVADO', 'NO_RENOVADO', 'CONVERTIDO_INDETERMINADO'] },
    decididoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    decididoEn: Date,
    notaDecision: String,
  },
  motivoTermino: String,
  urlDocumento: String,
}, {
  /**
   * Bloqueo optimista.
   * Recomendar y resolver una renovacion las hacen personas distintas:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'contratos',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaContrato.virtual('diasHastaVencimiento').get(function () {
  if (!this.fechaFin) return null; // indefinido
  return Math.ceil((this.fechaFin - Date.now()) / (1000 * 60 * 60 * 24));
});

esquemaContrato.index({ empleado: 1, estado: 1 });
esquemaContrato.index({ fechaFin: 1, estado: 1 });

module.exports = mongoose.model('Contrato', esquemaContrato);
