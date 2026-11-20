/**
 * Formatos comerciales de botica y su dotación mínima por turno.
 *
 * La cantidad de personas por turno varía drásticamente según el tamaño del
 * local: una botica Express opera con un Químico Farmacéutico y un Técnico,
 * mientras que un Flagship mantiene todos los puestos en simultáneo.
 *
 * Reglas de sustitución (recogidas de la operación real):
 *  · En formatos pequeños el Químico Farmacéutico absorbe las funciones
 *    administrativas, por lo que no se exige Administrador de Botica.
 *  · En formatos pequeños y en el turno de madrugada, el Técnico en Farmacia
 *    también ejerce la función de cobro.
 *  · El Técnico en Entrenamiento no cubre dotación por sí solo: requiere la
 *    presencia de un QF o de un técnico titulado en el mismo turno.
 */

// ─── Puestos que se cubren en un turno ───────────────────────────────────────
const SHIFT_ROLES = {
  QF:             { etiqueta: 'Químico Farmacéutico', legal: true,  order: 1 },
  QF_ASISTENTE:   { etiqueta: 'QF Asistente',         legal: false, order: 2 },
  ADMIN_BOTICA:   { etiqueta: 'Administrador',        legal: false, order: 3 },
  TECNICO:        { etiqueta: 'Técnico en Farmacia',  legal: false, order: 4 },
  TRAINEE:        { etiqueta: 'Trainee',              legal: false, order: 5, supervised: true },
  CAJERO:         { etiqueta: 'Cajero',               legal: false, order: 6 },
  DERMOCONSULTOR: { etiqueta: 'Dermoconsultora',      legal: false, order: 7 },
  AUX_ALMACEN:    { etiqueta: 'Auxiliar de Almacén',  legal: false, order: 8 },
  PREVENCIONISTA: { etiqueta: 'Prevencionista',       legal: false, order: 9 },
  MOTORIZADO:     { etiqueta: 'Motorizado',           legal: false, order: 10 },

  // Puestos del centro de distribución
  COORD_RUTAS:    { etiqueta: 'Coordinador de Rutas',    legal: false, order: 11 },
  OPERARIO_CEDI:  { etiqueta: 'Operario de Almacén',     legal: false, order: 12 },
};

const SHIFT_ROLE_CODES = Object.keys(SHIFT_ROLES);

/**
 * Sustituciones estructurales: válidas en todo formato.
 * El Químico Farmacéutico Asistente existe justamente para cubrir el horario
 * completo de la botica junto al Director Técnico.
 */
const CORE_SUBSTITUTIONS = {
  QF: ['QF_ASISTENTE'],
};

/**
 * Sustituciones por polivalencia: sólo en formatos que las admiten.
 * En boticas pequeñas y en turnos de madrugada el Técnico en Farmacia también
 * ejerce la función de cobro; en un Flagship cada puesto tiene titular propio.
 */
const FLEXIBLE_SUBSTITUTIONS = {
  CAJERO: ['TECNICO'],
  AUX_ALMACEN: ['TECNICO'],
  OPERARIO_CEDI: ['COORD_RUTAS'],
};

/** Tabla de sustituciones vigente para un formato */
function substitutionsFor(fmt) {
  return fmt?.allowSubstitution
    ? { ...CORE_SUBSTITUTIONS, ...FLEXIBLE_SUBSTITUTIONS }
    : { ...CORE_SUBSTITUTIONS };
}

// ─── Formatos ────────────────────────────────────────────────────────────────
const FORMATS = {
  EXPRESS: {
    etiqueta: 'Express',
    descripcion: 'Botica compacta. Opera con dotación mínima y alta rotación.',
    shiftTypes: ['MANANA', 'TARDE'],
    roster: { QF: 1, TECNICO: 1 },
    allowSubstitution: true,
    requiresAdmin: false,                  // el QF asume la administración
    maxTraineesPerShift: 1,
  },
  ESTANDAR: {
    etiqueta: 'Estándar',
    descripcion: 'Formato mayoritario de la cadena. Incluye caja y apoyo dedicados.',
    shiftTypes: ['MANANA', 'TARDE'],
    roster: { QF: 1, TECNICO: 2, CAJERO: 1 },
    allowSubstitution: true,
    requiresAdmin: true,
    maxTraineesPerShift: 1,
  },
  FLAGSHIP: {
    etiqueta: 'Flagship',
    descripcion: 'Sede principal. Todos los puestos operando en simultáneo.',
    shiftTypes: ['MANANA', 'TARDE'],
    roster: { QF: 1, TECNICO: 3, CAJERO: 1, DERMOCONSULTOR: 1, AUX_ALMACEN: 1, PREVENCIONISTA: 1, MOTORIZADO: 1 },
    allowSubstitution: false,              // cada puesto tiene titular propio
    requiresAdmin: true,
    maxTraineesPerShift: 2,
  },
  CEDI: {
    etiqueta: 'Centro de Distribución',
    descripcion: 'Almacén central. Opera por turnos de picking, packing y despacho.',
    shiftTypes: ['MANANA', 'TARDE'],
    roster: { OPERARIO_CEDI: 2, COORD_RUTAS: 1 },
    allowSubstitution: true,
    requiresAdmin: true,
    maxTraineesPerShift: 1,
    esLogistico: true,          // no dispensa medicamentos: sin exigencia de QF
  },
  H24: {
    etiqueta: '24 horas',
    descripcion: 'Atención continua. Requiere tres turnos y cobertura de madrugada.',
    shiftTypes: ['MANANA', 'TARDE', 'NOCHE'],
    roster: { QF: 1, TECNICO: 2, CAJERO: 1, PREVENCIONISTA: 1 },
    // La madrugada opera con dotación reducida pero nunca sin QF ni vigilancia
    nightRoster: { QF: 1, TECNICO: 1, PREVENCIONISTA: 1 },
    allowSubstitution: true,
    requiresAdmin: true,
    // Los trainees refuerzan mañana y tarde; la madrugada se excluye en el
    // generador. Con 0 aquí no se programaban nunca en una botica 24 horas.
    maxTraineesPerShift: 1,
  },
};

