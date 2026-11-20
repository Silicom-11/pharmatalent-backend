const mongoose = require('mongoose');
const { CAUSAS_CODIGOS } = require('../config/ceseParams');

/**
 * Liquidación de beneficios sociales.
 *
 * Se guarda el cálculo completo, no sólo el total: qué conceptos se pagaron,
 * sobre qué base, con qué norma y qué se descontó. Cinco años después, cuando
 * alguien reclame o SUNAFIL pregunte, la respuesta tiene que estar aquí y no
 * depender de que el motor de cálculo siga dando el mismo número —los
 * parámetros cambian cada año, y el documento debe reflejar los que regían
 * el día del cese.
 */

const conceptoSchema = new mongoose.Schema({
  concepto: { type: String, required: true },
  detalle: String,
  monto: { type: Number, required: true },
  base: Number,
  norma: String,
  afectaPension: Boolean,
  afectaRenta: Boolean,
}, { _id: false });

const descuentoSchema = new mongoose.Schema({
  concepto: { type: String, required: true },
  detalle: String,
  monto: { type: Number, required: true },
}, { _id: false });

const esquemaLiquidacion = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true, index: true },
  contrato: { type: mongoose.Schema.Types.ObjectId, ref: 'Contrato' },

  // ─── El cese ───
  causa: { type: String, enum: CAUSAS_CODIGOS, required: true },
  fechaCese: { type: Date, required: true },
  motivoDetallado: { type: String, maxlength: 1000 },

  tiempoDeServicio: String,
  mesesDeServicio: Number,
  enPeriodoPrueba: Boolean,

  // ─── El cálculo, congelado ───
  remuneracionComputable: {
    basico: Number,
    asignacionFamiliar: Number,
    sextoGratificacion: Number,
    ordinaria: Number,
    paraCTS: Number,
  },
  conceptos: [conceptoSchema],
  descuentos: [descuentoSchema],

  rentaQuinta: {
    percibidoRegular: Number,
    liquidacionAfecta: Number,
    baseImponible: Number,
    impuestoDelEjercicio: Number,
    yaRetenido: Number,
    aRetenerAhora: Number,
  },

  totales: {
    bruto: Number,
    descuentos: Number,
    neto: Number,
    afectoPension: Number,
    afectoRenta: Number,
  },

  /** Los parámetros que regían el día del cese, para poder reproducir el cálculo */
  parametrosVigentes: {
    rmv: Number,
    uit: Number,
    anio: Number,
  },

  avisos: [String],

  // ─── Recorrido de la liquidación ───
  estado: {
    type: String,
    enum: ['BORRADOR', 'APROBADA', 'PAGADA', 'ANULADA'],
    default: 'BORRADOR',
    index: true,
  },
  calculadaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  calculadaEn: { type: Date, default: Date.now },
  aprobadaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  aprobadaEn: Date,

  // ─── Constancia del pago ───
  pagadaEn: Date,
  pagadaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  medioDePago: {
    type: String,
    enum: ['TRANSFERENCIA', 'DEPOSITO_CUENTA', 'EFECTIVO', 'CHEQUE'],
  },
  referenciaPago: String,

  /**
   * El trabajador deja constancia de que la recibió. No implica conformidad:
   * puede firmar y observarla, y esa observación queda aquí.
   */
  firmadaPorTrabajador: { type: Boolean, default: false },
  firmadaEn: Date,
  observacionTrabajador: { type: String, maxlength: 2000 },

  /** Certificado de trabajo, exigible en el mismo plazo de 48 horas */
  certificadoEmitidoEn: Date,

  anuladaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  anuladaEn: Date,
  motivoAnulacion: String,
}, {
  /**
   * Bloqueo optimista: aprobar y pagar las hacen personas distintas, y una
   * liquidación pisada por otra sesión dejaría dos decisiones y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'liquidaciones',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
});

/**
 * Una persona no puede tener dos liquidaciones vigentes por el mismo cese.
 *
 * Se enumeran los estados vivos en lugar de excluir el anulado. MongoDB no
 * admite `$ne` en un índice parcial, y con `$ne` el índice sencillamente no
 * llegaba a crearse: la regla existía en el código y no en la base de datos.
 * Como la colección estaba vacía, nadie lo notó.
 */
esquemaLiquidacion.index(
  { empleado: 1, fechaCese: 1 },
  { unique: true, partialFilterExpression: { estado: { $in: ['BORRADOR', 'APROBADA', 'PAGADA'] } } }
);
esquemaLiquidacion.index({ estado: 1, fechaCese: -1 });

/** Días transcurridos desde el cese, para vigilar el plazo de 48 horas */
esquemaLiquidacion.virtual('diasDesdeElCese').get(function () {
  if (!this.fechaCese) return null;
  return Math.floor((Date.now() - this.fechaCese) / 86400000);
});

esquemaLiquidacion.set('toJSON', { virtuals: true });
esquemaLiquidacion.set('toObject', { virtuals: true });

module.exports = mongoose.model('Liquidacion', esquemaLiquidacion);
