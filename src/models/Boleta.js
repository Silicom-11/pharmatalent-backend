const mongoose = require('mongoose');

const esquemaBoleta = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  periodo: { type: String, required: true, match: /^\d{4}-\d{2}$/ },   // p. ej. "2026-08"
  /** La planilla mensual a la que pertenece esta boleta */
  planilla: { type: mongoose.Schema.Types.ObjectId, ref: 'Planilla', index: true },
  sueldoBasico: { type: Number, default: 0 },
  diasTrabajados: { type: Number, default: 30 },
  horasExtra: { type: Number, default: 0 },
  pagoHorasExtra: { type: Number, default: 0 },
  bonos: { type: Number, default: 0 },
  descuentosSimples: {
    afp: { type: Number, default: 0 },
    salud: { type: Number, default: 0 },
    impuestos: { type: Number, default: 0 },
    otro: { type: Number, default: 0 },
  },
  netoAPagar: { type: Number, default: 0 },

  // ─── Desglose consolidado del período ───
  dias: {
    calendario: Number, remunerados: Number, marcados: Number, faltas: Number,
    vacaciones: Number, licenciaSinGoce: Number,
    /** Días del mes anteriores al ingreso: no hubo vínculo, no se pagan */
    antesDelIngreso: Number,
    descansoMedicoEmpleador: Number, descansoMedicoSubsidiado: Number,
  },
  ingresos: {
    basico: Number,
    asignacionFamiliar: Number,
    horasExtra: { horas: Number, horasAl25: Number, horasAl35: Number, valorHora: Number, monto: Number },
    subsidioEsSalud: Number,
    bonificaciones: Number,
    total: Number,
  },
  descuentos: {
    pension: { sistema: String, etiqueta: String, aporte: Number, comision: Number, primaSeguro: Number, total: Number },
    rentaQuinta: { monto: Number, baseImponible: Number, proyeccionAnual: Number },
    tardanza: { minutos: Number, minutosDescontados: Number, monto: Number },
    otros: Number,
    total: Number,
  },
  /** Lo que paga la empresa por encima del sueldo: nunca se descuenta al trabajador */
  aportesEmpleador: { esSalud: Number, sctr: Number, enRiesgo: Boolean, total: Number },
  gratificacion: { aplica: Boolean, monto: Number, bonificacionExtraordinaria: Number, total: Number },
  cts: { aplica: Boolean, base: Number, monto: Number },
  remuneracionAfecta: Number,
  costoEmpresa: Number,
  estado: {
    type: String,
    enum: ['BORRADOR', 'CALCULADO', 'APROBADO', 'PAGADO'],
    default: 'BORRADOR',
  },
  calculadoEn: Date,
  aprobadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  aprobadoEn: Date,

  /**
   * Anotación del analista. Es lo único que se edita a mano en una boleta:
   * «reintegro de julio», «descuento judicial oficio 1234». Los importes los
   * produce el motor de cálculo.
   */
  notas: { type: String, maxlength: 500 },
  notaPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  notaEn: Date,

  // ─── Constancia de pago ───
  // La fecha efectiva de pago es dato declarable en el PLAME, no un detalle interno
  pagadoEn: Date,
  pagadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  medioDePago: {
    type: String,
    enum: ['TRANSFERENCIA', 'DEPOSITO_CUENTA', 'EFECTIVO', 'CHEQUE'],
    default: 'DEPOSITO_CUENTA',
  },
  referenciaPago: String,
}, {
  /**
   * Bloqueo optimista.
   * Aprobar y pagar son decisiones separadas que pueden concurrir:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'boletas',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

// El neto lo entrega el motor de planilla. Este gancho sólo cubre las boletas
// cargadas a mano, que no traen el desglose consolidado.
esquemaBoleta.pre('save', function () {
  if (this.ingresos?.total != null && this.descuentos?.total != null) {
    this.netoAPagar = Math.round((this.ingresos.total - this.descuentos.total) * 100) / 100;
    return;
  }
  const descuentos = (this.descuentosSimples.afp || 0) + (this.descuentosSimples.impuestos || 0) + (this.descuentosSimples.otro || 0);
  this.netoAPagar = Math.round(((this.sueldoBasico || 0) + (this.pagoHorasExtra || 0) + (this.bonos || 0) - descuentos) * 100) / 100;
});

esquemaBoleta.index({ empleado: 1, periodo: 1 }, { unique: true });
esquemaBoleta.index({ periodo: 1, estado: 1 });

module.exports = mongoose.model('Boleta', esquemaBoleta);
