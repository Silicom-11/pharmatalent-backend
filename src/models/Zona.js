const mongoose = require('mongoose');

const esquemaZona = new mongoose.Schema({
  nombre: { type: String, required: true, unique: true, trim: true },
  codigo: { type: String, required: true, unique: true, uppercase: true },
  responsable: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },
  descripcion: String,
  activo: { type: Boolean, default: true },
}, {
  collection: 'zonas',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

esquemaZona.virtual('locales', {
  ref: 'Local',
  localField: '_id',
  foreignField: 'zona',
});

module.exports = mongoose.model('Zona', esquemaZona);
