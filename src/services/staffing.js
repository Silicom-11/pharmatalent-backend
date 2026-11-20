// La misma regla del modelo Turno, repetida aquí sin importar el modelo para
// que el motor siga siendo puro (sus pruebas no levantan la base)
const presenciaQF = (asignaciones = []) => {
  const conteoQF = asignaciones.filter((x) => ['QF', 'QF_ASISTENTE'].includes(x.rol)).length;
  return { conteoQF, tieneQF: conteoQF > 0 };
};

const {
  SHIFT_ROLES, LEGAL, substitutionsFor, requiredRoster, shiftTypesOf, formatOf,
} = require('../config/formats');

/**
 * Motor de dotación de turnos.
 *
 * Traduce el formato comercial del local a una dotación por turno, evalúa la
 * cobertura real de cada turno y genera cronogramas semanales respetando los
 * límites de jornada de la legislación peruana.
 */

// ─── Correspondencia empleado → puesto de turno ──────────────────────────────
const TYPE_FALLBACK = {
  QF: 'QF', TECNICO: 'TECNICO', OPERARIO: 'CAJERO',
  JEFE_LOCAL: 'ADMIN_BOTICA', ADMINISTRATIVO: 'ADMIN_BOTICA', GERENCIA: 'ADMIN_BOTICA',
};

/**
 * El puesto del sistema no siempre es un puesto de turno: el Jefe de CEDI
 * dirige el centro igual que el Administrador dirige la botica, y ninguno de
 * los dos cubre dotación turno a turno.
 */
const ROLES_DE_CENTRO = { JEFE_CEDI: 'ADMIN_BOTICA' };

/** Puesto que ocupa el empleado dentro de un turno */
function shiftRoleOf(empleado) {
  if (empleado?.esPracticante) return 'TRAINEE';
  const pos = empleado?.cargoActual;
  const fromPosition = typeof pos === 'object' ? pos?.rolPorDefecto : null;
  if (fromPosition && SHIFT_ROLES[fromPosition]) return fromPosition;
  if (fromPosition && ROLES_DE_CENTRO[fromPosition]) return ROLES_DE_CENTRO[fromPosition];
  return TYPE_FALLBACK[empleado?.tipoProfesional] || 'TECNICO';
}

/**
 * Puestos que este empleado puede cubrir en un turno, según las
 * sustituciones que admita el formato del local.
 */
function coverableRoles(empleado, fmt) {
  const own = shiftRoleOf(empleado);
  const roles = [own];
  for (const [meta, sources] of Object.entries(substitutionsFor(fmt))) {
    if (sources.includes(own)) roles.push(meta);
  }
  return roles;
}

// ─── Evaluación de cobertura ─────────────────────────────────────────────────
/**
 * Compara la dotación asignada con la requerida por el formato.
 *
 * @param {Array}  assignments  [{ employee, role }] — employee poblado o no
 * @param {Object} location     centro de trabajo con format y requiredStaff
 * @param {String} shiftType    MANANA | TARDE | NOCHE
 * @returns {{ roles, conflicts, isCompliant, severity, coveragePct }}
 */
