const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ROLE_CODES, ROLES } = require('../config/roles');

const esquemaUsuario = new mongoose.Schema({
  correo: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  contrasena: {
    type: String,
    required: true,
    minlength: 6,
    select: false,
  },
  rol: {
    type: String,
    enum: ROLE_CODES,
    required: true,
  },
  empleado: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empleado',
  },
  activo: { type: Boolean, default: true },
  ultimoIngreso: Date,

  // ─── Gestión de la credencial ───
  /** Obliga a definir una contraseña propia en el primer ingreso */
  debeCambiarContrasena: { type: Boolean, default: false },
  contrasenaCambiadaEn: Date,
  /** Bloqueo temporal tras intentos fallidos consecutivos */
  intentosFallidos: { type: Number, default: 0 },
  bloqueadoHasta: Date,
  /**
   * Versión de sesión.
   *
   * El token JWT lleva grabado este número. Al subirlo, todos los tokens
   * emitidos antes dejan de valer al instante: es la única forma de cerrar una
   * sesión abierta sin mantener una lista de tokens revocados.
   *
   * Sube al cambiar la contraseña, al revocar el acceso y al cambiar de rol —
   * este último importa: alguien degradado seguiría paseándose con los
   * permisos antiguos hasta que su token expirara.
   */
  versionToken: { type: Number, default: 0 },
  /** Cierre de sesiones anterior, para poder explicárselo a la persona */
  sesionesCerradasEn: Date,
  sesionesCerradasPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },

  /**
   * Recuperación de contraseña en curso.
   * Se guarda la huella del código, nunca el código: quien lea la base de
   * datos no debe poder usarlo para entrar.
   */
  recuperacion: {
    huella: { type: String, select: false },
    expiraEn: Date,
    intentos: { type: Number, default: 0 },
    solicitadaEn: Date,
    usadaEn: Date,
    // Cuántas veces la pidió en la ventana, para que no se use como acoso
    solicitudesRecientes: { type: Number, default: 0 },
  },

  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  desactivadoEn: Date,
  desactivadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
}, {
  collection: 'usuarios',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Metadatos del rol resueltos desde el catálogo organizacional */
esquemaUsuario.virtual('metaRol').get(function () {
  const r = ROLES[this.rol];
  if (!r) return null;
  return {
    codigo: this.rol,
    etiqueta: r.etiqueta,
    short: r.short,
    nivelOrganizacional: r.nivelOrganizacional,
    scope: r.scope,
    rank: r.rank,
    color: r.color,
    permissions: r.permissions,
  };
});

esquemaUsuario.pre('save', async function () {
  if (!this.isModified('contrasena')) return;
  this.contrasena = await bcrypt.hash(this.contrasena, 12);
});

/** La representación pública nunca incluye la credencial ni el bloqueo */
esquemaUsuario.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.contrasena;
    delete ret.intentosFallidos;
    delete ret.bloqueadoHasta;
    delete ret.versionToken;
    return ret;
  },
});

esquemaUsuario.methods.compararContrasena = async function (candidate) {
  return bcrypt.compare(candidate, this.contrasena);
};

esquemaUsuario.methods.generarToken = function () {
  return jwt.sign(
    // `tv` viaja en el token para poder invalidarlo sin consultar una lista negra
    { id: this._id, rol: this.rol, tv: this.versionToken || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
};

/**
 * Invalida todas las sesiones abiertas de esta cuenta.
 * No guarda: quien la llama decide cuándo persistir, para poder agrupar el
 * cambio con lo que lo motivó.
 */
esquemaUsuario.methods.cerrarSesiones = function (porQuien) {
  this.versionToken = (this.versionToken || 0) + 1;
  this.sesionesCerradasEn = new Date();
  if (porQuien) this.sesionesCerradasPor = porQuien;
  return this;
};

module.exports = mongoose.model('Usuario', esquemaUsuario);
