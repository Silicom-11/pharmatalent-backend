/**
 * Catálogo maestro de la estructura organizacional de InRetail Pharma
 * (Inkafarma / Mifarma - Farmacias Peruanas S.A.)
 *
 * Fuente única de verdad para:
 *  - Roles del sistema (autenticación)
 *  - Niveles organizacionales
 *  - Matriz de permisos por módulo
 *  - Alcance de datos (scope) de cada rol
 */

// ─── Niveles organizacionales ────────────────────────────────────────────────
const ORG_LEVELS = {
  CORPORATIVO: { codigo: 'CORPORATIVO', etiqueta: 'Sede Corporativa', short: 'Corporativo', order: 1 },
  ZONAL: { codigo: 'ZONAL', etiqueta: 'Supervisión Zonal', short: 'Zonal', order: 2 },
  CEDI: { codigo: 'CEDI', etiqueta: 'Centro de Distribución', short: 'CEDI', order: 3 },
  BOTICA: { codigo: 'BOTICA', etiqueta: 'Punto de Venta / Botica', short: 'Botica', order: 4 },
};

// ─── Alcance de datos ────────────────────────────────────────────────────────
// SELF     → solo su propia información
// LOCATION → su local / CEDI asignado
// ZONE     → todos los locales de su zona
// NATIONAL → toda la cadena
const SCOPES = { SELF: 'SELF', LOCATION: 'LOCATION', ZONE: 'ZONE', NATIONAL: 'NATIONAL' };

// ─── Módulos del sistema ─────────────────────────────────────────────────────
const MODULES = [
  'dashboard', 'employees', 'positions', 'locations', 'zones', 'schedules',
  'attendance', 'vacations', 'contracts', 'evaluations', 'payroll', 'training',
  'requisitions', 'recruitment', 'welfare', 'audits', 'org', 'users', 'bitacora',
  // Fase de mantenimiento: solicitudes, monitoreo y plan preventivo (TI)
  'mantenimiento',
];

// Permisos: R = leer, W = crear/editar, A = aprobar (flujo jerárquico)
const R = 'R', RW = 'RW', RWA = 'RWA';

/**
 * Cada rol declara únicamente los módulos a los que accede.
 * Lo no declarado queda denegado por defecto.
 */
