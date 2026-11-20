const { ROLE_CODES } = require('../config/roles');
const { FORMATS } = require('../config/formats');

/**
 * Los valores posibles de un campo, leídos del modelo.
 *
 * Varias listas de este archivo se escribieron a mano y se desalinearon de los
 * modelos durante la traducción: sólo se podía pedir personal por «reemplazo»,
 * mover un candidato de etapa fallaba y «Mis Vacaciones» no aceptaba permisos.
 * Leídas del modelo, no pueden volver a divergir.
 */
const valoresDe = (modelo, campo) => require(`../models/${modelo}`).schema.path(campo).enumValues;

/**
 * Esquemas de entrada, uno por operación.
 *
 * Se reúnen aquí y no dispersos por las rutas para que se puedan leer juntos:
 * lo que el sistema acepta escribir es una decisión de negocio, y conviene
 * poder revisarla de una sentada. Lo que no figure en un esquema no llega al
 * modelo, así que ampliar una operación pasa por tocar este archivo.
 */

// ─── Catálogos ───────────────────────────────────────────────────────────────
const TIPO_PROFESIONAL = ['QF', 'TECNICO', 'OPERARIO', 'ADMINISTRATIVO', 'JEFE_LOCAL', 'JEFE_ZONA', 'GERENCIA'];
const ESTADO_EMPLEADO = ['ACTIVO', 'INACTIVO', 'VACACIONES', 'LICENCIA', 'CESADO'];
const SISTEMA_PENSION = ['ONP', 'AFP_INTEGRA', 'AFP_PRIMA', 'AFP_PROFUTURO', 'AFP_HABITAT'];
const TIPO_CONTRATO = ['PLAZO_FIJO', 'INDETERMINADO', 'PRACTICAS', 'PART_TIME'];
const MARCA = ['INKAFARMA', 'MIFARMA', 'CORPORATIVO'];
const TIPO_LOCAL = ['BOTICA', 'CEDI', 'SEDE_CORPORATIVA'];
const DEPARTAMENTO = ['OPERACIONES', 'LOGISTICA', 'RRHH', 'ADMINISTRACION', 'CALIDAD', 'GERENCIA'];
const NIVEL_ORG = ['BOTICA', 'CEDI', 'ZONAL', 'CORPORATIVO'];
const MEDIO_PAGO = ['TRANSFERENCIA', 'DEPOSITO_CUENTA', 'EFECTIVO', 'CHEQUE'];
// Los mismos del modelo Vacacion. La lista anterior (DESCANSO_MEDICO,
// MATERNIDAD...) no coincidía con él ni con el formulario: pedir un permiso o
// una licencia médica desde «Mis Vacaciones» fallaba siempre. El descanso
// médico con certificado lo registra Bienestar en su propio módulo.
const TIPO_DESCANSO = ['VACACIONES', 'PERMISO', 'LICENCIA_MEDICA', 'LICENCIA_SIN_GOCE'];

// Un sueldo mensual por encima de esto casi siempre es un error de tecleo
const TOPE_SUELDO = 100000;

// ─── Empleados ───────────────────────────────────────────────────────────
const direccion = ['objeto', {
  calle: 'texto:0..120',
  distrito: 'texto:0..80',
  ciudad: 'texto:0..80',
  departamento: 'texto:0..80',
}];

const employeeCrear = {
  dni: 'dni!',
  nombres: 'texto!:2..80',
  apellidos: 'texto!:2..80',
  fechaNacimiento: 'fecha',
  sexo: ['enum', ['M', 'F']],
  telefono: 'celular',
  correo: 'correo',
  direccion: direccion,
  tipoProfesional: ['enum!', TIPO_PROFESIONAL],
  numeroCQF: 'texto:0..30',
  vencimientoCQF: 'fecha',
  esDirectorTecnico: 'booleano',
  esPracticante: 'booleano',
  fechaFinPracticas: 'fecha',
  supervisor: 'id',
  fechaIngreso: 'fechaPasada!',
  cargoActual: 'id!',
  localActual: 'id!',
  zona: 'id',
  estado: ['enum', ESTADO_EMPLEADO],
  sueldoBasico: `monto!:0..${TOPE_SUELDO}`,
  sistemaPensiones: ['enum', SISTEMA_PENSION],
  cuspp: 'texto:0..20',
  tieneHijos: 'booleano',
  cuentaBancaria: 'texto:0..30',
};

