const mongoose = require('mongoose');

/**
 * Planilla mensual: el proceso, no el recibo.
 *
 * Una boleta es lo que recibe una persona. La planilla es el cierre del mes
 * completo: qué presupuesto se aprobó, cuánto costó de verdad, cuántas
 * personas entraron en ella y en qué punto del circuito está. Sin esta
 * entidad, «¿cuál fue el presupuesto de octubre?» no tiene dónde responderse,
 * porque el presupuesto no es de nadie en particular: es del mes.
 *
 * Existe además una razón de control. El presupuesto se aprueba antes de
 * calcular, y la desviación entre lo presupuestado y lo ejecutado es lo que
 * revisa la gerencia; guardarlo sólo como suma de boletas obligaría a
 * recalcularlo cada vez y perdería el dato de lo que se había previsto.
 */

const esquemaPlanilla = new mongoose.Schema({
  /** Período en formato AAAA-MM. Hay una planilla por mes y sólo una. */
  periodo: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
  },
  anio: { type: Number, required: true, index: true },
  mes: { type: Number, required: true, min: 1, max: 12 },

  /** Presupuesto aprobado para el mes, antes de calcular nada */
  presupuesto: { type: Number, required: true, min: 0 },
  presupuestoAprobadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  presupuestoAprobadoEn: Date,

  // ─── Lo que resultó al ejecutarla ───
  empleadosIncluidos: { type: Number, default: 0 },
  totalIngresos: { type: Number, default: 0 },
  totalDescuentos: { type: Number, default: 0 },
  totalNeto: { type: Number, default: 0 },
  /** Lo que le cuesta a la empresa: neto más aportes patronales */
  costoEmpresa: { type: Number, default: 0 },

  estado: {
    type: String,
    enum: ['BORRADOR', 'CALCULADA', 'APROBADA', 'PAGADA', 'CERRADA'],
    default: 'BORRADOR',
    index: true,
  },

  calculadaEn: Date,
  calculadaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  aprobadaEn: Date,
  aprobadaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  pagadaEn: Date,
  cerradaEn: Date,

  observaciones: { type: String, maxlength: 500 },
}, {
  collection: 'planillas',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Cuánto se pasó o se ahorró frente a lo presupuestado */
esquemaPlanilla.virtual('desviacion').get(function () {
  if (!this.presupuesto) return null;
  return Math.round((this.costoEmpresa - this.presupuesto) * 100) / 100;
});

esquemaPlanilla.virtual('porcentajeEjecutado').get(function () {
  if (!this.presupuesto) return null;
  return Math.round((this.costoEmpresa / this.presupuesto) * 1000) / 10;
});

esquemaPlanilla.index({ anio: 1, mes: 1 });
esquemaPlanilla.index({ estado: 1, periodo: -1 });

module.exports = mongoose.model('Planilla', esquemaPlanilla);
