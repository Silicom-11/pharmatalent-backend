const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * El error inesperado queda guardado para el monitoreo (mantenimiento
 * correctivo, origen MONITOREO). Si la base no está, sólo queda en la consola:
 * registrar no puede convertirse en un segundo error.
 */
function registrarError(incidencia, req, err) {
  if (mongoose.connection.readyState !== 1) return;
  const ErrorSistema = require('../models/ErrorSistema');
  ErrorSistema.create({
    incidencia,
    metodo: req.method,
    ruta: String(req.originalUrl || '').split('?')[0].slice(0, 200),
    mensaje: String(err?.message || err).split(/\r?\n/)[0].slice(0, 300),
    pila: String(err?.stack || '').slice(0, 2000),
    usuario: req.usuario?._id,
    rol: req.usuario?.rol,
  }).catch(() => {});
}

/**
 * Traducción de fallos a respuestas.
 *
 * Los errores previstos (validación, duplicados, id mal formado) se explican al
 * usuario. Los imprevistos no: el mensaje de una excepción suele contener
 * nombres de colección, rutas del servidor o fragmentos de consulta, y eso es
 * material de reconocimiento para quien busca entrar. Se devuelve un código de
 * incidencia y el detalle queda en el registro del servidor.
 */

const errorHandler = (err, req, res, _next) => {
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: 'Error de validación', details: messages });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'campo';
    return res.status(409).json({ error: `El valor de '${field}' ya existe` });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'ID inválido' });
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  /**
   * Dos personas decidieron sobre lo mismo a la vez.
   *
   * El bloqueo optimista de Mongoose detecta que el registro cambió entre que
   * esta persona lo abrió y lo guardó. Antes, el segundo en guardar pisaba al
   * primero sin que nada avisara, y el registro quedaba con dos decisiones
   * opuestas y un solo estado. Es un 409, no un error: la operación es válida,
   * lo que ya no es válido es la versión sobre la que se tomó.
   */
  if (err.name === 'VersionError') {
    return res.status(409).json({
      error: 'Otra persona modificó este registro mientras usted lo tenía abierto. '
        + 'Vuelva a cargarlo para ver el estado actual antes de decidir.',
      conflicto: true,
    });
  }

  if (err.tipo === 'entity.too.large') {
    return res.status(413).json({ error: 'El contenido enviado es demasiado grande' });
  }

  // Los errores que la propia aplicación levanta a propósito sí se explican
  const esperado = err.statusCode && err.statusCode < 500;
  if (esperado) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Imprevisto: se etiqueta para poder rastrearlo sin exponer el interior
  const incidencia = crypto.randomBytes(4).toString('hex').toUpperCase();
  console.error(`[${incidencia}] ${req.method} ${req.originalUrl}`);
  console.error(err.stack || err);
  registrarError(incidencia, req, err);

  res.status(500).json({
    error: 'Ocurrió un error inesperado. Comunique el código de incidencia a soporte.',
    incidencia,
  });
};

module.exports = errorHandler;
module.exports.registrarError = registrarError;