function evaluateCoverage(asignaciones = [], local, tipoTurno) {
  const fmt = formatOf(local);
  const requerido = requiredRoster(local, tipoTurno);

  // Cuenta por puesto declarado en la asignación
  const asignados = {};
  for (const a of asignaciones) {
    asignados[a.rol] = (asignados[a.rol] || 0) + 1;
  }

  // Personal ya prestado a otro puesto — no puede contarse dos veces
  const usedAsSubstitute = {};

  // El trainee no cubre dotación de técnico por sí solo
  const traineeCount = asignados.TRAINEE || 0;
  const autonomousStaff = asignaciones.filter((a) => a.rol !== 'TRAINEE').length;

  const roles = [];
  const conflictos = [];
  const subs = substitutionsFor(fmt);
  let sustitucionesUsadas = 0;

  for (const [rol, need] of Object.entries(requerido)) {
    let have = asignados[rol] || 0;
    let sustituidos = 0;

    // Cubre el faltante con puestos habilitados a sustituir
    if (have < need && subs[rol]) {
      for (const origen of subs[rol]) {
        if (have >= need) break;
        // Sólo se puede prestar personal que exceda su propio requerimiento
        const spare = Math.max(0, (asignados[origen] || 0) - (requerido[origen] || 0) - (usedAsSubstitute[origen] || 0));
        const take = Math.min(spare, need - have);
        if (take > 0) {
          have += take;
          sustituidos += take;
          usedAsSubstitute[origen] = (usedAsSubstitute[origen] || 0) + take;
        }
      }
      sustitucionesUsadas += sustituidos;
    }

    const brecha = need - have;
    const meta = SHIFT_ROLES[rol] || {};
    roles.push({
      rol,
      etiqueta: meta.etiqueta || rol,
      requerido: need,
      asignados: asignados[rol] || 0,
      sustituidos,
      cubierto: brecha <= 0,
      brecha: Math.max(0, brecha),
      legal: !!meta.legal,
    });

    if (brecha > 0) {
      conflictos.push({
        rol,
        severidad: meta.legal ? 'CRITICA' : rol === 'TECNICO' ? 'MAYOR' : 'MENOR',
        hallazgo: meta.legal
          ? `Turno sin ${meta.etiqueta}: el local no puede operar sin Director Técnico (DIGEMID)`
          : `Faltan ${brecha} ${meta.etiqueta || rol} de ${need} requerido(s)`,
      });
    }
  }

  // Reglas propias del formato
  if (traineeCount > (fmt.maxTraineesPerShift ?? 1)) {
    conflictos.push({
      rol: 'TRAINEE',
      severidad: 'MENOR',
      hallazgo: `El formato ${fmt.etiqueta} admite como máximo ${fmt.maxTraineesPerShift} trainee(s) por turno`,
    });
  }
  if (traineeCount > 0 && autonomousStaff === 0) {
    conflictos.push({
      rol: 'TRAINEE',
      severidad: 'MAYOR',
      hallazgo: 'El Técnico en Entrenamiento requiere supervisión de personal titulado en el mismo turno',
    });
  }

  const totalRequired = Object.values(requerido).reduce((a, n) => a + n, 0);
  const totalCovered = roles.reduce((a, r) => a + Math.min(r.requerido, r.requerido - r.brecha), 0);

  const severidad = conflictos.some((c) => c.severidad === 'CRITICA') ? 'CRITICA'
    : conflictos.some((c) => c.severidad === 'MAYOR') ? 'MAYOR'
      : conflictos.length ? 'MENOR' : null;

  return {
    roles: roles.sort((a, b) => (SHIFT_ROLES[a.rol]?.order || 99) - (SHIFT_ROLES[b.rol]?.order || 99)),
    conflictos,
    cumpleNormativa: conflictos.length === 0,
    hasLegalGap: conflictos.some((c) => c.severidad === 'CRITICA'),
    severidad,
    sustitucionesUsadas,
    porcentajeCobertura: totalRequired ? Math.round((totalCovered / totalRequired) * 100) : 100,
  };
}

// ─── Generación del cronograma semanal ───────────────────────────────────────
const hoursBetween = (inicio, fin) => {
  const [sh, sm] = inicio.split(':').map(Number);
  const [eh, em] = fin.split(':').map(Number);
  let h = (eh + em / 60) - (sh + sm / 60);
  if (h < 0) h += 24;              // turno que cruza la medianoche
  return h;
};

/**
 * Construye los turnos de una semana repartiendo al personal disponible.
 *
 * Restricciones aplicadas:
 *  · Una sola asignación por persona y día
 *  · Tope de 48 horas semanales y 6 días consecutivos
 *  · Al menos un día de descanso a la semana
 *  · Días no disponibles y turno preferido de cada empleado
 *  · El trainee sólo entra si el turno ya tiene personal titulado
 *
 * Se programa en dos pasadas. La primera cubre, día por día, la dotación que
 * exige el formato. La segunda suma refuerzos con la capacidad que sobra.
 * En una sola pasada, la QF asistente entraba de refuerzo cada mañana y el
 * sábado —cuando descansa la titular— ya había agotado sus seis días: el turno
 * se quedaba sin QF teniendo a quien lo cubriera.
 */