// Al editar nada es obligatorio, pero el DNI no se corrige por aquí: se rehace
const employeeEditar = (() => {
  // El motivo alimenta el historial: «ascenso», «ajuste anual», «traslado»
  const e = { motivo: 'texto:0..300' };
  for (const [k, v] of Object.entries(employeeCrear)) {
    if (k === 'dni') continue;
    e[k] = Array.isArray(v) ? [String(v[0]).replace('!', ''), v[1]] : String(v).replace('!', '');
  }
  return e;
})();

// ─── Contratos ───────────────────────────────────────────────────────────────
const contratoCrear = {
  empleado: 'id!',
  tipo: ['enum!', TIPO_CONTRATO],
  fechaInicio: 'fecha!',
  fechaFin: 'fecha',
  cargo: 'id',
  sueldo: `monto!:0..${TOPE_SUELDO}`,
  urlDocumento: 'texto:0..300',
};

const contratoRecomendar = {
  recomendacion: ['enum!', ['RENOVAR', 'NO_RENOVAR', 'INDETERMINADO']],
  notas: 'texto:0..1000',
  nota: 'texto:0..1000',
};

const contratoRenovar = {
  nuevaFechaFin: 'fecha',
  convertToIndefinite: 'booleano',
  sueldo: `monto:0..${TOPE_SUELDO}`,
  notas: 'texto:0..1000',
  // Confirmación explícita de que se conoce el tope de 5 años de la LPCL
  acknowledgeLegalCap: 'booleano',
};

const contratoTerminar = {
  motivoTermino: 'texto:5..500',
  motivo: 'texto:5..500',
  fechaFin: 'fecha',
  // Cesar además al empleado, no sólo cerrar el contrato
  ceaseEmployee: 'booleano',
};

// ─── Nómina ──────────────────────────────────────────────────────────────────
/**
 * La edición manual de una boleta se limita a la nota.
 * El resto de importes los produce el motor de cálculo: dejarlos abiertos
 * permitiría fijar un neto a mano y saltarse toda la liquidación.
 */
const payrollEditar = {
  notas: 'texto:0..500',
};

const payrollCalcular = {
  recalculate: 'booleano',
  local: 'id',
};

const payrollPagar = {
  paymentDate: 'fecha',
  medioDePago: ['enum', MEDIO_PAGO],
  referenciaPago: 'texto:0..60',
};

// ─── Descansos ───────────────────────────────────────────────────────────────
const vacacionCrear = {
  empleado: 'id',
  employeeId: 'id',
  tipo: ['enum', TIPO_DESCANSO],
  fechaInicio: 'fecha!',
  fechaFin: 'fecha!',
  motivo: 'texto:0..500',
};

const vacacionPropia = {
  tipo: ['enum', TIPO_DESCANSO],
  fechaInicio: 'fecha!',
  fechaFin: 'fecha!',
  motivo: 'texto:0..500',
};

/**
 * Cuerpo de una decisión (aprobar, rechazar, visar).
 *
 * `acknowledge*` son confirmaciones deliberadas: el sistema bloquea la
 * operación con un 409 explicando el riesgo, y sólo continúa si quien decide
 * lo reafirma. Sin declararlas aquí, ese segundo intento nunca llegaría.
 */
const decision = {
  comentario: 'texto:0..500',
  comentarios: 'texto:0..500',
  motivo: 'texto:0..500',
  nota: 'texto:0..500',
  acknowledgeCoverage: 'booleano',
  coverageNote: 'texto:0..500',
  sueldoOfrecido: `monto:0..${TOPE_SUELDO}`,
};

