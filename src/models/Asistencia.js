const mongoose = require('mongoose');

const esquemaAsistencia = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  fecha: { type: Date, required: true },
  marcaEntrada: Date,
  marcaSalida: Date,
  estado: {
    type: String,
    enum: ['PRESENTE', 'AUSENTE', 'TARDANZA', 'PERMISO', 'VACACIONES', 'LICENCIA', 'FERIADO'],
    default: 'AUSENTE',
  },
  horasTrabajadas: { type: Number, default: 0 },
  minutosTardanza: { type: Number, default: 0 },
  horasExtra: { type: Number, default: 0 },   // horas sobre el término del turno
  notas: String,
  verificadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },

  /**
   * De dónde vino la marca. El registro de control de asistencia (D.S.
   * 004-2006-TR) tiene que poder mostrarse a SUNAFIL, y una marca hecha en el
   * terminal de la botica no vale lo mismo que una puesta a mano después: la
   * segunda tiene que decir quién la puso y por qué.
   */
  origen: {
    type: String,
    enum: ['TERMINAL', 'CORRECCION', 'IMPORTACION'],
    default: 'TERMINAL',
  },
  /** Cómo se identificó la persona en el terminal */
  metodo: { type: String, enum: ['ROSTRO', 'HUELLA', 'DNI'] },
  /** Registro manual de la jefatura: obligatorio decir quién y por qué */
  correccion: {
    por: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    en: Date,
    motivo: String,
  },
}, { collection: 'asistencias', timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaAsistencia.pre('save', function () {
  if (this.marcaEntrada && this.marcaSalida) {
    this.horasTrabajadas = Math.round(((this.marcaSalida - this.marcaEntrada) / 3600000) * 100) / 100;
  }
});

esquemaAsistencia.index({ empleado: 1, fecha: 1 }, { unique: true });
esquemaAsistencia.index({ local: 1, fecha: 1 });
esquemaAsistencia.index({ estado: 1, fecha: 1 });

module.exports = mongoose.model('Asistencia', esquemaAsistencia);