function generateWeek(local, staff, inicioSemana) {
  const fmt = formatOf(local);
  const tipos = shiftTypesOf(local);
  const inicio = new Date(inicioSemana);

  // Estado por empleado a lo largo de la semana
  const state = new Map(staff.map((e) => [
    String(e._id),
    { empleado: e, hours: 0, days: 0, lastDay: -2, streak: 0, rol: shiftRoleOf(e), dias: new Set() },
  ]));
  const asignadosDia = Array.from({ length: 7 }, () => new Set());

  const asignar = (st, d, duration) => {
    asignadosDia[d].add(String(st.empleado._id));
    st.hours += duration;
    st.days += 1;
    st.streak = st.lastDay === d - 1 ? st.streak + 1 : 1;
    st.lastDay = Math.max(st.lastDay, d);
    st.dias.add(d);
  };

  // ── Primera pasada: la dotación exigida ──────────────────────────────────────
  const plan = [];
  for (let d = 0; d < 7; d++) {
    const fecha = new Date(inicio);
    fecha.setDate(fecha.getDate() + d);
    const weekday = fecha.getDay();
    const assignedToday = asignadosDia[d];

    for (const tipoTurno of tipos) {
      const config = local.turnos?.horario?.[tipoTurno]
        || { inicio: tipoTurno === 'NOCHE' ? '23:00' : tipoTurno === 'TARDE' ? '15:00' : '08:00',
             fin: tipoTurno === 'NOCHE' ? '07:00' : tipoTurno === 'TARDE' ? '23:00' : '15:00' };
      const duration = hoursBetween(config.inicio, config.fin);
      const roster = requiredRoster(local, tipoTurno);
      const asignaciones = [];

      // Se cubre primero lo obligatorio por ley, luego el resto por prioridad
      const ordered = Object.entries(roster)
        .sort(([a], [b]) => (SHIFT_ROLES[a]?.order || 99) - (SHIFT_ROLES[b]?.order || 99));

      for (const [rol, need] of ordered) {
        for (let n = 0; n < need; n++) {
          const candidate = pickCandidate({
            rol, state, assignedToday, weekday, tipoTurno, duration, dayIndex: d, fmt,
          });
          if (!candidate) break;
          asignaciones.push({ empleado: candidate.empleado._id, rol });
          asignar(candidate, d, duration);
        }
      }

      // Los trainees se suman como refuerzo si el turno ya tiene titulares
      const traineeCap = fmt.maxTraineesPerShift ?? 1;
      // Los trainees no cubren madrugada: el tope del formato vale para el día
      if (traineeCap > 0 && asignaciones.length > 0 && tipoTurno !== 'NOCHE') {
        let added = 0;
        for (const st of state.values()) {
          if (added >= traineeCap) break;
          if (st.rol !== 'TRAINEE') continue;
          if (assignedToday.has(String(st.empleado._id))) continue;
          if (!isAvailable(st, weekday, duration, d)) continue;
          asignaciones.push({ empleado: st.empleado._id, rol: 'TRAINEE' });
          asignar(st, d, duration);
          added++;
        }
      }

      plan.push({ d, fecha, weekday, tipoTurno, config, duration, roster, asignaciones });
    }
  }

  // ── Segunda pasada: refuerzos ────────────────────────────────────────────────
  // Personal cuyo puesto este formato no exige en cada turno —el Administrador,
  // una dermoconsultora en una botica estándar, el motorizado de un local con
  // reparto propio, la QF asistente donde basta una QF— trabaja igual. Sin esta
  // pasada el motor nunca los programaba: no tenían horario que consultar y el
  // terminal les rechazaba la marca por «no tener turno».
  // Uno por puesto y turno, con los mismos topes de ley. No cuentan para la
  // cobertura exigida: son personal adicional, no dotación.
  for (const p of plan) {
    const requeridos = new Set(Object.keys(p.roster));
    const reforzado = new Set();
    const assignedToday = asignadosDia[p.d];
    for (const st of state.values()) {
      if (st.rol === 'TRAINEE' || requeridos.has(st.rol) || reforzado.has(st.rol)) continue;
      if (assignedToday.has(String(st.empleado._id))) continue;
      if (st.hours + p.duration > LEGAL.maxWeeklyHours) continue;
      if (st.days >= 7 - LEGAL.minRestDaysPerWeek) continue;
      if (st.empleado.preferenciasTurno?.diasNoDisponibles?.includes(p.weekday)) continue;
      if (st.empleado.estado !== 'ACTIVO') continue;
      if (rachaCon(st.dias, p.d) > LEGAL.maxConsecutiveDays) continue;
      // La jefatura del local cubre el día, no la madrugada
      if (p.tipoTurno === 'NOCHE' && st.rol === 'ADMIN_BOTICA') continue;
      // Quien prefiere otro turno del local espera a ese
      const pref = st.empleado.preferenciasTurno?.turnoPreferido;
      if (pref && pref !== 'CUALQUIERA' && pref !== p.tipoTurno && tipos.includes(pref)) continue;
      p.asignaciones.push({ empleado: st.empleado._id, rol: st.rol });
      asignar(st, p.d, p.duration);
      reforzado.add(st.rol);
    }
  }

  return plan.map((p) => {
    const cobertura = evaluateCoverage(p.asignaciones, local, p.tipoTurno);
    return {
      local: local._id,
      fecha: p.fecha,
      tipoTurno: p.tipoTurno,
      horaInicio: p.config.inicio,
      horaFin: p.config.fin,
      asignaciones: p.asignaciones,
      // Calculado aquí y no sólo en el hook: los turnos se insertan en lote
      ...presenciaQF(p.asignaciones),
      cobertura: {
        roles: cobertura.roles,
        porcentajeCobertura: cobertura.porcentajeCobertura,
        sustitucionesUsadas: cobertura.sustitucionesUsadas,
        severidad: cobertura.severidad,
      },
      cumpleNormativa: cobertura.cumpleNormativa,
      conflictos: cobertura.conflictos,
    };
  });
}