// ─── Turnos y asistencia ─────────────────────────────────────────────────────
const horarioGenerar = {
  local: 'id',
  locationId: 'id',
  inicioSemana: 'fecha!',
  regenerate: 'booleano',
};

const asistenciaEntrada = {
  empleado: 'id',
  employeeId: 'id',
  local: 'id',
  locationId: 'id',
  motivo: 'texto:0..300',
  nota: 'texto:0..300',
};

const asistenciaSalida = {
  attendanceId: 'id',
  employeeId: 'id',
  empleado: 'id',
  local: 'id',
  motivo: 'texto:0..300',
  nota: 'texto:0..300',
};

// ─── Estructura ──────────────────────────────────────────────────────────────
const localCrear = {
  nombre: 'texto!:3..120',
  codigo: 'texto!:2..20',
  marca: ['enum!', MARCA],
  tipo: ['enum', TIPO_LOCAL],
  formato: ['enum', Object.keys(FORMATS)],
  direccion: direccion,
  zona: 'id',
  responsable: 'id',
  directorTecnico: 'id',
  codigoDigemid: 'texto:0..30',
  activo: 'booleano',
};

const puestoCrear = {
  nombre: 'texto!:3..80',
  codigo: 'texto!:2..20',
  departamento: ['enum!', DEPARTAMENTO],
  nivelOrganizacional: ['enum!', NIVEL_ORG],
  rolPorDefecto: ['enum!', ROLE_CODES],
  nivel: 'entero:1..10',
  descripcion: 'texto:0..500',
  requiereQF: 'booleano',
  activo: 'booleano',
};

const zonaCrear = {
  nombre: 'texto!:3..80',
  codigo: 'texto!:2..20',
  responsable: 'id',
  descripcion: 'texto:0..500',
  activo: 'booleano',
};

// ─── Talento ─────────────────────────────────────────────────────────────────
const requerimientoCrear = {
  local: 'id!',
  cargo: 'id!',
  cantidad: 'entero!:1..50',
  motivo: ['enum!', valoresDe('Requerimiento', 'motivo')],
  justificacion: 'texto!:10..1000',
  urgencia: ['enum', ['BAJA', 'MEDIA', 'ALTA', 'CRITICA']],
  requeridoPara: 'fecha',
};

const candidatoCrear = {
  dni: 'dni!',
  nombres: 'texto!:2..80',
  apellidos: 'texto!:2..80',
  correo: 'correo',
  telefono: 'celular',
  tipoProfesional: ['enum!', valoresDe('Candidato', 'tipoProfesional')],
  numeroCQF: 'texto:0..30',
  requerimiento: 'id',
  origen: ['enum', valoresDe('Candidato', 'origen')],
  anosExperiencia: 'entero:0..60',
  notas: 'texto:0..1000',
};

const candidatoEtapa = {
  nota: 'texto:0..1000',
  etapa: ['enum!', valoresDe('Candidato', 'etapa')],
  notas: 'texto:0..1000',
  puntaje: 'entero:0..100',
};

const evaluacionCrear = {
  empleado: 'id!',
  // El evaluador no se elige: es quien registra la evaluación
  periodo: ['objeto!', {
    nombre: 'texto:0..40',
    fechaInicio: 'fecha!',
    fechaFin: 'fecha!',
  }],
  kpis: ['lista:0..20', ['objeto', {
    nombre: 'texto!:2..120',
    descripcion: 'texto:0..300',
    meta: 'decimal!:0..1000000',
    real: 'decimal:0..1000000',
    peso: 'decimal!:0..100',
    unidad: 'texto:0..12',
  }]],
  fortalezas: 'texto:0..2000',
  areasDeMejora: 'texto:0..2000',
  comentarios: 'texto:0..2000',
};

/** Firma del empleado: puede dejar constancia de desacuerdo */
const evaluacionFirmar = {
  comentarioEmpleado: 'texto:0..2000',
  empleadoConforme: 'booleano',
};

