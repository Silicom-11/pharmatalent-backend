const mongoose = require('mongoose');

const esquemaNotificacion = new mongoose.Schema({
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  tipo: {
    type: String,
    // Debe contener todo tipo que alguna ruta emita: uno no declarado hace
    // fallar la creación y, si no se aísla, tumba la operación que lo motivó
    enum: [
      'CONTRATO', 'VACACION', 'TURNO', 'QF_COBERTURA', 'CAPACITACION', 'NOMINA',
      'REQUERIMIENTO', 'RECLUTAMIENTO', 'AUDITORIA', 'BIENESTAR', 'SISTEMA',
      'EVALUACION', 'BOTICA', 'CEDI',
    ],
  },
  titulo: { type: String, required: true, trim: true },
  mensaje: { type: String, required: true, trim: true },
  leido: { type: Boolean, default: false },
  leidoEn: Date,
  modeloRelacionado: String, // e.g. 'Contract', 'Vacation'
  idRelacionado: { type: mongoose.Schema.Types.ObjectId },
  prioridad: {
    type: String,
    enum: ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'],
    default: 'MEDIA',
  },
}, { collection: 'notificaciones', timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaNotificacion.index({ usuario: 1, leido: 1 });
esquemaNotificacion.index({ usuario: 1, creadoEn: -1 });

module.exports = mongoose.model('Notificacion', esquemaNotificacion);
