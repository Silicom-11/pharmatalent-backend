const mongoose = require('mongoose');

const esquemaKpi = new mongoose.Schema({
  nombre: { type: String, required: true },
  descripcion: String,
  meta: { type: Number, required: true },
  real: { type: Number, default: 0 },
  peso: { type: Number, required: true, min: 0, max: 100 },
  puntaje: { type: Number, default: 0 },
  unidad: { type: String, default: '%' },
}, { _id: false });

const esquemaEvaluacion = new mongoose.Schema({
  empleado: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  evaluador: { type: mongoose.Schema.Types.ObjectId, ref: 'Empleado', required: true },
  periodo: {
    nombre: String, // e.g. "2026-Q3"
    fechaInicio: { type: Date, required: true },
    fechaFin: { type: Date, required: true },
  },
  kpis: [esquemaKpi],
  puntajeGlobal: { type: Number, min: 0, max: 100 },
  calificacionCualitativa: {
    type: String,
    enum: ['EXCELENTE', 'MUY_BUENO', 'BUENO', 'REGULAR', 'DEFICIENTE'],
  },
  fortalezas: String,
  areasDeMejora: String,
  comentarios: String,
  estado: {
    type: String,
    enum: ['BORRADOR', 'ENVIADO', 'REVISADO', 'FIRMADO'],
    default: 'BORRADOR',
  },
  /**
   * Recorrido de la evaluación.
   *
   * BORRADOR   el evaluador la está armando; sólo él la ve
   * ENVIADO    se comunicó al empleado y corre su plazo para responder
   * REVISADO   la jefatura superior la visó
   * FIRMADO    el empleado dejó constancia de que la conoció
   *
   * La firma no significa conformidad: puede firmar y dejar su desacuerdo por
   * escrito. Lo que acredita es que se le comunicó, y eso es lo que se exige
   * cuando la evaluación sustenta una decisión sobre su vínculo laboral.
   */
  enviadoEn: Date,
  enviadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  revisadoEn: Date,
  revisadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },

  firmadoPorEmpleado: { type: Boolean, default: false },
  firmadoEn: Date,
  /** Descargo del empleado, si lo hubiera */
  comentarioEmpleado: { type: String, maxlength: 2000 },
  empleadoConforme: { type: Boolean, default: true },
}, {
  /**
   * Bloqueo optimista.
   * El evaluador comunica, la jefatura visa y el evaluado firma:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'evaluaciones',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaEvaluacion.pre('save', function () {
  if (this.kpis.length > 0) {
    let totalWeight = 0;
    let weightedScore = 0;
    for (const kpi of this.kpis) {
      kpi.puntaje = kpi.meta > 0 ? Math.min((kpi.real / kpi.meta) * 100, 150) : 0;
      weightedScore += kpi.puntaje * (kpi.peso / 100);
      totalWeight += kpi.peso;
    }
    // Un indicador puede superar su meta (hasta 150 %), pero el puntaje global
    // es sobre 100: sin este tope, un buen trimestre fallaba al guardarse
    this.puntajeGlobal = totalWeight > 0 ? Math.min(100, Math.round(weightedScore)) : 0;

    if (this.puntajeGlobal >= 90) this.calificacionCualitativa = 'EXCELENTE';
    else if (this.puntajeGlobal >= 75) this.calificacionCualitativa = 'MUY_BUENO';
    else if (this.puntajeGlobal >= 60) this.calificacionCualitativa = 'BUENO';
    else if (this.puntajeGlobal >= 40) this.calificacionCualitativa = 'REGULAR';
    else this.calificacionCualitativa = 'DEFICIENTE';
  }
});

esquemaEvaluacion.index({ empleado: 1, 'periodo.fechaInicio': 1 });

module.exports = mongoose.model('Evaluacion', esquemaEvaluacion);