// Los campos son los del modelo Capacitacion. El esquema anterior declaraba
// fechaInicio, hours e isMandatory —que el modelo no tiene— y descartaba
// fechaProgramada, que es obligatoria: ninguna capacitación se podía crear
// desde la pantalla. Y aceptaba tipos (TECNICA, NORMATIVA) que el modelo
// rechaza, mientras rechazaba BPA y DIGEMID, los que mide el cumplimiento.
const capacitacionCrear = {
  empleado: 'id!',
  nombre: 'texto!:3..150',
  tipo: ['enum!', ['INDUCCION', 'BPA', 'DIGEMID', 'SEGURIDAD', 'LIDERAZGO', 'OTRO']],
  proveedor: 'texto:0..120',
  fechaProgramada: 'fecha!',
  fechaCompletado: 'fecha',
  horasDuracion: 'decimal:0..500',
  estado: ['enum', ['PROGRAMADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA']],
  puntaje: 'entero:0..100',
  numeroCertificado: 'texto:0..60',
  venceEn: 'fecha',
  notas: 'texto:0..1000',
};

// La marca en el terminal del local: sólo el DNI y cómo se identificó
const marcaTerminal = {
  dni: 'texto!:8..8',
  metodo: ['enum', ['ROSTRO', 'HUELLA', 'DNI']],
};

const requerimientoCerrar = {
  empleadoContratado: 'id',
};

// El rol que se elige en el modo exposición (config/exposicion.js)
const exposicionIngresar = { cuenta: 'texto!:1..60', pin: 'texto:0..20' };

const contratarCandidato = {
  fechaIngreso: 'fecha',
  sueldo: `monto:0..${TOPE_SUELDO}`,
  cargo: 'id',
  local: 'id',
  contractType: ['enum', TIPO_CONTRATO],
  contractMonths: 'entero:1..60',
};

// ─── Turnos ──────────────────────────────────────────────────────────────────
const turnoAsignar = {
  employeeId: 'id',
  rol: 'texto:0..40',
  remove: 'booleano',
};

/**
 * Publicar un horario con huecos de cobertura obliga a reconocerlos.
 * Si falta el Director Técnico, publicar sin más dejaría la botica operando
 * fuera de la exigencia de DIGEMID sin que nadie lo hubiera asumido.
 */
const horarioPublicar = {
  acknowledgeGaps: 'booleano',
  nota: 'texto:0..500',
};

// ─── Cumplimiento y bienestar ────────────────────────────────────────────────
// Los valores de un subdocumento (cada hallazgo) se leen de su propio esquema
const valoresDeHallazgo = (campo) => require('../models/VisitaAuditoria').schema.path('hallazgos').schema.path(campo).enumValues;

// Lo mismo que envía la pantalla y que guarda el modelo. Antes esperaba
// `fecha`, hallazgos como texto y el director técnico como sí/no: el
// formulario mandaba `fechaVisita`, hallazgos con categoría y severidad, y
// ninguna visita podía registrarse. El auditor y el puntaje no se reciben:
// el auditor es quien registra y el puntaje sale de los hallazgos.
const auditoriaCrear = {
  local: 'id!',
  fechaVisita: 'fecha',
  tipo: ['enum', valoresDe('VisitaAuditoria', 'tipo')],
  directorTecnicoPresente: 'booleano',
  directorTecnicoDeTurno: 'id',
  hallazgos: ['lista:0..50', ['objeto', {
    categoria: ['enum!', valoresDeHallazgo('categoria')],
    severidad: ['enum!', valoresDeHallazgo('severidad')],
    descripcion: 'texto!:3..500',
    accionCorrectiva: 'texto:0..500',
    fechaVencimiento: 'fecha',
  }]],
  estado: ['enum', valoresDe('VisitaAuditoria', 'estado')],
  resumen: 'texto:0..2000',
  fechaProximaVisita: 'fecha',
  cierre: 'booleano',
};