// ─── Límites legales peruanos ────────────────────────────────────────────────
const LEGAL = {
  maxWeeklyHours: 48,          // jornada máxima semanal
  maxDailyHours: 8,
  minRestDaysPerWeek: 1,       // 24 horas continuas de descanso
  maxConsecutiveDays: 6,
};

/**
 * Dotación requerida para un turno concreto de un centro de trabajo.
 * `local.dotacionRequerida` prevalece sobre el formato cuando trae valores.
 */
function requiredRoster(local, tipoTurno) {
  const fmt = formatOf(local);
  const base = tipoTurno === 'NOCHE' && fmt.nightRoster ? fmt.nightRoster : fmt.roster;
  const roster = { ...base };

  // Los valores explícitos del local sustituyen a los del formato. El mapa está
  // expresado en puestos de botica, así que no aplica a un centro logístico.
  const rs = fmt.esLogistico ? null : local?.dotacionRequerida;
  if (rs) {
    const MAP = {
      QF: rs.qfPorTurno, TECNICO: rs.tecnicosPorTurno, CAJERO: rs.cajerosPorTurno,
      DERMOCONSULTOR: rs.dermoPorTurno, AUX_ALMACEN: rs.almacenPorTurno,
      PREVENCIONISTA: rs.seguridadPorTurno, MOTORIZADO: rs.repartidoresPorTurno,
    };
    for (const [rol, value] of Object.entries(MAP)) {
      if (value == null) continue;
      // En madrugada el formato manda: nunca se amplía la dotación nocturna
      if (tipoTurno === 'NOCHE' && fmt.nightRoster) {
        if (fmt.nightRoster[rol] != null) roster[rol] = Math.min(value, fmt.nightRoster[rol]);
        continue;
      }
      if (value > 0) roster[rol] = value;
      else delete roster[rol];
    }
  }

  // El Administrador de Botica es un puesto del local, no de cada turno: cubre
  // horario comercial y no forma parte de la dotación turno a turno. En los
  // formatos pequeños ni siquiera existe — el QF absorbe sus funciones.

  // El QF es obligatorio por norma DIGEMID en todo horario de atención al
  // público. Un centro logístico no dispensa medicamentos: no le aplica.
  if (!fmt.esLogistico) roster.QF = Math.max(1, roster.QF || 0);
  else delete roster.QF;

  return roster;
}

/**
 * Dotación semanal mínima que necesita un centro de trabajo para cubrir todos
 * sus turnos sin vulnerar la jornada máxima (48 h) ni el descanso semanal.
 */
function weeklyStaffNeed(local) {
  const tipos = shiftTypesOf(local);
  const maxShiftsPerPerson = Math.min(
    LEGAL.maxConsecutiveDays,
    Math.floor(LEGAL.maxWeeklyHours / LEGAL.maxDailyHours)
  );

  const perRole = {};
  for (const tipoTurno of tipos) {
    for (const [rol, count] of Object.entries(requiredRoster(local, tipoTurno))) {
      perRole[rol] = (perRole[rol] || 0) + count * 7;   // turnos-persona por semana
    }
  }

  return Object.fromEntries(
    Object.entries(perRole).map(([rol, shiftsNeeded]) => [
      rol, { shiftsPerWeek: shiftsNeeded, minStaff: Math.ceil(shiftsNeeded / maxShiftsPerPerson) },
    ])
  );
}

/** Turnos que opera el centro de trabajo según su formato */
function shiftTypesOf(local) {
  const fmt = formatOf(local);
  // Un local puede declarar sus propios turnos; si no, manda el formato
  const declared = local?.turnos?.tipos;
  return declared?.length ? declared : fmt.shiftTypes;
}

function formatOf(local) {
  // Un centro de distribución opera con su propio patrón aunque arrastre en el
  // campo `formato` un valor de botica de una carga anterior
  if (local?.tipo === 'CEDI') return FORMATS.CEDI;
  return FORMATS[local?.formato] || FORMATS.ESTANDAR;
}

module.exports = {
  SHIFT_ROLES, SHIFT_ROLE_CODES, FORMATS, LEGAL,
  CORE_SUBSTITUTIONS, FLEXIBLE_SUBSTITUTIONS, substitutionsFor,
  requiredRoster, shiftTypesOf, formatOf, weeklyStaffNeed,
};
