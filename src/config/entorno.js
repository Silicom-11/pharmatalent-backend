/**
 * Comprobación del entorno antes de aceptar tráfico.
 *
 * Un servidor que arranca con la configuración incompleta falla más tarde y
 * peor: con JWT_SECRET vacío, `jwt.sign` revienta en el primer login y con un
 * secreto de juguete cualquiera puede firmarse un token de administrador. Se
 * prefiere no arrancar antes que arrancar mal.
 */

const SECRETOS_DE_EJEMPLO = [
  'secret', 'changeme', 'cambiar', 'jwt_secret', 'mi_secreto',
  'pharmatalent', 'supersecret', 'clave', '123456',
];

const LONGITUD_MINIMA_SECRETO = 32;

function revisarEntorno(env = process.env) {
  const produccion = env.NODE_ENV === 'production';
  const errores = [];
  const avisos = [];

  if (!env.MONGODB_URI) {
    errores.push('MONGODB_URI no está definida: no hay a dónde conectarse.');
  }

  const secreto = env.JWT_SECRET || '';
  if (!secreto) {
    errores.push('JWT_SECRET no está definida: las sesiones no se pueden firmar.');
  } else {
    const debil = SECRETOS_DE_EJEMPLO.some((s) => secreto.toLowerCase().includes(s));
    const corto = secreto.length < LONGITUD_MINIMA_SECRETO;
    if (debil || corto) {
      const motivo = corto
        ? `tiene ${secreto.length} caracteres y se piden ${LONGITUD_MINIMA_SECRETO}`
        : 'contiene una palabra de ejemplo';
      // En producción un secreto adivinable equivale a no tener autenticación
      const mensaje = `JWT_SECRET ${motivo}. Genérela con: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;
      (produccion ? errores : avisos).push(mensaje);
    }
  }

  if (!env.JWT_EXPIRES_IN) {
    avisos.push('JWT_EXPIRES_IN no está definida: se usará 8h.');
  }

  if (produccion && !env.CORS_ORIGINS) {
    errores.push('CORS_ORIGINS no está definida: en producción hay que declarar qué orígenes pueden llamar a la API.');
  }

  return { errores, avisos, produccion };
}

/** Corta el arranque si falta algo imprescindible */
function exigirEntorno(env = process.env, salida = console) {
  const { errores, avisos } = revisarEntorno(env);

  avisos.forEach((a) => salida.warn(`  aviso  ${a}`));

  if (errores.length) {
    salida.error('\nPharmaTalent no puede arrancar con esta configuración:\n');
    errores.forEach((e) => salida.error(`  · ${e}`));
    salida.error('\nRevise el archivo .env (hay una plantilla en .env.example).\n');
    process.exit(1);
  }

  return true;
}

/** Orígenes autorizados a llamar a la API */
function origenesPermitidos(env = process.env) {
  if (env.CORS_ORIGINS) {
    return env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  }
  // En desarrollo se asume el Vite local; en producción esto ya fue exigido arriba
  return ['http://localhost:3000', 'http://localhost:5173'];
}

module.exports = {
  revisarEntorno,
  exigirEntorno,
  origenesPermitidos,
  LONGITUD_MINIMA_SECRETO,
  SECRETOS_DE_EJEMPLO,
};
