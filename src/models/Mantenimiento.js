const mongoose = require('mongoose');
const M = require('../config/mantenimiento');

/**
 * Un mantenimiento del sistema: correctivo, adaptativo, perfectivo o preventivo.
 *
 * Es a la vez la solicitud (lo que alguien reportó o pidió) y su documentación
 * (qué se analizó, qué se cambió, cómo se probó y en qué versión salió). El
 * historial guarda cada paso con quién lo dio.
 */
const esquemaPaso = new mongoose.Schema({
  etapa: Number,
  accion: { type: String, enum: ['REGISTRO', 'AVANCE', 'EDICION', 'DESCARTE', 'CIERRE'], required: true },
  nota: String,
  por: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  porNombre: String,
  en: { type: Date, default: Date.now },
}, { _id: false });

const esquemaTarea = new mongoose.Schema({
  codigo: String,
  ok: Boolean,
  detalle: String,
}, { _id: false });

const esquemaMantenimiento = new mongoose.Schema({
  codigo: { type: String, unique: true },
  tipo: { type: String, enum: M.TIPOS_CODIGOS, required: true },
  titulo: { type: String, required: true, trim: true, maxlength: 160 },
  descripcion: { type: String, required: true, trim: true, maxlength: 4000 },
  area: { type: String, enum: Object.keys(M.AREAS), default: 'general' },
  prioridad: { type: String, enum: Object.keys(M.PRIORIDADES), default: 'MEDIA' },
  origen: { type: String, enum: Object.keys(M.ORIGENES), default: 'EQUIPO' },
  estado: { type: String, enum: M.ESTADOS, default: 'ABIERTO' },
  etapa: { type: Number, default: 0, min: 0 },

  reportadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  responsable: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },

  // Dónde ocurrió, capturado al reportar
  contexto: {
    pagina: String,
    navegador: String,
    incidencia: String,       // el código que muestra un error inesperado
    versionSistema: String,
  },

  // Lo que cada etapa produce
  analisis: { type: String, maxlength: 4000 },
  solucion: { type: String, maxlength: 4000 },
  pruebas: { type: String, maxlength: 4000 },
  version: { type: String, maxlength: 20 },
  archivos: [String],
  tareas: [esquemaTarea],     // las tareas de una rutina preventiva

  fechaLimite: Date,
  cerradoEn: Date,
  motivoDescarte: String,
  historial: [esquemaPaso],
}, { collection: 'mantenimientos', timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaMantenimiento.index({ estado: 1, tipo: 1 });
esquemaMantenimiento.index({ reportadoPor: 1, creadoEn: -1 });
esquemaMantenimiento.index({ 'tareas.codigo': 1, creadoEn: -1 });

/** MNT-2026-001: correlativo por año, a partir del último registrado */
esquemaMantenimiento.pre('validate', async function asignarCodigo() {
  if (this.codigo) return;
  const anio = (this.creadoEn || new Date()).getFullYear();
  const ultimo = await this.constructor.findOne({ codigo: new RegExp(`^MNT-${anio}-`) })
    .sort({ codigo: -1 }).select('codigo').lean();
  const n = ultimo ? Number(ultimo.codigo.split('-')[2]) + 1 : 1;
  this.codigo = `MNT-${anio}-${String(n).padStart(3, '0')}`;
});

module.exports = mongoose.model('Mantenimiento', esquemaMantenimiento);
