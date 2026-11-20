const mongoose = require('mongoose');

/**
 * Bitácora de cambios.
 *
 * En un sistema que toca sueldos, contratos y vacaciones, «quién cambió esto y
 * cuándo» no es una comodidad: es lo que permite responder ante una auditoría
 * laboral o una reclamación. Se guarda una entrada por cada operación que
 * modifica datos, con el estado anterior cuando se pudo capturar.
 */

const esquemaBitacora = new mongoose.Schema({
  // ─── Quién ───
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true, index: true },
  actorCorreo: { type: String, required: true },
  actorRol: { type: String, required: true },

  // ─── Qué ───
  /** Módulo funcional afectado: payroll, contracts, vacations... */
  modulo: { type: String, required: true, index: true },
  /** Verbo de negocio: CREAR, MODIFICAR, APROBAR, RECHAZAR, ELIMINAR... */
  accion: { type: String, required: true, index: true },
  /** Descripción legible por una persona, sin tecnicismos */
  descripcion: { type: String, required: true },

  // ─── Sobre qué ───
  entidad: String,
  entidadId: { type: mongoose.Schema.Types.ObjectId, index: true },
  /** Empleado afectado, cuando el cambio recae sobre una persona concreta */
  afectado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', index: true },

  /** Estado anterior y posterior de los campos que cambiaron */
  antes: mongoose.Schema.Types.Mixed,
  despues: mongoose.Schema.Types.Mixed,

  // ─── Contexto técnico ───
  metodo: String,
  ruta: String,
  estado: Number,
  ip: String,
  /** Marca las operaciones sobre datos remunerativos o de salud */
  sensible: { type: Boolean, default: false, index: true },
}, {
  collection: 'bitacoras',
  timestamps: { createdAt: 'creadoEn', updatedAt: false },
});

// La consulta habitual es «lo último que pasó», y «todo lo de esta persona»
esquemaBitacora.index({ creadoEn: -1 });
esquemaBitacora.index({ modulo: 1, creadoEn: -1 });
esquemaBitacora.index({ afectado: 1, creadoEn: -1 });

/** La bitácora no se edita ni se borra: sería como tacharla */
esquemaBitacora.pre('findOneAndUpdate', function (next) {
  next(new Error('La bitácora no admite modificaciones'));
});
esquemaBitacora.pre('updateOne', function (next) {
  next(new Error('La bitácora no admite modificaciones'));
});
esquemaBitacora.pre('deleteOne', function (next) {
  next(new Error('La bitácora no admite eliminaciones'));
});
esquemaBitacora.pre('deleteMany', function (next) {
  next(new Error('La bitácora no admite eliminaciones'));
});

module.exports = mongoose.model('Bitacora', esquemaBitacora);
