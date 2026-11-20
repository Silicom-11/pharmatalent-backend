const mongoose = require('mongoose');

const esquemaVacacion = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  tipo: {
    type: String,
    enum: ['VACACIONES', 'PERMISO', 'LICENCIA_MEDICA', 'LICENCIA_SIN_GOCE'],
    required: true,
  },
  fechaInicio: { type: Date, required: true },
  fechaFin: { type: Date, required: true },
  diasTotales: { type: Number, required: true },
  estado: {
    type: String,
    enum: ['PENDIENTE', 'APROBADO_LOCAL', 'APROBADO', 'RECHAZADO', 'EN_CURSO', 'COMPLETADO', 'CANCELADO'],
    default: 'PENDIENTE',
  },
  motivo: String,

  /**
   * Pasos que debe recorrer la solicitud, fijados al crearla según dónde
   * trabaja quien pide (ver services/aprobaciones.js). Se guardan para que un
   * traslado posterior no cambie a mitad de camino quién tiene que decidir.
   */
  cadena: [{ type: String, enum: ['LOCAL', 'ZONAL', 'RRHH', 'DIRECCION'] }],

  /** Decisiones tomadas, en orden */
  aprobaciones: [{
    paso: { type: String, enum: ['LOCAL', 'ZONAL', 'RRHH', 'DIRECCION'] },
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    decision: { type: String, enum: ['APROBADO', 'RECHAZADO'] },
    comentario: String,
    /** Decidió alguien de RRHH o Dirección en lugar de quien correspondía */
    suplencia: { type: Boolean, default: false },
    fecha: { type: Date, default: Date.now },
  }],
  /** Advertencias de cobertura registradas al momento de solicitar */
  avisosCobertura: [String],
  solicitadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },

  // D.L. 713 calculation
  dl713: {
    anosDeServicio: Number,
    diasAcumulados: Number,
    diasGozados: Number,
    diasDisponibles: Number,
    fechaLimite: Date, // fecha límite para gozar vacaciones
    riesgoTriplePago: { type: Boolean, default: false },
  },

  aprobadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  aprobadoEn: Date,
  motivoRechazo: String,
  comentarios: String,
}, {
  /**
   * Bloqueo optimista.
   * Dos supervisores pueden abrir la misma solicitud de descanso:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'vacaciones',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Días que faltan para el inicio del descanso */
esquemaVacacion.virtual('diasHastaInicio').get(function () {
  if (!this.fechaInicio) return null;
  return Math.ceil((this.fechaInicio - Date.now()) / 86400000);
});

/** ¿El descanso está transcurriendo ahora mismo? */
esquemaVacacion.virtual('enCurso').get(function () {
  const now = new Date();
  return ['APROBADO', 'EN_CURSO'].includes(this.estado)
    && this.fechaInicio <= now && this.fechaFin >= now;
});

esquemaVacacion.index({ empleado: 1, estado: 1 });
esquemaVacacion.index({ fechaInicio: 1, fechaFin: 1 });

module.exports = mongoose.model('Vacacion', esquemaVacacion);