const ROLES = {
  // ══════════════════════ SEDE CORPORATIVA ══════════════════════
  ADMIN: {
    etiqueta: 'Administrador del Sistema',
    short: 'Admin',
    descripcion: 'Acceso total. Reservado a Dirección General y TI.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 10,
    tipoProfesional: 'GERENCIA',
    color: 'slate',
    permissions: Object.fromEntries(MODULES.map((m) => [m, RWA])),
  },
  GERENTE_RRHH: {
    etiqueta: 'Gerente de Recursos Humanos',
    short: 'Gerente RRHH',
    descripcion: 'Dirige la gestión de personal a nivel nacional.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 9,
    tipoProfesional: 'GERENCIA',
    color: 'indigo',
    // Todo su ámbito, menos lo que no es suyo: las visitas DIGEMID las hace el
    // Auditor de Calidad, y la bitácora no la escribe nadie a mano.
    permissions: {
      ...Object.fromEntries(MODULES.map((m) => [m, RWA])),
      audits: R,
      bitacora: R,
      // Ve el estado del mantenimiento; lo gestiona TI (Administrador del Sistema)
      mantenimiento: R,
    },
  },
  ANALISTA_NOMINAS: {
    etiqueta: 'Analista de Planillas',
    short: 'Planillas',
    descripcion: 'Consolida asistencia, calcula horas extra, comisiones y descuentos.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 6,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'emerald',
    permissions: {
      dashboard: R, employees: R, attendance: R, vacations: R, contracts: R,
      payroll: RW, welfare: R, org: R,
    },
  },
  ANALISTA_SELECCION: {
    etiqueta: 'Analista de Selección',
    short: 'Selección',
    descripcion: 'Gestiona el embudo de contratación masiva de técnicos y químicos.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 6,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'violet',
    permissions: {
      dashboard: R, employees: RW, positions: R, locations: R, zones: R,
      contracts: RW, requisitions: RW, recruitment: RWA, org: R,
    },
  },
  ANALISTA_CAPACITACION: {
    etiqueta: 'Analista de Capacitación',
    short: 'Capacitación',
    descripcion: 'Administra la plataforma de aprendizaje: BPA, DIGEMID y actualizaciones.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 6,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'amber',
    permissions: {
      dashboard: R, employees: R, locations: R, zones: R,
      training: RWA, evaluations: R, audits: R, org: R,
    },
  },
  GESTOR_BIENESTAR: {
    etiqueta: 'Gestor de Bienestar Social',
    short: 'Bienestar',
    descripcion: 'Descansos médicos, subsidios EsSalud, EPS y seguros de riesgo.',
    nivelOrganizacional: 'CORPORATIVO',
    scope: SCOPES.NATIONAL,
    rank: 6,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'rose',
    permissions: {
      // Sin planilla: con lectura veía el sueldo y la boleta de toda la
      // empresa. El subsidio de EsSalud lo calcula el servidor con el sueldo
      // de quien está de descanso; Bienestar no necesita ver el resto.
      dashboard: R, employees: R, locations: R, zones: R,
      vacations: R, welfare: RWA, org: R,
    },
  },

  // ══════════════════════ SUPERVISIÓN ZONAL ══════════════════════
  JEFE_ZONA: {
    etiqueta: 'Supervisor de Zona',
    short: 'Supervisor Zonal',
    descripcion: 'Supervisa entre 15 y 20 boticas. Aprueba traslados y horas extra.',
    nivelOrganizacional: 'ZONAL',
    scope: SCOPES.ZONE,
    rank: 8,
    tipoProfesional: 'JEFE_ZONA',
    color: 'blue',
    permissions: {
      dashboard: R, employees: RW, locations: R, schedules: RWA, attendance: RW,
      vacations: RWA, contracts: R, evaluations: RWA, training: R,
      requisitions: RWA, audits: R, org: R,
      // Pide personal (requerimientos): necesita el catálogo de puestos para elegir
      // el cargo. Sin él el formulario no listaba ninguno y no se podía pedir nada
      positions: R, zones: R,
    },
  },
  AUDITOR_CALIDAD: {
    etiqueta: 'Auditor de Calidad',
    short: 'Auditor',
    descripcion: 'Asuntos regulatorios. Visitas inopinadas de cumplimiento DIGEMID.',
    nivelOrganizacional: 'ZONAL',
    scope: SCOPES.NATIONAL,
    rank: 7,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'cyan',
    permissions: {
      dashboard: R, employees: R, locations: R, zones: R, schedules: R,
      training: R, audits: RWA, org: R,
    },
  },

  // ══════════════════════ CENTRO DE DISTRIBUCIÓN ══════════════════════
  JEFE_CEDI: {
    etiqueta: 'Jefe de Centro de Distribución',
    short: 'Jefe CEDI',
    descripcion: 'Dirige la operación logística del centro de distribución.',
    nivelOrganizacional: 'CEDI',
    scope: SCOPES.LOCATION,
    rank: 7,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'orange',
    permissions: {
      dashboard: R, employees: R, locations: R, schedules: RWA, attendance: RW,
      vacations: RW, evaluations: RW, training: R, requisitions: RW, org: R,
      // Pide personal (requerimientos): necesita el catálogo de puestos para elegir
      // el cargo. Sin él el formulario no listaba ninguno y no se podía pedir nada
      positions: R,
    },
  },
  COORD_RUTAS: {
    etiqueta: 'Coordinador de Rutas y Despacho',
    short: 'Coord. Rutas',
    descripcion: 'Gestiona la flota que abastece las boticas a nivel nacional.',
    nivelOrganizacional: 'CEDI',
    scope: SCOPES.LOCATION,
    rank: 5,
    tipoProfesional: 'ADMINISTRATIVO',
    color: 'orange',
    permissions: {
      dashboard: R, employees: R, schedules: RW, attendance: R, org: R,
      // Arma los turnos de su CEDI: tiene que poder elegirlo (la lista se filtra por su alcance)
      locations: R,
    },
  },
  OPERARIO_CEDI: {
    etiqueta: 'Operario de Almacén (Picking / Montacargas)',
    short: 'Operario CEDI',
    descripcion: 'Arma gavetas de pedidos y moviliza pallets en el almacén central.',
    nivelOrganizacional: 'CEDI',
    scope: SCOPES.SELF,
    rank: 2,
    tipoProfesional: 'OPERARIO',
    color: 'stone',
    permissions: {
      // Tiene contrato laboral como cualquier otro: turno, marca y descansos le corresponden
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },

  // ══════════════════════ BOTICA ══════════════════════
  ADMIN_BOTICA: {
    etiqueta: 'Administrador de Botica',
    short: 'Admin. Botica',
    descripcion: 'Responsable comercial del local: ventas, horarios, inventario y caja.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.LOCATION,
    rank: 6,
    tipoProfesional: 'JEFE_LOCAL',
    color: 'teal',
    permissions: {
      dashboard: R, employees: R, locations: R, schedules: RWA, attendance: RW, vacations: RW,
      contracts: R, evaluations: RW, training: R, requisitions: RW, audits: R, org: R,
      // Pide personal (requerimientos): necesita el catálogo de puestos para elegir
      // el cargo. Sin él el formulario no listaba ninguno y no se podía pedir nada
      positions: R,
    },
  },
  QF: {
    etiqueta: 'Químico Farmacéutico (Director Técnico)',
    short: 'QF Director Técnico',
    descripcion: 'Máximo responsable sanitario del local ante DIGEMID. Obligatorio por ley.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.LOCATION,
    rank: 5,
    tipoProfesional: 'QF',
    color: 'green',
    requiresLicense: true,
    permissions: {
      dashboard: R, employees: R, schedules: R, attendance: R, vacations: R,
      training: R, audits: R, org: R,
    },
  },
  QF_ASISTENTE: {
    etiqueta: 'Químico Farmacéutico Asistente',
    short: 'QF Asistente',
    descripcion: 'Apoya al Director Técnico para cubrir el horario completo de la botica.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 4,
    tipoProfesional: 'QF',
    color: 'green',
    requiresLicense: true,
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  TECNICO: {
    etiqueta: 'Técnico en Farmacia',
    short: 'Técnico',
    descripcion: 'Dispensa productos y orienta al cliente bajo supervisión del QF.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 3,
    tipoProfesional: 'TECNICO',
    color: 'sky',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  TRAINEE: {
    etiqueta: 'Técnico en Entrenamiento',
    short: 'Trainee',
    descripcion: 'Personal nuevo en inducción. Sus operaciones requieren validación.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 1,
    tipoProfesional: 'TECNICO',
    color: 'yellow',
    restricted: true,
    permissions: {
      // La inducción limita lo que puede operar, no su derecho a solicitar descanso
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  CAJERO: {
    etiqueta: 'Cajero / Cajera',
    short: 'Cajero',
    descripcion: 'Procesa pagos y emite comprobantes. En turnos reducidos lo cubre el técnico.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 2,
    tipoProfesional: 'OPERARIO',
    color: 'stone',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  DERMOCONSULTOR: {
    etiqueta: 'Dermoconsultora / Técnico en Perfumería',
    short: 'Dermoconsultora',
    descripcion: 'Asesora en dermocosmética, cuidado capilar y belleza.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 3,
    tipoProfesional: 'OPERARIO',
    color: 'fuchsia',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  AUX_ALMACEN: {
    etiqueta: 'Auxiliar de Almacén',
    short: 'Aux. Almacén',
    descripcion: 'Recibe mercadería del CEDI, verifica guías y organiza anaqueles.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 2,
    tipoProfesional: 'OPERARIO',
    color: 'stone',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  PREVENCIONISTA: {
    etiqueta: 'Prevencionista / Anfitrión',
    short: 'Prevencionista',
    descripcion: 'Control de aforo, bienvenida al cliente y prevención de pérdidas.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 2,
    tipoProfesional: 'OPERARIO',
    color: 'stone',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },
  MOTORIZADO: {
    etiqueta: 'Motorizado (Delivery)',
    short: 'Motorizado',
    descripcion: 'Entrega a domicilio de pedidos de call center, app y web.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.SELF,
    rank: 2,
    tipoProfesional: 'OPERARIO',
    color: 'stone',
    permissions: {
      dashboard: R, schedules: R, attendance: R, vacations: R, training: R, org: R,
    },
  },

  // ── Alias legado (equivale a ADMIN_BOTICA) ──
  JEFE_LOCAL: {
    etiqueta: 'Administrador de Botica',
    short: 'Admin. Botica',
    descripcion: 'Alias histórico de ADMIN_BOTICA.',
    nivelOrganizacional: 'BOTICA',
    scope: SCOPES.LOCATION,
    rank: 6,
    tipoProfesional: 'JEFE_LOCAL',
    color: 'teal',
    deprecated: true,
    // Se enlaza tras declarar el objeto. Era una copia y se desincronizó —le
    // faltaba `locations`—, con lo que dos roles que en pantalla se llaman igual
    // tenían poderes distintos.
    permissions: null,
  },
};

ROLES.JEFE_LOCAL.permissions = ROLES.ADMIN_BOTICA.permissions;

const ROLE_CODES = Object.keys(ROLES);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getRole = (codigo) => ROLES[codigo] || null;

const can = (roleCode, module, action = 'read') => {
  const perm = ROLES[roleCode]?.permissions?.[module];
  if (!perm) return false;
  const flag = { read: 'R', write: 'W', approve: 'A' }[action];
  return perm.includes(flag);
};

const scopeOf = (roleCode) => ROLES[roleCode]?.scope || SCOPES.SELF;

const isManager = (roleCode) => (ROLES[roleCode]?.rank || 0) >= 6;

/** Roles cuyo alcance es al menos el indicado */
const rolesWithScope = (scope) => ROLE_CODES.filter((c) => ROLES[c].scope === scope);

/** Roles que pueden ejecutar una acción sobre un módulo — para `authorize(...)` */
const rolesAllowedTo = (module, action = 'read') =>
  ROLE_CODES.filter((c) => can(c, module, action));

module.exports = {
  ORG_LEVELS, SCOPES, MODULES, ROLES, ROLE_CODES,
  getRole, can, scopeOf, isManager, rolesWithScope, rolesAllowedTo,
};
