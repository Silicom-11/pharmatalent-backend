const mongoose = require('mongoose');

/**
 * Visita de Auditoría de Calidad (Asuntos Regulatorios)
 *
 * El Auditor de Calidad realiza visitas inopinadas para verificar el
 * cumplimiento de la normativa DIGEMID en cada botica. El resultado
 * alimenta el semáforo de riesgo regulatorio de la cadena.
 */

const esquemaHallazgo = new mongoose.Schema({
  categoria: {
    type: String,
    enum: [
      'PRESENCIA_QF',            // Director Técnico presente en horario de atención
      'CADENA_FRIO',             // registros de temperatura
      'PRODUCTOS_CONTROLADOS',   // psicotrópicos y estupefacientes
      'ROTULADO_VENCIMIENTOS',
      'DOCUMENTACION',
      'BPA_DISPENSACION',        // Buenas Prácticas de Almacenamiento/Dispensación
      'INFRAESTRUCTURA',
      'PERSONAL_CAPACITADO',
    ],
    required: true,
  },
  severidad: { type: String, enum: ['CRITICA', 'MAYOR', 'MENOR', 'OBSERVACION'], required: true },
  descripcion: { type: String, required: true },
  accionCorrectiva: String,
  fechaVencimiento: Date,
  resuelto: { type: Boolean, default: false },
  resueltoEn: Date,
}, { _id: true });

const esquemaVisitaAuditoria = new mongoose.Schema({
  codigo: { type: String, unique: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  zona: { type: mongoose.Schema.Types.ObjectId, ref: 'Zona' },
  auditor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },

  fechaVisita: { type: Date, required: true, default: Date.now },
  tipo: { type: String, enum: ['INOPINADA', 'PROGRAMADA', 'SEGUIMIENTO', 'PRE_DIGEMID'], default: 'INOPINADA' },

  // Verificación puntual del Director Técnico
  directorTecnicoPresente: { type: Boolean, default: true },
  directorTecnicoDeTurno: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },

  hallazgos: [esquemaHallazgo],
  puntaje: { type: Number, min: 0, max: 100 },
  resultado: { type: String, enum: ['CONFORME', 'CONFORME_CON_OBSERVACIONES', 'NO_CONFORME'] },

  estado: { type: String, enum: ['BORRADOR', 'CERRADA', 'EN_SEGUIMIENTO'], default: 'BORRADOR' },
  resumen: String,
  fechaProximaVisita: Date,
}, {
  collection: 'visitasauditoria',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

esquemaVisitaAuditoria.virtual('hallazgosCriticos').get(function () {
  return (this.hallazgos || []).filter((f) => f.severidad === 'CRITICA' && !f.resuelto).length;
});

esquemaVisitaAuditoria.virtual('hallazgosAbiertos').get(function () {
  return (this.hallazgos || []).filter((f) => !f.resuelto).length;
});

/** Puntuación: 100 menos penalización por severidad de hallazgos */
esquemaVisitaAuditoria.methods.calcularPuntaje = function () {
  const WEIGHTS = { CRITICA: 25, MAYOR: 10, MENOR: 4, OBSERVACION: 1 };
  const penalty = (this.hallazgos || []).reduce((sum, f) => sum + (WEIGHTS[f.severidad] || 0), 0);
  const raw = Math.max(0, 100 - penalty);
  // La ausencia del Director Técnico es causal directa de no conformidad
  this.puntaje = this.directorTecnicoPresente ? raw : Math.min(raw, 49);
  this.resultado = this.puntaje >= 90 ? 'CONFORME'
    : this.puntaje >= 70 ? 'CONFORME_CON_OBSERVACIONES'
      : 'NO_CONFORME';
  return this.puntaje;
};

esquemaVisitaAuditoria.pre('save', async function () {
  if (!this.codigo) {
    const count = await mongoose.model('VisitaAuditoria').countDocuments();
    this.codigo = `AUD-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  }
});

esquemaVisitaAuditoria.index({ local: 1, fechaVisita: -1 });
esquemaVisitaAuditoria.index({ zona: 1, fechaVisita: -1 });
esquemaVisitaAuditoria.index({ resultado: 1 });

module.exports = mongoose.model('VisitaAuditoria', esquemaVisitaAuditoria);
