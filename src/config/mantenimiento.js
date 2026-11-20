/**
 * Fase de mantenimiento: los cuatro tipos y el proceso de cada uno.
 *
 * Es el proceso de la sesión GP 08 (Fases de diseño de sistemas, Ing. Matos)
 * hecho regla: un mantenimiento avanza etapa por etapa y no salta ninguna. Lo
 * que una etapa produce (el análisis, la solución, las pruebas, la versión
 * desplegada) se exige antes de pasar a la siguiente, para que el registro
 * cerrado documente la corrección por sí solo.
 *
 * `exige` nombra el campo que debe estar escrito para salir de esa etapa.
 */

const TIPOS = {
  CORRECTIVO: {
    etiqueta: 'Correctivo',
    objetivo: 'Corregir errores detectados durante el uso del sistema',
    etapas: [
      { codigo: 'RECEPCION', etiqueta: 'Recepción del informe de error', detalle: 'Lo reporta un usuario o lo detecta el monitoreo de errores.' },
      { codigo: 'ANALISIS', etiqueta: 'Análisis del error', detalle: 'Reproducirlo y entender su causa.', exige: 'analisis' },
      { codigo: 'CORRECCION', etiqueta: 'Corrección', detalle: 'Cambiar el código o la configuración que lo origina.', exige: 'solucion' },
      { codigo: 'PRUEBAS', etiqueta: 'Pruebas de verificación', detalle: 'Comprobar que el problema se resolvió y que nada más se rompió.', exige: 'pruebas' },
      { codigo: 'DESPLIEGUE', etiqueta: 'Actualización en el entorno real', detalle: 'Publicar la versión corregida.', exige: 'version' },
      { codigo: 'DOCUMENTACION', etiqueta: 'Documentación de la corrección', detalle: 'Dejar escrito qué pasó y cómo se resolvió, para futuros mantenimientos.' },
    ],
  },
  ADAPTATIVO: {
    etiqueta: 'Adaptativo',
    objetivo: 'Adaptar el sistema a cambios del entorno tecnológico o normativo',
    etapas: [
      { codigo: 'IDENTIFICACION', etiqueta: 'Identificación del cambio externo', detalle: 'Una norma, una plataforma, un sistema con el que hay que integrarse.' },
      { codigo: 'IMPACTO', etiqueta: 'Evaluación del impacto', detalle: 'Qué partes del sistema y qué datos afecta.', exige: 'analisis' },
      { codigo: 'PLANIFICACION', etiqueta: 'Planificación de los cambios', detalle: 'Qué se cambia, en qué orden y cómo se vuelve atrás.' },
      { codigo: 'MODIFICACION', etiqueta: 'Modificación del sistema', detalle: 'Adaptar el código, la configuración y los datos.', exige: 'solucion' },
      { codigo: 'COMPATIBILIDAD', etiqueta: 'Pruebas de compatibilidad', detalle: 'Lo nuevo funciona y lo anterior sigue funcionando.', exige: 'pruebas' },
      { codigo: 'IMPLEMENTACION', etiqueta: 'Implementación y documentación', detalle: 'Publicar la versión adaptada y documentarla.', exige: 'version' },
    ],
  },
  PERFECTIVO: {
    etiqueta: 'Perfectivo',
    objetivo: 'Mejorar o añadir funciones a partir de lo que piden los usuarios',
    etapas: [
      { codigo: 'SUGERENCIA', etiqueta: 'Recolección de la sugerencia', detalle: 'La propone un usuario o surge del uso del sistema.' },
      { codigo: 'FACTIBILIDAD', etiqueta: 'Análisis de factibilidad y priorización', detalle: 'Cuánto aporta, cuánto cuesta y cuándo conviene.', exige: 'analisis' },
      { codigo: 'IMPLEMENTACION', etiqueta: 'Diseño e implementación', detalle: 'Construir la mejora.', exige: 'solucion' },
      { codigo: 'PRUEBAS', etiqueta: 'Pruebas funcionales', detalle: 'La mejora hace lo que se pidió.', exige: 'pruebas' },
      { codigo: 'DESPLIEGUE', etiqueta: 'Despliegue en producción', detalle: 'Publicar la versión con la mejora.', exige: 'version' },
      { codigo: 'DOCUMENTACION', etiqueta: 'Actualización de la documentación', detalle: 'Manual, guía y capacitación de los usuarios.' },
    ],
  },
  PREVENTIVO: {
    etiqueta: 'Preventivo',
    objetivo: 'Prevenir fallos futuros con revisiones programadas',
    etapas: [
      { codigo: 'PLANIFICACION', etiqueta: 'Planificación del mantenimiento periódico', detalle: 'Qué se revisa y con qué frecuencia (plan preventivo).' },
      { codigo: 'ESTADO', etiqueta: 'Análisis del estado actual', detalle: 'Errores registrados, dependencias, datos, respaldos.', exige: 'analisis' },
      { codigo: 'APLICACION', etiqueta: 'Aplicación de mejoras o actualizaciones', detalle: 'Parches, limpieza, actualizaciones.', exige: 'solucion' },
      { codigo: 'ESTABILIDAD', etiqueta: 'Pruebas de estabilidad', detalle: 'Regresión y carga: el sistema sigue estable.', exige: 'pruebas' },
      { codigo: 'DOCUMENTACION', etiqueta: 'Documentación de los cambios', detalle: 'Qué se hizo y cuándo toca la próxima revisión.' },
    ],
  },
};

const TIPOS_CODIGOS = Object.keys(TIPOS);

