/**
 * Fija la zona horaria del proceso antes que nada.
 *
 * El sistema razona en días laborales peruanos: la marca de asistencia, el
 * turno que toca, los días remunerados del período. Todo eso depende de qué
 * día cree el proceso que es.
 *
 * Casi todos los servidores en la nube arrancan en UTC. Allí, un técnico que
 * marca entrada a las 22:00 del 29 de agosto queda registrado el 30, y el
 * sistema le busca el turno de un día que no le toca. Como el turno TARDE
 * termina a las 22:00 y el NOCHE va de 22:00 a 06:00, eso no es un caso
 * extremo: es todo el segundo y tercer turno, cada día.
 *
 * Por eso la zona no se hereda del servidor: se declara y se impone. Este
 * módulo debe cargarse ANTES que cualquier otro, porque Node fija la zona la
 * primera vez que se construye una fecha y después ya no la relee.
 *
 * Se lee de ZONA_HORARIA y no de TZ a propósito. `dotenv` no pisa una variable
 * que ya venga del entorno, y los servidores en la nube definen TZ=UTC: si se
 * leyera TZ, el alojamiento ganaría al archivo de configuración y volveríamos
 * al problema. ZONA_HORARIA es una decisión de la aplicación; TZ es un
 * accidente de dónde se ejecute.
 */

const POR_DEFECTO = 'America/Lima';

/** Comprueba que el sistema conozca esa zona antes de imponerla */
function zonaValida(zona) {
  try {
    Intl.DateTimeFormat('es-PE', { timeZone: zona }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Desfase real de la zona respecto de UTC, en horas */
function desfaseHoras(zona = process.env.ZONA_HORARIA || POR_DEFECTO) {
  const ahora = new Date();
  const enZona = new Date(ahora.toLocaleString('en-US', { timeZone: zona }));
  const enUTC = new Date(ahora.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((enZona - enUTC) / 3600000);
}

/**
 * Impone la zona horaria del proceso.
 * Devuelve qué se hizo, para que el arranque lo pueda registrar.
 */
function fijarZonaHoraria(deseada = process.env.ZONA_HORARIA || POR_DEFECTO) {
  const heredada = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!zonaValida(deseada)) {
    console.error(`\n  La zona horaria «${deseada}» no existe en este sistema.`);
    console.error(`  Se usará ${POR_DEFECTO}. Revise la variable ZONA_HORARIA.\n`);
    deseada = POR_DEFECTO;
  }

  process.env.TZ = deseada;

  // Node relee TZ al construir la siguiente fecha; esto lo fuerza
  new Date().getTimezoneOffset();

  const efectiva = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    heredada,
    solicitada: deseada,
    efectiva,
    // Si el proceso no aceptó el cambio hay que saberlo, no suponerlo
    aplicada: efectiva === deseada || desfaseHoras(deseada) === -new Date().getTimezoneOffset() / 60,
    desfase: desfaseHoras(deseada),
  };
}

module.exports = { fijarZonaHoraria, zonaValida, desfaseHoras, POR_DEFECTO };
