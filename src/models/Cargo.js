const mongoose = require('mongoose');

const esquemaCargo = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  codigo: { type: String, required: true, unique: true, uppercase: true },
  departamento: {
    type: String,
    enum: ['OPERACIONES', 'LOGISTICA', 'RRHH', 'ADMINISTRACION', 'CALIDAD', 'GERENCIA'],
    required: true,
  },
  /** Nivel organizacional donde opera el puesto */
  nivelOrganizacional: {
    type: String,
    enum: ['BOTICA', 'CEDI', 'ZONAL', 'CORPORATIVO'],
    default: 'BOTICA',
  },
  /** Rol del sistema que se asigna por defecto a este puesto */
  rolPorDefecto: String,
  nivel: {
    type: Number,
    min: 1,
    max: 10,
    required: true,
  },
  rangoSueldo: {
    minimo: { type: Number, required: true },
    maximo: { type: Number, required: true },
  },
  descripcion: String,
  requisitos: [String],
  requiereQF: { type: Boolean, default: false },
  activo: { type: Boolean, default: true },
}, { collection: 'cargos', timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

module.exports = mongoose.model('Cargo', esquemaCargo);
