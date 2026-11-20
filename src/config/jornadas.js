/**
 * Jornada de quien no trabaja por turnos, y quién no registra asistencia.
 *
 * El cronograma cubre las boticas y el CEDI. La sede no tiene turnos: tiene
 * horario de oficina. Antes el sistema no contemplaba ese caso y el personal de
 * sede no podía marcar en el terminal —«no tiene turno asignado»— ni ver su
 * jornada.
 *
 * Y no todos tienen que marcar. El D.S. 004-2006-TR (art. 1) exceptúa del
 * registro de control de asistencia al personal de dirección y a quien presta
 * servicios sin fiscalización inmediata: la Gerencia de RRHH dirige; el Jefe de
 * Zona y el Auditor de Calidad pasan la jornada recorriendo boticas. Exigirles
 * marcar en un terminal fijo sería registrar algo que no ocurre.
 */

const EXENTOS = {
  GERENTE_RRHH: 'Personal de dirección',
  JEFE_ZONA: 'Supervisión de campo, sin fiscalización inmediata',
  AUDITOR_CALIDAD: 'Auditoría de campo, sin fiscalización inmediata',
};

/** Horario de oficina de la sede corporativa: lunes a viernes */
const JORNADA_ADMINISTRATIVA = { dias: [1, 2, 3, 4, 5], inicio: '08:30', fin: '17:30' };

const ROLES_CON_JORNADA = ['ADMIN', 'ANALISTA_NOMINAS', 'ANALISTA_SELECCION', 'ANALISTA_CAPACITACION', 'GESTOR_BIENESTAR'];

/** Motivo de la exención, o null si el rol registra asistencia */
const exencionDe = (rol) => EXENTOS[rol] || null;

/**
 * La jornada de un día para quien trabaja con horario fijo, con la misma forma
 * que un turno para que el resto del código no tenga que distinguirlos.
 */
function jornadaDe(rol, fecha) {
  if (!ROLES_CON_JORNADA.includes(rol)) return null;
  if (!JORNADA_ADMINISTRATIVA.dias.includes(new Date(fecha).getDay())) return null;
  return { tipoTurno: 'JORNADA', horaInicio: JORNADA_ADMINISTRATIVA.inicio, horaFin: JORNADA_ADMINISTRATIVA.fin };
}

module.exports = { EXENTOS, JORNADA_ADMINISTRATIVA, ROLES_CON_JORNADA, exencionDe, jornadaDe };
