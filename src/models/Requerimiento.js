const mongoose = require('mongoose');

/**
 * Requerimiento de Personal
 *
 * Flujo jerárquico de aprobación:
 *   SOLICITADO      → el Administrador de Botica / Jefe de CEDI levanta la necesidad
 *   APROBADO_ZONAL  → el Supervisor de Zona valida presupuesto y dotación
 *   EN_BUSQUEDA     → el Analista de Selección abre la vacante
 *   CUBIERTO        → se contrató al candidato
 *   RECHAZADO / CANCELADO
 */

const esquemaPasoAprobacion = new mongoose.Schema({
  paso: { type: String, enum: ['ZONAL', 'SELECCION'], required: true },
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  decision: { type: String, enum: ['APROBADO', 'RECHAZADO'], required: true },
  comentario: String,
  fecha: { type: Date, default: Date.now },
}, { _id: false });

const esquemaRequerimiento = new mongoose.Schema({
  codigo: { type: String, unique: true },

  // Qué se necesita
  cargo: { type: mongoose.Schema.Types.ObjectId, ref: 'Cargo', required: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  zona: { type: mongoose.Schema.Types.ObjectId, ref: 'Zona' },
  cantidad: { type: Number, default: 1, min: 1 },
  turno: { type: String, enum: ['MANANA', 'TARDE', 'NOCHE', 'COMPLETO', 'ROTATIVO'], default: 'ROTATIVO' },

  // Por qué
  motivo: {
    type: String,
    enum: ['REEMPLAZO', 'INCREMENTO_DOTACION', 'APERTURA_LOCAL', 'TEMPORADA_ALTA', 'COBERTURA_VACACIONES', 'CESE'],
    required: true,
  },
  justificacion: { type: String, required: true },
  reemplazaA: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },

  urgencia: { type: String, enum: ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'], default: 'MEDIA' },
  requeridoPara: Date,
  sueldoOfrecido: Number,

  // Quién y en qué estado
  solicitadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  estado: {
    type: String,
    enum: ['SOLICITADO', 'APROBADO_ZONAL', 'EN_BUSQUEDA', 'CUBIERTO', 'RECHAZADO', 'CANCELADO'],
    default: 'SOLICITADO',
  },
  aprobaciones: [esquemaPasoAprobacion],
  reclutadorAsignado: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  empleadoContratado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },
  cerradoEn: Date,
}, {
  /**
   * Bloqueo optimista.
   * Un requerimiento lo aprueba la zona y lo cierra reclutamiento:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'requerimientos',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Días transcurridos desde la solicitud (indicador de tiempo de cobertura) */
esquemaRequerimiento.virtual('diasAbierto').get(function () {
  const fin = this.cerradoEn || new Date();
  return Math.floor((fin - this.creadoEn) / 86400000);
});

esquemaRequerimiento.virtual('estaVencido').get(function () {
  if (!this.requeridoPara || ['CUBIERTO', 'CANCELADO', 'RECHAZADO'].includes(this.estado)) return false;
  return new Date() > this.requeridoPara;
});

// Código correlativo REQ-000123
esquemaRequerimiento.pre('save', async function () {
  if (this.codigo) return;
  const count = await mongoose.model('Requerimiento').countDocuments();
  this.codigo = `REQ-${String(count + 1).padStart(6, '0')}`;
});

esquemaRequerimiento.index({ estado: 1, creadoEn: -1 });
esquemaRequerimiento.index({ local: 1, estado: 1 });
esquemaRequerimiento.index({ zona: 1, estado: 1 });

module.exports = mongoose.model('Requerimiento', esquemaRequerimiento);
