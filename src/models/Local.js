const mongoose = require('mongoose');
const { FORMATS } = require('../config/formats');

const esquemaLocal = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  codigo: { type: String, required: true, unique: true },
  marca: {
    type: String,
    enum: ['INKAFARMA', 'MIFARMA', 'CORPORATIVO'],
    required: true,
  },
  /** Tipo de centro de trabajo */
  tipo: {
    type: String,
    enum: ['BOTICA', 'CEDI', 'SEDE_CORPORATIVA'],
    default: 'BOTICA',
  },
  /**
   * Formato del centro de trabajo: determina la dotación mínima por turno.
   * El enum se deriva del catálogo para que ambos no se desincronicen.
   */
  formato: {
    type: String,
    enum: Object.keys(FORMATS),
    default: 'ESTANDAR',
  },
  direccion: {
    calle: { type: String, required: true },
    distrito: { type: String, required: true },
    ciudad: { type: String, default: 'Lima' },
    departamento: { type: String, default: 'Lima' },
  },
  zona: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Zona',
    required: function () { return this.tipo === 'BOTICA'; },
  },
  horarioAtencion: {
    apertura: { type: String, default: '08:00' },
    cierre: { type: String, default: '22:00' },
  },
  turnos: {
    tipos: {
      type: [String],
      default: ['MANANA', 'TARDE'],
    },
    horario: {
      MANANA: { inicio: { type: String, default: '08:00' }, fin: { type: String, default: '15:00' } },
      TARDE: { inicio: { type: String, default: '15:00' }, fin: { type: String, default: '22:00' } },
    },
  },
  /** Dotación mínima por turno, por tipo de puesto */
  dotacionRequerida: {
    qfPorTurno: { type: Number, default: 1, min: 1 },      // obligatorio por DIGEMID
    tecnicosPorTurno: { type: Number, default: 2, min: 1 },
    cajerosPorTurno: { type: Number, default: 0 },
    dermoPorTurno: { type: Number, default: 0 },
    almacenPorTurno: { type: Number, default: 0 },
    seguridadPorTurno: { type: Number, default: 0 },
    repartidoresPorTurno: { type: Number, default: 0 },
  },
  /** Administrador de Botica — responsable comercial */
  responsable: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },
  /** Químico Farmacéutico Director Técnico — responsable sanitario ante DIGEMID */
  directorTecnico: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },
  codigoDigemid: String,      // Código de establecimiento farmacéutico
  puntajeUltimaAuditoria: Number,   // Última puntuación de auditoría de calidad (0-100)
  fechaUltimaAuditoria: Date,

  /**
   * Terminal de marcación del centro de trabajo: el reloj biométrico o el
   * equipo de la botica en modo quiosco. La asistencia sólo entra por aquí.
   *
   * Se guarda el hash de la clave y nunca la clave: quien lea la base no puede
   * hacerse pasar por el terminal. La clave en claro se muestra una sola vez,
   * al darla de alta, y se instala en el equipo.
   */
  terminal: {
    claveHash: { type: String, select: false },
    activo: { type: Boolean, default: false },
    altaEn: Date,
    altaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    ultimaMarcaEn: Date,
  },

  activo: { type: Boolean, default: true },
}, {
  collection: 'locales',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Dotación total requerida por turno */
esquemaLocal.virtual('dotacionTotalPorTurno').get(function () {
  const s = this.dotacionRequerida || {};
  return (s.qfPorTurno || 0) + (s.tecnicosPorTurno || 0) + (s.cajerosPorTurno || 0) +
    (s.dermoPorTurno || 0) + (s.almacenPorTurno || 0) + (s.seguridadPorTurno || 0) +
    (s.repartidoresPorTurno || 0);
});

esquemaLocal.index({ zona: 1, activo: 1 });
esquemaLocal.index({ marca: 1, activo: 1 });
esquemaLocal.index({ tipo: 1, activo: 1 });

module.exports = mongoose.model('Local', esquemaLocal);
