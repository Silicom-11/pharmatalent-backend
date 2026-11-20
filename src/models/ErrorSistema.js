const mongoose = require('mongoose');
const { DIAS_REGISTRO_ERRORES } = require('../config/mantenimiento');

/**
 * Los errores inesperados del servidor: el monitoreo del mantenimiento correctivo.
 *
 * Antes sólo quedaban en la consola, y la consola se pierde al reiniciar. Aquí
 * cada uno se guarda con su código de incidencia —el mismo que ve el usuario—
 * para que soporte lo encuentre cuando alguien lo comunique, y para que el
 * administrador vea qué ruta falla y cuántas veces.
 *
 * Mantenimiento preventivo: el índice TTL los borra a los 90 días. Un registro
 * de errores sin caducidad termina llenando el disco del servidor.
 */
const esquemaErrorSistema = new mongoose.Schema({
  incidencia: { type: String, required: true, index: true },
  metodo: String,
  ruta: String,
  mensaje: String,
  pila: String,
  usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  rol: String,
  atendido: { type: Boolean, default: false },
  mantenimiento: { type: mongoose.Schema.Types.ObjectId, ref: 'Mantenimiento' },
  creadoEn: { type: Date, default: Date.now, expires: DIAS_REGISTRO_ERRORES * 86400 },
}, { collection: 'errores_sistema' });

module.exports = mongoose.model('ErrorSistema', esquemaErrorSistema);