// Faltaba `tipo`, que el modelo exige: el formulario lo enviaba, el validador
// lo descartaba y ningún descanso médico podía registrarse
const descansoMedicoCrear = {
  empleado: 'id!',
  tipo: ['enum!', valoresDe('DescansoMedico', 'tipo')],
  fechaInicio: 'fecha!',
  fechaFin: 'fecha!',
  diagnostico: 'texto:0..300',
  centroMedico: 'texto:0..150',
  nombreMedico: 'texto:0..120',
  cmpMedico: 'texto:0..20',
  citt: ['objeto', { numero: 'texto:0..40', emitido: 'booleano', fechaEmision: 'fecha' }],
  cittNumber: 'texto:0..40',
  notas: 'texto:0..1000',
};

const hallazgoResolver = {
  accionCorrectiva: 'texto!:5..1000',
};

const descansoMedicoValidar = {
  cittNumber: 'texto:0..40',
  estadoReembolso: ['enum', ['PENDIENTE', 'PRESENTADO', 'APROBADO', 'OBSERVADO', 'RECHAZADO']],
  montoReembolsado: 'monto:0..100000',
  notas: 'texto:0..1000',
};

// ─── Cese y liquidación ──────────────────────────────────────────────────────
const { CAUSAS_CODIGOS } = require('../config/ceseParams');

const liquidacionSimular = {
  employeeId: 'id!',
  fechaCese: 'fecha!',
  causa: ['enum!', CAUSAS_CODIGOS],
  adelantos: `monto:0..${TOPE_SUELDO}`,
  // Si no vienen, se deducen del propio sistema
  diasVacacionesPendientes: 'entero:0..400',
  diasTrabajadosDelMes: 'entero:0..31',
};

const liquidacionCrear = {
  ...liquidacionSimular,
  motivoDetallado: 'texto:0..1000',
  // Confirmación deliberada de un saldo de vacaciones fuera de lo verosímil
  confirmarSaldoVacaciones: 'booleano',
};

const liquidacionPagar = {
  fechaPago: 'fecha',
  medioDePago: ['enum', MEDIO_PAGO],
  referenciaPago: 'texto:0..60',
};

const liquidacionFirmar = { observacion: 'texto:0..2000' };
const liquidacionAnular = { motivo: 'texto!:5..500' };

// ─── Cuentas ─────────────────────────────────────────────────────────────────
const cuentaCrear = {
  employeeId: 'id!',
  correo: 'correo',
  rol: ['enum!', ROLE_CODES],
  contrasena: 'texto:10..128',
};

const cuentaAltaMasiva = {
  locationId: 'id',
  dominio: 'texto:3..60',
  limite: 'entero:1..500',
  soloSimular: 'booleano',
};

const cuentaRol = { rol: ['enum!', ROLE_CODES] };
const cuentaEstado = { activo: 'booleano!', motivo: 'texto:0..300' };

const recuperarSolicitar = { correo: 'texto!:3..160' };

const recuperarCanjear = {
  correo: 'texto!:3..160',
  codigo: 'texto!:6..6',
  nuevaContrasena: 'texto!:10..128',
};

const cambioClave = {
  currentPassword: 'texto!:1..128',
  newPassword: 'texto!:10..128',
};

const login = {
  correo: 'texto!:3..160',
  contrasena: 'texto!:1..128',
};

/**
 * Versión editable de un esquema: los mismos campos, ninguno obligatorio.
 * Editar no debe exigir reenviar todo el registro.
 */
function comoEdicion(esquema, omitir = []) {
  const salida = {};
  for (const [k, v] of Object.entries(esquema)) {
    if (omitir.includes(k)) continue;
    salida[k] = Array.isArray(v)
      ? [String(v[0]).replace('!', ''), v[1]]
      : String(v).replace('!', '');
  }
  return salida;
}

