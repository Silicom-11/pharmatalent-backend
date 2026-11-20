const crypto = require('node:crypto');

/**
 * Recuperación de contraseña.
 *
 * Sin esto, quien olvida su clave un domingo por la noche en una botica de
 * Huancayo depende de que alguien de Recursos Humanos, en Lima, se la
 * restablezca el lunes. Con el sistema gobernando su marca de asistencia, eso
 * significa que ese día no puede marcar.
 *
 * El diseño tiene dos particularidades deliberadas:
 *
 * 1. **El código se guarda cifrado.** Se almacena su huella, no el código. Si
 *    alguien lee la base de datos, no puede usarlo para entrar.
 *
 * 2. **La entrega es pluggable.** Hoy no hay servidor de correo configurado,
 *    así que la solicitud aparece en el panel de Recursos Humanos y se dicta
 *    por teléfono —que es como se resuelve de verdad en una botica—. El día
 *    que se configure SMTP, sólo cambia el canal de entrega.
 */

/** Vigencia corta: un código que dura un día es un código robado con tiempo */
const VIGENCIA_MINUTOS = 30;

/** Intentos de canje antes de invalidar el código */
const MAX_INTENTOS_CANJE = 5;

/** Solicitudes por cuenta en la ventana, para que no se use como acoso */
const MAX_SOLICITUDES = 3;
const VENTANA_SOLICITUDES_MINUTOS = 60;

/**
 * Código de seis dígitos, generado sin sesgo.
 *
 * Seis dígitos porque se dicta por teléfono: unas credenciales que no se
 * pueden transmitir no sirven. La brevedad se compensa con la vigencia de 30
 * minutos y el corte a los 5 intentos, que dejan la probabilidad de acierto
 * por fuerza bruta en 5 entre un millón.
 */
function generarCodigo() {
  // rejection sampling: el módulo directo favorecería los dígitos bajos
  const LIMITE = Math.floor(0xffffffff / 1000000) * 1000000;
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= LIMITE);
  return String(n % 1000000).padStart(6, '0');
}

/** Huella del código, que es lo único que se guarda */
function huella(codigo) {
  return crypto.createHash('sha256').update(String(codigo)).digest('hex');
}

/** Comparación en tiempo constante, para no filtrar el código por el reloj */
function coincide(codigo, huellaGuardada) {
  if (!codigo || !huellaGuardada) return false;
  const a = Buffer.from(huella(codigo), 'hex');
  const b = Buffer.from(String(huellaGuardada), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Prepara una solicitud de recuperación */
function nuevaSolicitud() {
  const codigo = generarCodigo();
  return {
    codigo,                                  // se entrega una vez y no se guarda
    huella: huella(codigo),
    expiraEn: new Date(Date.now() + VIGENCIA_MINUTOS * 60000),
    intentos: 0,
    solicitadaEn: new Date(),
  };
}

/**
 * Comprueba si una solicitud sigue siendo canjeable.
 * Devuelve el motivo cuando no lo es, para poder decírselo a la persona.
 */
function estadoDeSolicitud(solicitud) {
  if (!solicitud?.huella) return { valida: false, motivo: 'No hay ninguna solicitud en curso' };
  if (solicitud.usadaEn) return { valida: false, motivo: 'Ese código ya fue utilizado' };
  if (new Date(solicitud.expiraEn) < new Date()) {
    return { valida: false, motivo: `El código caducó. Tiene ${VIGENCIA_MINUTOS} minutos para usarlo` };
  }
  if ((solicitud.intentos || 0) >= MAX_INTENTOS_CANJE) {
    return { valida: false, motivo: 'Demasiados intentos fallidos. Solicite un código nuevo' };
  }
  return { valida: true };
}

/** Minutos que le quedan de vida a un código */
function minutosRestantes(solicitud) {
  if (!solicitud?.expiraEn) return 0;
  return Math.max(0, Math.ceil((new Date(solicitud.expiraEn) - Date.now()) / 60000));
}

module.exports = {
  generarCodigo,
  huella,
  coincide,
  nuevaSolicitud,
  estadoDeSolicitud,
  minutosRestantes,
  VIGENCIA_MINUTOS,
  MAX_INTENTOS_CANJE,
  MAX_SOLICITUDES,
  VENTANA_SOLICITUDES_MINUTOS,
};
