const mongoose = require('mongoose');

const esquemaHistorialSueldos = new mongoose.Schema({
  monto: { type: Number, required: true },
  fechaVigencia: { type: Date, required: true },
  motivo: String,
}, { _id: false });

const esquemaHistorialCargos = new mongoose.Schema({
  cargo: { type: mongoose.Schema.Types.ObjectId, ref: 'Cargo', required: true },
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local' },
  fechaInicio: { type: Date, required: true },
  fechaFin: Date,
  motivo: String,
}, { _id: false });

const esquemaEmpleado = new mongoose.Schema({
  dni: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{8}$/,
  },
  nombres: { type: String, required: true, trim: true },
  apellidos: { type: String, required: true, trim: true },
  fechaNacimiento: Date,
  sexo: { type: String, enum: ['M', 'F'] },
  telefono: { type: String, trim: true },
  correo: { type: String, lowercase: true, trim: true },
  direccion: {
    calle: String,
    distrito: String,
    ciudad: { type: String, default: 'Lima' },
    departamento: { type: String, default: 'Lima' },
  },
  foto: String,

  tipoProfesional: {
    type: String,
    enum: ['QF', 'TECNICO', 'OPERARIO', 'ADMINISTRATIVO', 'JEFE_LOCAL', 'JEFE_ZONA', 'GERENCIA'],
    required: true,
  },
  numeroCQF: String, // Colegio Químico Farmacéutico - solo QFs
  vencimientoCQF: Date,
  esDirectorTecnico: { type: Boolean, default: false }, // Director Técnico ante DIGEMID

  // Situación contractual especial
  esPracticante: { type: Boolean, default: false },
  fechaFinPracticas: Date,
  supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado' },

  fechaIngreso: { type: Date, required: true },
  cargoActual: { type: mongoose.Schema.Types.ObjectId, ref: 'Cargo' },
  localActual: { type: mongoose.Schema.Types.ObjectId, ref: 'Local' },
  zona: { type: mongoose.Schema.Types.ObjectId, ref: 'Zona' },

  estado: {
    type: String,
    enum: ['ACTIVO', 'INACTIVO', 'VACACIONES', 'LICENCIA', 'CESADO'],
    default: 'ACTIVO',
  },

  sueldoBasico: { type: Number, required: true },

  // Datos que la planilla necesita para calcular descuentos y asignaciones
  sistemaPensiones: {
    type: String,
    enum: ['ONP', 'AFP_INTEGRA', 'AFP_PRIMA', 'AFP_PROFUTURO', 'AFP_HABITAT'],
    default: 'ONP',
  },
  cuspp: String,                                  // código único del afiliado a AFP
  tieneHijos: { type: Boolean, default: false }, // habilita la asignación familiar (Ley 25129)
  cuentaBancaria: { cci: String, banco: String },
  historialSueldos: [esquemaHistorialSueldos],
  historialCargos: [esquemaHistorialCargos],

  preferenciasTurno: {
    turnoPreferido: { type: String, enum: ['MANANA', 'TARDE', 'NOCHE', 'CUALQUIERA'], default: 'CUALQUIERA' },
    diasNoDisponibles: [{ type: Number, min: 0, max: 6 }], // 0=Dom, 6=Sab
  },
}, {
  collection: 'empleados',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

esquemaEmpleado.virtual('nombreCompleto').get(function () {
  return `${this.nombres} ${this.apellidos}`;
});

esquemaEmpleado.virtual('diasVacacionesAcumulados').get(function () {
  if (!this.fechaIngreso) return 0;
  const years = (Date.now() - this.fechaIngreso.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return Math.floor(years) * 30; // D.L. 713: 30 días por año
});

esquemaEmpleado.index({ tipoProfesional: 1, estado: 1 });
esquemaEmpleado.index({ localActual: 1, estado: 1 });
esquemaEmpleado.index({ apellidos: 1, nombres: 1 });

module.exports = mongoose.model('Empleado', esquemaEmpleado);