// ─── Mantenimiento ──────────────────────────────────────────────────────────
const MNT = require('../config/mantenimiento');
const mantenimientoReportar = {
  // Quien usa el sistema reporta un error o sugiere una mejora; nada más
  tipo: ['enum!', ['CORRECTIVO', 'PERFECTIVO']],
  titulo: 'texto!:5..160',
  descripcion: 'texto!:10..4000',
  area: ['enum', Object.keys(MNT.AREAS)],
  prioridad: ['enum', Object.keys(MNT.PRIORIDADES)],
  pagina: 'texto:0..200',
  incidencia: 'texto:0..20',
};
const mantenimientoCrear = {
  tipo: ['enum!', MNT.TIPOS_CODIGOS],
  titulo: 'texto!:5..160',
  descripcion: 'texto!:10..4000',
  area: ['enum', Object.keys(MNT.AREAS)],
  prioridad: ['enum', Object.keys(MNT.PRIORIDADES)],
  origen: ['enum', Object.keys(MNT.ORIGENES)],
  responsable: 'id',
};
const mantenimientoEditar = {
  ...comoEdicion(mantenimientoCrear),
  analisis: 'texto:0..4000',
  solucion: 'texto:0..4000',
  pruebas: 'texto:0..4000',
  version: 'texto:0..20',
  archivos: ['lista:0..60', 'texto:1..200'],
};
const mantenimientoAvanzar = {
  nota: 'texto!:3..1000',
  analisis: 'texto:0..4000',
  solucion: 'texto:0..4000',
  pruebas: 'texto:0..4000',
  version: 'texto:0..20',
};
const mantenimientoDescartar = { motivo: 'texto!:5..500' };

const localEditar = comoEdicion(localCrear);
const puestoEditar = comoEdicion(puestoCrear);
const zonaEditar = comoEdicion(zonaCrear);
const evaluacionEditar = comoEdicion(evaluacionCrear, ['empleado']);
const capacitacionEditar = comoEdicion(capacitacionCrear, ['empleado']);
const auditoriaEditar = comoEdicion(auditoriaCrear, ['local']);
const candidatoEditar = comoEdicion(candidatoCrear, ['dni']);
const requerimientoEditar = comoEdicion(requerimientoCrear);
const descansoMedicoEditar = comoEdicion(descansoMedicoCrear, ['empleado']);

module.exports = {
  localEditar, puestoEditar, zonaEditar, evaluacionEditar, capacitacionEditar,
  auditoriaEditar, candidatoEditar, requerimientoEditar, descansoMedicoEditar,
  comoEdicion,
  employeeCrear, employeeEditar, exposicionIngresar,
  contratoCrear, contratoRecomendar, contratoRenovar, contratoTerminar,
  payrollEditar, payrollCalcular, payrollPagar,
  vacacionCrear, vacacionPropia, decision, marcaTerminal,
  horarioGenerar, asistenciaEntrada, asistenciaSalida,
  localCrear, puestoCrear, zonaCrear,
  requerimientoCrear, candidatoCrear, candidatoEtapa,
  evaluacionCrear, evaluacionFirmar, capacitacionCrear,
  auditoriaCrear, hallazgoResolver, descansoMedicoCrear, descansoMedicoValidar,
  requerimientoCerrar, contratarCandidato, turnoAsignar, horarioPublicar,
  liquidacionSimular, liquidacionCrear, liquidacionPagar,
  liquidacionFirmar, liquidacionAnular,
  recuperarSolicitar, recuperarCanjear,
  cuentaCrear, cuentaAltaMasiva, cuentaRol, cuentaEstado, cambioClave, login,
  mantenimientoReportar, mantenimientoCrear, mantenimientoEditar, mantenimientoAvanzar, mantenimientoDescartar,
  catalogos: {
    TIPO_PROFESIONAL, ESTADO_EMPLEADO, SISTEMA_PENSION, TIPO_CONTRATO,
    MARCA, TIPO_LOCAL, DEPARTAMENTO, NIVEL_ORG, MEDIO_PAGO, TIPO_DESCANSO,
    TOPE_SUELDO,
  },
};