/** Días seguidos que sumaría trabajar el día `d`, dados los ya asignados */
function rachaCon(dias, d) {
  let n = 1;
  for (let i = d - 1; dias.has(i); i--) n++;
  for (let i = d + 1; dias.has(i); i++) n++;
  return n;
}

/** ¿Puede este empleado tomar un turno más? */
function isAvailable(st, weekday, duration, dayIndex) {
  if (st.hours + duration > LEGAL.maxWeeklyHours) return false;
  if (st.days >= 7 - LEGAL.minRestDaysPerWeek) return false;
  if (st.lastDay === dayIndex - 1 && st.streak >= LEGAL.maxConsecutiveDays) return false;
  if (st.empleado.preferenciasTurno?.diasNoDisponibles?.includes(weekday)) return false;
  if (st.empleado.estado !== 'ACTIVO') return false;
  return true;
}

/** Elige al empleado con menos carga que pueda cubrir el puesto */
function pickCandidate({ rol, state, assignedToday, weekday, tipoTurno, duration, dayIndex, fmt }) {
  const pool = [];

  for (const st of state.values()) {
    if (assignedToday.has(String(st.empleado._id))) continue;
    if (st.rol === 'TRAINEE') continue;               // los trainees se asignan aparte
    if (!isAvailable(st, weekday, duration, dayIndex)) continue;

    const roles = coverableRoles(st.empleado, fmt);
    if (!roles.includes(rol)) continue;

    // Prioriza a quien ocupa el puesto de forma titular y tiene menos horas
    const isOwnRole = st.rol === rol;
    const prefersShift = st.empleado.preferenciasTurno?.turnoPreferido;
    const preferenceBonus = prefersShift === tipoTurno ? -6
      : prefersShift && prefersShift !== 'CUALQUIERA' ? 3 : 0;

    pool.push({ st, puntaje: st.hours + (isOwnRole ? 0 : 24) + preferenceBonus });
  }

  if (!pool.length) return null;
  pool.sort((a, b) => a.puntaje - b.puntaje);
  return pool[0].st;
}

/** Resumen de validación de un cronograma completo */
function summarizeSchedule(shiftDocs) {
  const conflictos = [];
  for (const s of shiftDocs) {
    for (const c of s.conflictos || []) {
      conflictos.push({
        fecha: s.fecha,
        tipoTurno: s.tipoTurno,
        rol: c.rol,
        severidad: c.severidad,
        hallazgo: c.hallazgo,
      });
    }
  }
  const critical = conflictos.filter((c) => c.severidad === 'CRITICA');
  const totalPct = shiftDocs.length
    ? Math.round(shiftDocs.reduce((a, s) => a + (s.cobertura?.porcentajeCobertura ?? 0), 0) / shiftDocs.length)
    : 0;

  return {
    esValido: critical.length === 0,
    todosLosTurnosTienenQF: critical.length === 0,
    porcentajeCobertura: totalPct,
    conflictos,
    conteoCriticas: critical.length,
    conteoMayores: conflictos.filter((c) => c.severidad === 'MAYOR').length,
    conteoMenores: conflictos.filter((c) => c.severidad === 'MENOR').length,
    validadoEn: new Date(),
  };
}

module.exports = {
  shiftRoleOf, coverableRoles, evaluateCoverage,
  generateWeek, summarizeSchedule, hoursBetween,
};
