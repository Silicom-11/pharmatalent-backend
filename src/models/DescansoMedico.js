const mongoose = require('mongoose');

/**
 * Descanso Médico y Subsidios — módulo de Bienestar Social
 *
 * Marco legal peruano (EsSalud):
 *  · Los primeros 20 días de incapacidad al año son asumidos por el empleador.
 *  · A partir del día 21 corresponde subsidio de EsSalud, previo canje de CITT
 *    (Certificado de Incapacidad Temporal para el Trabajo).
 *  · El plazo para solicitar el reembolso es de 6 meses desde el fin del descanso.
 */

const esquemaDescansoMedico = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },

  tipo: {
    type: String,
    enum: ['ENFERMEDAD_COMUN', 'ACCIDENTE_TRABAJO', 'ACCIDENTE_COMUN', 'MATERNIDAD', 'LACTANCIA', 'ENFERMEDAD_PROFESIONAL'],
    required: true,
  },
  diagnostico: String,          // CIE-10 o descripción
  centroMedico: String,
  nombreMedico: String,
  cmpMedico: String,          // Colegio Médico del Perú

  fechaInicio: { type: Date, required: true },
  fechaFin: { type: Date, required: true },
  diasTotales: { type: Number, required: true, min: 1 },

  // Certificado de Incapacidad Temporal para el Trabajo
  citt: {
    numero: String,
    emitido: { type: Boolean, default: false },
    fechaEmision: Date,
    canjeadoEn: Date,        // fecha de canje en EsSalud
  },

  // Subsidio
  subsidio: {
    aplica: { type: Boolean, default: false },       // sólo si acumula > 20 días
    diasEmpleador: { type: Number, default: 0 },       // días a cargo del empleador
    diasEssalud: { type: Number, default: 0 },        // días subsidiados
    montoEstimado: { type: Number, default: 0 },
    estadoReembolso: {
      type: String,
      enum: ['NO_APLICA', 'PENDIENTE', 'PRESENTADO', 'OBSERVADO', 'REEMBOLSADO'],
      default: 'NO_APLICA',
    },
    fechaReembolso: Date,
    montoReembolsado: Number,
  },

  estado: {
    type: String,
    enum: ['REGISTRADO', 'VALIDADO', 'RECHAZADO', 'CERRADO'],
    default: 'REGISTRADO',
  },
  validadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  registradoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  notas: String,
  adjuntos: [String],
}, {
  /**
   * Bloqueo optimista.
   * Validar el CITT y registrar el canje son pasos distintos:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'descansosmedicos',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

/** Fecha límite para solicitar el reembolso a EsSalud (6 meses tras el alta) */
esquemaDescansoMedico.virtual('fechaLimiteReembolso').get(function () {
  if (!this.fechaFin) return null;
  const d = new Date(this.fechaFin);
  d.setMonth(d.getMonth() + 6);
  return d;
});

esquemaDescansoMedico.virtual('reembolsoVencido').get(function () {
  const dl = this.fechaLimiteReembolso;
  if (!dl || !this.subsidio?.aplica) return false;
  return new Date() > dl && this.subsidio.estadoReembolso !== 'REEMBOLSADO';
});

/** Reparte los días entre empleador (primeros 20) y EsSalud, y estima el subsidio */
esquemaDescansoMedico.methods.calcularSubsidio = function (accumulatedDaysThisYear = 0, dailySalary = 0) {
  const EMPLOYER_CAP = 20;
  const before = accumulatedDaysThisYear;
  const after = before + this.diasTotales;

  const diasEmpleador = Math.max(0, Math.min(after, EMPLOYER_CAP) - Math.min(before, EMPLOYER_CAP));
  const diasEssalud = this.diasTotales - diasEmpleador;

  this.subsidio.diasEmpleador = diasEmpleador;
  this.subsidio.diasEssalud = diasEssalud;
  this.subsidio.aplica = diasEssalud > 0;
  this.subsidio.montoEstimado = Math.round(diasEssalud * dailySalary * 100) / 100;
  if (this.subsidio.aplica && this.subsidio.estadoReembolso === 'NO_APLICA') {
    this.subsidio.estadoReembolso = 'PENDIENTE';
  }
  return this.subsidio;
};

esquemaDescansoMedico.index({ empleado: 1, fechaInicio: -1 });
esquemaDescansoMedico.index({ estado: 1 });
esquemaDescansoMedico.index({ 'subsidio.estadoReembolso': 1 });

module.exports = mongoose.model('DescansoMedico', esquemaDescansoMedico);
