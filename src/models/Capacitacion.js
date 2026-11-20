const mongoose = require('mongoose');

const esquemaCapacitacion = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  nombre: { type: String, required: true, trim: true },
  tipo: {
    type: String,
    enum: ['INDUCCION', 'BPA', 'DIGEMID', 'SEGURIDAD', 'LIDERAZGO', 'OTRO'],
    required: true,
  },
  proveedor: { type: String, trim: true },
  fechaProgramada: { type: Date, required: true },
  fechaCompletado: Date,
  horasDuracion: Number,
  estado: {
    type: String,
    enum: ['PROGRAMADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA'],
    default: 'PROGRAMADA',
  },
  puntaje: { type: Number, min: 0, max: 100 },
  numeroCertificado: String,
  urlCertificado: String,
  venceEn: Date,
  notas: String,
}, { collection: 'capacitaciones', timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaCapacitacion.index({ empleado: 1, tipo: 1 });
esquemaCapacitacion.index({ tipo: 1, estado: 1 });
esquemaCapacitacion.index({ venceEn: 1 });

module.exports = mongoose.model('Capacitacion', esquemaCapacitacion);
