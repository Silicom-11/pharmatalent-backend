const Asistencia = require('../models/Asistencia');
const Turno = require('../models/Turno');
const Local = require('../models/Local');
const { exencionDe, jornadaDe } = require('../config/jornadas');

/**
 * Registro de una marca de asistencia: entrada o salida, decidida por el
 * propio sistema según lo que la persona tenga abierto.
 *
 * Quien marca no elige «entrada» o «salida»: en el terminal de una botica,
 * con cola de gente, esa elección se equivoca. Si hay una jornada abierta, la
 * marca la cierra; si no, abre la del turno de hoy.
 *
 * El turno de noche (23:00 a 07:00) termina al día siguiente. La versión
 * anterior buscaba la jornada «de hoy» para registrar la salida y a las siete
 * de la mañana no la encontraba: quien cubría la noche no podía marcar salida.
 * Aquí la jornada abierta se busca hacia atrás, con un límite: una entrada de
 * hace más de dieciséis horas no es un turno en curso sino una salida olvidada,
 * y cerrarla con la marca de hoy inventaría una jornada de un día entero.
 */

const DIA = 86400000;
const JORNADA_MAXIMA_MS = 16 * 3600000;
const TOLERANCIA_MIN = 5;            // minutos de gracia en la entrada
const MARCA_REPETIDA_MS = 2 * 60000; // dos lecturas seguidas del mismo rostro

const inicioDelDia = (f = new Date()) => new Date(f.getFullYear(), f.getMonth(), f.getDate());

/** 'HH:MM' de un día concreto como fecha */
function aHora(dia, hhmm) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const d = new Date(dia);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** Turno asignado a una persona en una fecha */
function turnoDe(empleadoId, fecha) {
  const desde = inicioDelDia(fecha);
  return Turno.findOne({
    'asignaciones.empleado': empleadoId,
    fecha: { $gte: desde, $lt: new Date(desde.getTime() + DIA) },
  }).populate('local', 'nombre codigo marca');
}

/**
 * Registra la marca y devuelve qué pasó.
 *
 * @param {object} p
 * @param {object} p.empleado   documento de Empleado
 * @param {string} [p.rol]     rol de su cuenta: decide jornada fija o exención
 * @param {object} p.local      documento de Local donde se marca
 * @param {string} p.origen     TERMINAL | CORRECCION
 * @param {string} [p.metodo]   ROSTRO | HUELLA | DNI
 * @param {object} [p.correccion]  { por, motivo } cuando la registra la jefatura
 * @param {Date}   [p.ahora]    hora de la marca (por omisión, la del servidor)
 * @returns {{ ok, accion, record, turno, error, codigo }}
 */
async function registrarMarca({ empleado, local, rol, origen, metodo, correccion, ahora = new Date() }) {
  const abierta = await Asistencia.findOne({
    empleado: empleado._id,
    marcaEntrada: { $exists: true, $ne: null },
    $or: [{ marcaSalida: { $exists: false } }, { marcaSalida: null }],
    fecha: { $gte: new Date(inicioDelDia(ahora).getTime() - DIA) },
  }).sort({ marcaEntrada: -1 });

  // Dos lecturas seguidas no son entrada y salida: es la misma persona frente
  // al lector. Se devuelve la marca que ya existe sin tocar nada.
  const ultima = abierta?.marcaEntrada;
  if (ultima && ahora - ultima < MARCA_REPETIDA_MS) {
    return { ok: true, accion: 'REPETIDA', record: abierta };
  }

  // ── Salida ──────────────────────────────────────────────────────────────────
  if (abierta && ahora - abierta.marcaEntrada <= JORNADA_MAXIMA_MS) {
    // Mantenimiento correctivo MNT-2026-012: la salida se marca donde se marcó
    // la entrada. Antes, quien entraba en Mifarma Giráldez y pasaba por el
    // terminal de Inkafarma Huancayo Real quedaba con la salida registrada en
    // una botica en la que no trabajó. La jefatura sí puede corregirla desde
    // Asistencia (origen CORRECCION), con motivo.
    if (origen === 'TERMINAL' && abierta.local && String(abierta.local) !== String(local._id)) {
      const donde = await Local.findById(abierta.local).select('nombre').lean();
      return {
        ok: false, codigo: 'OTRO_LOCAL',
        error: `Su jornada de hoy está abierta en ${donde?.nombre || 'otro local'}: marque su salida allí.`,
      };
    }
    const turno = await turnoDe(empleado._id, abierta.fecha) || jornadaDe(rol, abierta.fecha);
    abierta.marcaSalida = ahora;
    if (turno) {
      let fin = aHora(abierta.fecha, turno.horaFin);
      if (fin <= aHora(abierta.fecha, turno.horaInicio)) fin = new Date(fin.getTime() + DIA);
      const extra = Math.round(((ahora - fin) / 3600000) * 100) / 100;
      abierta.horasExtra = extra > 0 ? extra : 0;
    }
    if (correccion) abierta.correccion = { ...correccion, en: new Date() };
    if (origen === 'CORRECCION') abierta.origen = 'CORRECCION';
    await abierta.save();
    return { ok: true, accion: 'SALIDA', record: abierta, turno };
  }

  // ── Entrada ─────────────────────────────────────────────────────────────────
  const hoy = inicioDelDia(ahora);
  const exencion = exencionDe(rol);
  if (exencion) {
    return {
      ok: false, codigo: 'EXENTO',
      error: `Su puesto no registra asistencia: ${exencion.toLowerCase()} (D.S. 004-2006-TR, art. 1).`,
    };
  }
  // Quien no trabaja por turnos tiene su jornada fija en su propio centro
  const fija = jornadaDe(rol, hoy);
  const turno = await turnoDe(empleado._id, hoy)
    || (fija && { ...fija, local: { _id: empleado.localActual?._id || empleado.localActual } });
  if (!turno) {
    return {
      ok: false, codigo: 'SIN_TURNO',
      error: 'No tiene turno asignado hoy. Si debe cubrir uno, su administrador lo registra en el cronograma.',
    };
  }
  if (String(turno.local?._id) !== String(local._id)) {
    return {
      ok: false, codigo: 'OTRO_LOCAL',
      error: `Su turno de hoy es en ${turno.local?.nombre || 'otro local'}: debe marcar allí.`,
    };
  }

  let record = await Asistencia.findOne({ empleado: empleado._id, fecha: hoy });
  if (record?.marcaEntrada && record?.marcaSalida) {
    return { ok: false, codigo: 'JORNADA_CERRADA', error: 'Ya registró su entrada y su salida de hoy.' };
  }
  if (!record) record = new Asistencia({ empleado: empleado._id, local: local._id, fecha: hoy });

  const tardanza = Math.floor((ahora - aHora(hoy, turno.horaInicio)) / 60000);
  record.marcaEntrada = ahora;
  record.minutosTardanza = tardanza > TOLERANCIA_MIN ? tardanza : 0;
  record.estado = record.minutosTardanza > 0 ? 'TARDANZA' : 'PRESENTE';
  record.origen = origen;
  if (metodo) record.metodo = metodo;
  if (correccion) record.correccion = { ...correccion, en: new Date() };
  await record.save();
  return { ok: true, accion: 'ENTRADA', record, turno };
}

module.exports = { DIA, inicioDelDia, aHora, turnoDe, registrarMarca, TOLERANCIA_MIN };
