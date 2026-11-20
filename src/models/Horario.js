const mongoose = require('mongoose');

const esquemaHorario = new mongoose.Schema({
  local: { type: mongoose.Schema.Types.ObjectId, ref: 'Local', required: true },
  inicioSemana: { type: Date, required: true },
  finSemana: { type: Date, required: true },
  estado: {
    type: String,
    enum: ['BORRADOR', 'PUBLICADO', 'COMPLETADO'],
    default: 'BORRADOR',
  },
  validacion: {
    esValido: { type: Boolean, default: false },
    todosLosTurnosTienenQF: { type: Boolean, default: false },
    /** Porcentaje medio de cobertura frente a la dotación del formato */
    porcentajeCobertura: { type: Number, default: 0 },
    conteoCriticas: { type: Number, default: 0 },
    conteoMayores: { type: Number, default: 0 },
    conteoMenores: { type: Number, default: 0 },
    conflictos: [{
      fecha: Date,
      tipoTurno: String,
      rol: String,
      severidad: { type: String, enum: ['CRITICA', 'MAYOR', 'MENOR'] },
      hallazgo: String,
    }],
    validadoEn: Date,
  },
  /** Formato comercial vigente al generar el cronograma */
  formato: String,
  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  publicadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  publicadoEn: Date,
  notas: String,
}, {
  /**
   * Bloqueo optimista.
   * Editar turnos y publicar el horario ocurren en paralelo:
   * sin esto, el segundo en guardar pisa al primero en silencio y el
   * registro queda con dos decisiones opuestas y un solo estado.
   */
  optimisticConcurrency: true,
  collection: 'horarios',
  timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' } });

esquemaHorario.index({ local: 1, inicioSemana: 1 }, { unique: true });
esquemaHorario.index({ estado: 1 });

module.exports = mongoose.model('Horario', esquemaHorario);