/** Plazo objetivo de atención por prioridad, en días */
const PRIORIDADES = {
  CRITICA: { etiqueta: 'Crítica', plazoDias: 1, detalle: 'Nadie puede trabajar o hay riesgo legal' },
  ALTA: { etiqueta: 'Alta', plazoDias: 3, detalle: 'Un proceso importante falla' },
  MEDIA: { etiqueta: 'Media', plazoDias: 7, detalle: 'Hay un rodeo mientras se corrige' },
  BAJA: { etiqueta: 'Baja', plazoDias: 15, detalle: 'Molestia menor o mejora' },
};

const ORIGENES = {
  USUARIO: 'Reporte de un usuario',
  MONITOREO: 'Monitoreo de errores del sistema',
  EQUIPO: 'Equipo de desarrollo',
  NORMATIVA: 'Cambio normativo',
  PLAN: 'Plan de mantenimiento preventivo',
};

const ESTADOS = ['ABIERTO', 'EN_CURSO', 'CERRADO', 'DESCARTADO'];

/** Dónde ocurrió: los módulos del sistema y lo que no es un módulo */
const AREAS = {
  general: 'General', dashboard: 'Panel', employees: 'Empleados', schedules: 'Turnos',
  attendance: 'Asistencia', terminal: 'Terminal de marcación', vacations: 'Descansos y vacaciones',
  contracts: 'Contratos y ceses', evaluations: 'Evaluaciones', payroll: 'Planilla', training: 'Capacitaciones',
  requisitions: 'Requerimientos', recruitment: 'Reclutamiento', welfare: 'Bienestar', audits: 'Auditoría DIGEMID',
  users: 'Cuentas de acceso', autoservicio: 'Mi Espacio (autoservicio)', movil: 'App móvil',
  datos: 'Datos', infraestructura: 'Servidor e infraestructura', seguridad: 'Seguridad',
};

/**
 * El plan preventivo: qué se revisa y cada cuánto.
 * `rutina` marca lo que hace `npm run preventivo`; lo demás se ejecuta aparte
 * y se registra igual (lo hace cada comando).
 */
const PLAN_PREVENTIVO = [
  { codigo: 'RESPALDO', etiqueta: 'Copia de seguridad de la base de datos', cadaDias: 1, comando: 'npm run respaldo', rutina: true },
  { codigo: 'ERRORES', etiqueta: 'Revisión del registro de errores', cadaDias: 7, comando: 'npm run preventivo', rutina: true },
  { codigo: 'INTEGRIDAD', etiqueta: 'Verificación de integridad de los datos', cadaDias: 7, comando: 'npm run integridad', rutina: true },
  { codigo: 'NORMATIVA', etiqueta: 'Vigencia de parámetros legales (RMV, UIT)', cadaDias: 30, comando: 'npm run preventivo', rutina: true },
  { codigo: 'LIMPIEZA', etiqueta: 'Limpieza de notificaciones leídas antiguas', cadaDias: 30, comando: 'npm run preventivo', rutina: true },
  { codigo: 'DEPENDENCIAS', etiqueta: 'Dependencias y parches de seguridad (npm audit)', cadaDias: 30, comando: 'npm run preventivo', rutina: true },
  { codigo: 'REGRESION', etiqueta: 'Pruebas de regresión completas', cadaDias: 7, comando: 'npm run pruebas', rutina: false },
  { codigo: 'PERMISOS', etiqueta: 'Auditoría de permisos por rol', cadaDias: 7, comando: 'npm run auditoria', rutina: false },
  { codigo: 'CARGA', etiqueta: 'Prueba de carga', cadaDias: 90, comando: 'npm run carga', rutina: false },
];

/** Días que se guardan los errores del sistema: el registro no puede llenar el disco */
const DIAS_REGISTRO_ERRORES = 90;
/** Notificaciones ya leídas que se eliminan en la limpieza preventiva */
const DIAS_NOTIFICACION_LEIDA = 180;

/** Las etapas de un tipo */
const etapasDe = (tipo) => TIPOS[tipo]?.etapas || [];

/**
 * ¿Puede avanzar a la etapa siguiente? Devuelve el motivo si no.
 * Una regla pura: la usan la ruta y las pruebas unitarias.
 */
function motivoParaNoAvanzar(registro) {
  if (['CERRADO', 'DESCARTADO'].includes(registro.estado)) return `El mantenimiento ya está ${registro.estado.toLowerCase()}.`;
  const etapas = etapasDe(registro.tipo);
  const actual = etapas[registro.etapa ?? 0];
  if (!actual) return 'Etapa desconocida para este tipo de mantenimiento.';
  if (actual.exige && !String(registro[actual.exige] || '').trim()) {
    const que = { analisis: 'el análisis (causa o impacto)', solucion: 'la solución aplicada', pruebas: 'las pruebas realizadas y su resultado', version: 'la versión desplegada' }[actual.exige];
    return `Para cerrar «${actual.etiqueta}» falta registrar ${que}.`;
  }
  return null;
}

/** El estado que corresponde a una etapa */
function estadoDeEtapa(tipo, etapa) {
  const total = etapasDe(tipo).length;
  if (etapa >= total) return 'CERRADO';
  return etapa === 0 ? 'ABIERTO' : 'EN_CURSO';
}

/** Fecha objetivo de atención según la prioridad */
function fechaLimiteDe(prioridad, desde = new Date()) {
  const dias = PRIORIDADES[prioridad]?.plazoDias ?? PRIORIDADES.MEDIA.plazoDias;
  return new Date(new Date(desde).getTime() + dias * 86400000);
}

module.exports = {
  TIPOS, TIPOS_CODIGOS, PRIORIDADES, ORIGENES, ESTADOS, AREAS, PLAN_PREVENTIVO,
  DIAS_REGISTRO_ERRORES, DIAS_NOTIFICACION_LEIDA,
  etapasDe, motivoParaNoAvanzar, estadoDeEtapa, fechaLimiteDe,
};
