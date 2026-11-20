/**
 * Límite de peticiones por dirección IP, en memoria.
 *
 * El bloqueo de cuenta tras cinco intentos protege a una cuenta; no protege
 * de quien prueba una misma contraseña contra cuatrocientos correos, que es
 * como se ataca un sistema con una contraseña inicial común. Esto acota
 * cuántos intentos puede hacer una misma IP en una ventana de tiempo.
 *
 * Vive en la memoria del proceso: basta para un servidor. Con varias
 * instancias detrás de un balanceador, cada una cuenta por su lado; ahí el
 * límite se pone en el proxy (nginx `limit_req`) o en un almacén compartido.
 *
 * @param {object} opciones
 * @param {number} opciones.ventanaMs  duración de la ventana
 * @param {number} opciones.maximo     peticiones permitidas por ventana
 * @param {string} opciones.mensaje    texto de la respuesta 429
 */
function limitador({ ventanaMs, maximo, mensaje }) {
  const conteos = new Map();   // ip -> { n, desde }

  // Limpieza periódica para que el mapa no crezca sin fin
  const limpieza = setInterval(() => {
    const ahora = Date.now();
    for (const [ip, c] of conteos) if (ahora - c.desde > ventanaMs) conteos.delete(ip);
  }, ventanaMs);
  limpieza.unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
    const ahora = Date.now();
    let c = conteos.get(ip);
    if (!c || ahora - c.desde > ventanaMs) {
      c = { n: 0, desde: ahora };
      conteos.set(ip, c);
    }
    c.n += 1;
    if (c.n > maximo) {
      const reintentarEn = Math.ceil((c.desde + ventanaMs - ahora) / 1000);
      res.set('Retry-After', String(reintentarEn));
      return res.status(429).json({ error: mensaje, reintentarEnSegundos: reintentarEn });
    }
    next();
  };
}

module.exports = { limitador };
