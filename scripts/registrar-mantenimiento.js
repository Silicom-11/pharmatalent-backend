#!/usr/bin/env node
require('dotenv').config();
require('../src/config/zonaHoraria').fijarZonaHoraria();
const mongoose = require('mongoose');

/**
 * Registro histórico de la fase de mantenimiento.
 *
 * Los mantenimientos hechos desde la puesta en marcha (02/10/2026), con sus
 * fechas reales, documentados con el proceso de su tipo (GP 08). Lo que se
 * hizo antes de que existiera el módulo se carga aquí; lo que venga después
 * se registra desde la pantalla Mantenimiento o lo registra
 * `npm run preventivo`.
 *
 * Idempotente: un código que ya existe no se toca.
 *
 *   node scripts/registrar-mantenimiento.js
 */

const EQUIPO = 'Equipo de desarrollo (M. Aquino, M. Cataño)';

const REGISTROS = [
  // ─── 1.0.1 · 22–23/10/2026 ─────────────────────────────────────────────────
  {
    codigo: 'MNT-2026-001', fecha: '2026-10-22T10:30', cierre: '2026-10-22T23:00',
    tipo: 'CORRECTIVO', origen: 'USUARIO', prioridad: 'ALTA', area: 'employees', version: '1.0.1',
    titulo: 'El legajo aceptaba una fecha de ingreso futura',
    descripcion: 'Durante la revisión con el docente se registró a «Fernando Matos» (Inkafarma Huancayo Real) con fecha de ingreso 12/12/2026. El sistema lo aceptó y lo contó como personal activo de un mes que todavía no llega.',
    analisis: 'El validador del alta usaba el tipo «fecha», que acepta cualquier fecha, y el formulario tenía un campo de texto libre. No había regla que impidiera fechas futuras.',
    solucion: 'Nuevo tipo de validación «fechaPasada» (rechaza fechas posteriores a hoy) aplicado a fechaIngreso; el formulario usa un selector de fecha con máximo = hoy.',
    pruebas: 'Prueba unitaria nueva en validacion.test.js (fecha futura rechazada, hoy y pasado aceptados). Regresión: 217/217 pruebas en verde.',
    archivos: ['src/middleware/validar.js', 'src/validators/esquemas.js', 'pharmatalent-frontend/src/pages/employees/EmployeeList.jsx'],
  },
  {
    codigo: 'MNT-2026-002', fecha: '2026-10-23T09:10', cierre: '2026-10-23T11:00',
    tipo: 'CORRECTIVO', origen: 'USUARIO', prioridad: 'CRITICA', area: 'employees', version: '1.0.1',
    titulo: 'El formulario «Nuevo empleado» no cargaba puesto, centro ni zona',
    descripcion: 'En el modo de exposición, al abrir Empleados → Nuevo, las listas de puesto, centro de trabajo y zona salían vacías y no se podía registrar a nadie (captura enviada por el usuario).',
    analisis: 'El modo de exposición limitaba los módulos visibles y can() negaba también la lectura de los catálogos positions, locations y zones que el formulario necesita.',
    solucion: 'Los catálogos positions, locations y zones se agregan a los módulos visibles; el Administrador del Sistema queda fuera del límite del recorrido.',
    pruebas: 'Alta de un empleado de prueba desde la interfaz con cada rol que puede registrar; los 10 pasos del recorrido guiado se repitieron sin cambios.',
    archivos: ['pharmatalent-frontend/src/config/exposicion.js', 'pharmatalent-frontend/src/config/roles.js'],
  },
  {
    codigo: 'MNT-2026-003', fecha: '2026-10-23T14:00', cierre: '2026-10-23T18:30',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'vacations', version: '1.0.1',
    titulo: 'El riesgo de triple pago de vacaciones tomaba el período equivocado',
    descripcion: 'La alerta de vacaciones vencidas (D.Leg. 713, art. 23) calculaba el período pendiente a partir del más reciente y no del más antiguo, de modo que quien tenía un período vencido aparecía sin riesgo.',
    analisis: 'balanceOf restaba los días gozados del último período generado. El D.Leg. 713 imputa el goce al período más antiguo pendiente.',
    solucion: 'Función periodoPendiente(fechaIngreso, años, díasGozados, hoy) en leaveRules.js; balanceOf y la ruta del autoservicio la usan. Los datos de períodos vencidos antes de 2026 se registraron como gozados (6 casos de riesgo intencionales).',
    pruebas: 'Pruebas unitarias en vacaciones.test.js (período más antiguo, vencimiento, saldo). Regresión: 222/222.',
    archivos: ['src/services/leaveRules.js', 'src/routes/me.js', 'scripts/coherencia.js', 'tests/vacaciones.test.js'],
  },
  {
    codigo: 'MNT-2026-004', fecha: '2026-10-23T11:20', cierre: '2026-10-23T12:10',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'CRITICA', area: 'datos', version: '1.0.1',
    titulo: 'La restauración de copias de seguridad no restauraba nada',
    descripcion: 'Al probar volver a un respaldo, el guion terminaba sin error pero la base quedaba igual.',
    analisis: 'restaurar.js leía c.nombre de cada colección, pero el driver de MongoDB devuelve c.name: el bucle no encontraba colecciones que reemplazar. Una copia que nunca se restauró no era una copia.',
    solucion: 'Se corrige la lectura del nombre de la colección y se verifica la huella SHA-256 antes de restaurar.',
    pruebas: 'Restauración completa de pharmatalent-20261023-113200.json.gz y verificación de conteos por colección; ingreso al sistema después de restaurar.',
    archivos: ['scripts/restaurar.js'],
  },
  {
    codigo: 'MNT-2026-005', fecha: '2026-10-23T15:00', cierre: '2026-10-23T22:00',
    tipo: 'PERFECTIVO', origen: 'USUARIO', prioridad: 'MEDIA', area: 'general', version: '1.0.1',
    titulo: 'Recorrido guiado y cambio de rol para exponer el sistema',
    descripcion: 'El docente observó que el sistema completo saturaba la exposición. Se pidió mostrar los flujos principales de Junín con pocas cuentas y un orden claro.',
    analisis: 'Factible sin tocar las reglas de negocio: una capa de presentación activada por variable de entorno, nunca en producción.',
    solucion: 'MODO_EXPOSICION: ingreso por rol sin contraseña para cuentas de demostración, selector «Ver como», guía de 10 pasos y alcance reducido a Junín.',
    pruebas: 'Ensayo completo de los 10 pasos; el modo no existe con NODE_ENV=production (prueba en permisos.test.js).',
    archivos: ['src/config/exposicion.js', 'src/routes/exposicion.js', 'pharmatalent-frontend/src/components/GuiaExposicion.jsx'],
  },
  // ─── 1.0.2 · 05–06/11/2026 ─────────────────────────────────────────────────
  {
    codigo: 'MNT-2026-006', fecha: '2026-11-06T01:10', cierre: '2026-11-06T02:00',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'welfare', version: '1.0.2',
    titulo: 'No se podía registrar un descanso médico',
    descripcion: 'En la prueba por rol, el Gestor de Bienestar recibía «Error de validación» al registrar cualquier descanso médico.',
    analisis: 'El validador descartaba el campo «tipo», que el modelo exige: la lista blanca lo eliminaba y Mongoose rechazaba el documento.',
    solucion: 'descansoMedicoCrear declara tipo (enumerado leído del modelo), centro médico, médico, CMP y CITT.',
    pruebas: 'Prueba unitaria con el cuerpo exacto que envía el formulario (validacion.test.js); registro real desde la interfaz.',
    archivos: ['src/validators/esquemas.js', 'tests/validacion.test.js'],
  },
  {
    codigo: 'MNT-2026-007', fecha: '2026-11-06T01:30', cierre: '2026-11-06T02:20',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'audits', version: '1.0.2',
    titulo: 'No se podía registrar una visita DIGEMID',
    descripcion: 'El Auditor de Calidad no podía guardar una visita con hallazgos.',
    analisis: 'El esquema de validación tenía una forma distinta de la del modelo y del formulario (hallazgos como texto en vez de lista de objetos con severidad).',
    solucion: 'auditoriaCrear valida hallazgos como lista de objetos {categoría, severidad, descripción, acción correctiva, vencimiento} con los enumerados del modelo.',
    pruebas: 'Prueba unitaria con el cuerpo del formulario; registro de una visita con dos hallazgos y su mapa de riesgo.',
    archivos: ['src/validators/esquemas.js', 'tests/validacion.test.js'],
  },
  {
    codigo: 'MNT-2026-008', fecha: '2026-11-06T02:00', cierre: '2026-11-06T02:40',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'schedules', version: '1.0.2',
    titulo: '«Generar cronograma» respondía siempre «fecha inválida»',
    descripcion: 'El Administrador de Botica no podía generar la semana siguiente: cualquier fecha devolvía «fecha inválida».',
    analisis: 'El validador ya convertía inicioSemana en Date y la ruta volvía a interpretarlo como texto (String(Date) no es una fecha ISO).',
    solucion: 'La ruta trata inicioSemana como Date y acepta el local por locationId o local.',
    pruebas: 'Generación de la semana del 15/11 en Inkafarma Huancayo Real con cobertura del 100 % y QF en cada turno.',
    archivos: ['src/routes/schedules.js'],
  },
  {
    codigo: 'MNT-2026-009', fecha: '2026-11-05T22:00', cierre: '2026-11-06T04:30',
    tipo: 'ADAPTATIVO', origen: 'USUARIO', prioridad: 'ALTA', area: 'movil', version: '1.0.2',
    titulo: 'Acceso al sistema desde una aplicación Android',
    descripcion: 'El docente pidió el sistema funcionando en un celular, además de la web.',
    analisis: 'Impacto: la API ya servía a la web; la app debía usar el mismo backend y la misma base. Riesgos: contenido mixto http/https, CORS de la pantalla de conexión y orígenes distintos.',
    solucion: 'App Capacitor 8 (pharmatalent-movil) con pantalla de conexión que valida /api/salud y abre el sistema; /api/salud con CORS y CORP abiertos (no expone datos); tráfico en claro permitido para la red local.',
    pruebas: 'APK instalado en un teléfono real: ingreso por rol, marcación en el terminal y vacaciones de punta a punta.',
    archivos: ['pharmatalent-movil/', 'src/app.js'],
  },
  {
    codigo: 'MNT-2026-010', fecha: '2026-11-06T08:00', cierre: '2026-11-06T09:30',
    tipo: 'ADAPTATIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'infraestructura', version: '1.0.2',
    titulo: 'Acceso desde otra red: túnel seguro con PIN',
    descripcion: 'La exposición se hace desde la universidad por escritorio remoto, y el celular usa otra red: no alcanzaba la IP local del servidor.',
    analisis: 'Abrir el sistema a internet expone el ingreso por rol sin contraseña del modo de exposición.',
    solucion: 'Túnel de Cloudflare (npm run tunel) con dirección https; por el túnel el ingreso por rol exige el PIN de EXPOSICION_PIN y un límite de intentos por IP.',
    pruebas: 'Ingreso desde el celular con datos móviles; PIN incorrecto → 403; en la red local sigue sin PIN.',
    archivos: ['scripts/tunel.js', 'src/config/exposicion.js', 'src/app.js'],
  },
  {
    codigo: 'MNT-2026-011', fecha: '2026-11-06T00:30', cierre: '2026-11-06T05:00',
    tipo: 'PERFECTIVO', origen: 'USUARIO', prioridad: 'MEDIA', area: 'general', version: '1.0.2',
    titulo: 'Exposición del sistema completo: una cuenta por cada uno de los 21 roles',
    descripcion: 'Se pidió poder entrar con cualquier rol que nombre el docente y crear lo que pida.',
    analisis: 'El recorrido corto de Junín no cubría todos los roles; se mantiene como variante.',
    solucion: 'MODO_EXPOSICION=completo: 21 cuentas agrupadas por nivel (sede, zona, CEDI, botica), sin ocultar módulos y con alcance nacional.',
    pruebas: 'Prueba por rol: 36 operaciones, 33 correctas y 3 rechazos que son reglas de negocio (renovación recomendada por otro, contratar sólo en oferta).',
    archivos: ['src/config/exposicion.js', 'pharmatalent-frontend/src/pages/auth/Login.jsx'],
  },
  // ─── 1.1.0 · 13/11/2026: fase de mantenimiento ─────────────────────────────
  {
    codigo: 'MNT-2026-012', fecha: '2026-11-06T13:30', cierre: '2026-11-13T02:55',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'MEDIA', area: 'terminal', version: '1.1.0',
    titulo: 'La salida podía marcarse en una botica distinta a la de la entrada',
    descripcion: 'Al preparar el guion se vio que una trabajadora con entrada en Mifarma Huancayo Giráldez que pasara por el terminal de Inkafarma Huancayo Real quedaba con la salida registrada allí.',
    analisis: 'registrarMarca buscaba la jornada abierta de la persona sin mirar en qué local se abrió: cualquier terminal la cerraba.',
    solucion: 'En el terminal, la salida sólo se registra en el local de la entrada; si no, responde «Su jornada de hoy está abierta en …: marque su salida allí». La jefatura puede corregirla desde Asistencia (origen CORRECCION).',
    pruebas: 'Prueba de integración nueva (marcación en dos locales) y caso funcional CP-08. Regresión completa en verde.',
    archivos: ['src/services/marcacion.js', 'tests/integracion/02-marcacion.test.js'],
  },
  {
    codigo: 'MNT-2026-013', fecha: '2026-11-06T14:30', cierre: '2026-11-13T02:58',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'BAJA', area: 'datos', version: '1.1.0',
    titulo: 'El reinicio de datos de la tarde dejaba marcado al técnico del guion',
    descripcion: 'Si npm run exposicion se ejecutaba después de las 15:00, el técnico del turno tarde ya tenía su entrada simulada y el terminal le registraba la salida en vez de la entrada.',
    analisis: 'coherencia.js simula la marca de todo turno ya empezado, sin excepción.',
    solucion: 'El técnico del guion (tecnico.huancayo) no recibe marca simulada el día de hoy: marca en vivo.',
    pruebas: 'Reinicio ejecutado después de las 15:00 y marcación de entrada en el terminal IKF-733.',
    archivos: ['scripts/coherencia.js'],
  },
  {
    codigo: 'MNT-2026-014', fecha: '2026-11-13T02:25', cierre: '2026-11-13T02:50',
    tipo: 'ADAPTATIVO', origen: 'NORMATIVA', prioridad: 'CRITICA', area: 'payroll', version: '1.1.0',
    titulo: 'Nueva RMV de S/ 1,230 (D.S. 015-2026-TR) y UIT 2026 de S/ 5,500 (D.S. 301-2025-EF)',
    descripcion: 'Desde el 01/10/2026 la Remuneración Mínima Vital es S/ 1,230. El sistema seguía calculando con S/ 1,130 y la UIT de 2025 (S/ 5,350), y aceptaba sueldos por debajo del mínimo legal.',
    analisis: 'Impacto: 9 trabajadores activos ganaban menos de S/ 1,230 (7 técnicos en entrenamiento y 2 cajeros); asignación familiar de S/ 113 a S/ 123; base mínima de EsSalud; deducción de 7 UIT de la renta de quinta; liquidaciones; mínimo de los puestos Técnico en Entrenamiento y Cajero. La planilla de octubre estaba calculada con la RMV anterior.',
    solucion: 'Parámetros legales con vigencia (tabla de RMV por fecha y UIT por año, con su norma); planilla, boleta y liquidación usan el valor de su período; regla de sueldo mínimo en empleados, contratos y contratación; ajuste de sueldos, contratos y puestos con su historial; recálculo de octubre.',
    pruebas: 'Pruebas unitarias de vigencias (setiembre 1130, octubre 1230, UIT 2025/2026) y de sueldo mínimo; casos funcionales CP-04 y CP-05; regresión completa.',
    archivos: ['src/config/payrollParams.js', 'src/services/payroll.js', 'src/services/liquidacion.js', 'src/services/boleta.js', 'src/services/sueldoMinimo.js', 'scripts/coherencia.js'],
  },
  {
    codigo: 'MNT-2026-015', fecha: '2026-11-13T02:35', cierre: '2026-11-13T03:05',
    tipo: 'PERFECTIVO', origen: 'EQUIPO', prioridad: 'MEDIA', area: 'general', version: '1.1.0',
    titulo: 'Reportar un problema desde cualquier pantalla y tablero de mantenimiento',
    descripcion: 'Los errores y sugerencias llegaban por chat o de palabra y se perdían. Se necesita recibirlos dentro del sistema y seguirlos hasta resolverlos.',
    analisis: 'Factible con lo existente (cuentas, notificaciones, bitácora). Prioridad alta para la fase de mantenimiento: es la etapa de recepción de los procesos correctivo y perfectivo.',
    solucion: 'Botón «Reportar» para todos los roles (adjunta pantalla, versión y código de incidencia), «Mis reportes» con la etapa en curso, módulo Mantenimiento con el proceso de cada tipo, monitoreo y plan preventivo.',
    pruebas: 'Pruebas de integración incrementales del módulo (niveles 1 a 4) y casos funcionales CP-09 a CP-11.',
    archivos: ['src/routes/mantenimiento.js', 'src/models/Mantenimiento.js', 'src/config/mantenimiento.js', 'pharmatalent-frontend/src/pages/mantenimiento/Mantenimiento.jsx', 'pharmatalent-frontend/src/components/ReportarProblema.jsx'],
  },
  {
    codigo: 'MNT-2026-016', fecha: '2026-11-13T02:40', cierre: '2026-11-13T03:00',
    tipo: 'PREVENTIVO', origen: 'PLAN', prioridad: 'MEDIA', area: 'infraestructura', version: '1.1.0',
    titulo: 'Registro de errores del servidor con caducidad',
    descripcion: 'Los errores inesperados sólo quedaban en la consola, que se pierde al reiniciar; y un registro sin límite termina llenando el disco del servidor.',
    analisis: 'No había forma de saber qué ruta fallaba ni cuántas veces, ni de relacionar el código que ve el usuario con el detalle técnico.',
    solucion: 'Colección errores_sistema con el código de incidencia, la ruta y el usuario, borrada automáticamente a los 90 días (índice TTL). Desde el monitoreo un error se convierte en un mantenimiento correctivo.',
    pruebas: 'Prueba de integración: un error 500 provocado queda registrado con su incidencia y se convierte en correctivo; índice TTL verificado.',
    archivos: ['src/models/ErrorSistema.js', 'src/middleware/errorHandler.js'],
  },
  {
    codigo: 'MNT-2026-017', fecha: '2026-11-13T02:50', cierre: '2026-11-13T02:58',
    tipo: 'PREVENTIVO', origen: 'PLAN', prioridad: 'ALTA', area: 'seguridad', version: '1.1.0',
    titulo: 'Actualización de dependencias y parches de seguridad',
    descripcion: 'Revisión de las librerías del backend y del frontend con npm audit y npm outdated, como pide el plan preventivo.',
    analisis: 'npm audit del backend: 8 vulnerabilidades (1 crítica: proxy-addr, suplantación de IP con direcciones IPv4 mapeadas en IPv6, relevante porque el sistema confía en el proxy del túnel; 3 altas: body-parser y brace-expansion, denegación de servicio, y mongoose, sanitizeFilter no aplicado; 4 moderadas: qs, morgan, minimatch y nodemon). Frontend: 3 altas (follow-redirects, source-map-js y vite). 4 paquetes del backend y 13 del frontend con parches o versiones menores pendientes.',
    solucion: 'npm update dentro de los rangos declarados y npm audit fix sin cambios mayores: express 5.2.1 → 5.3.0, mongoose 9.9.4 → 9.12.1, morgan 1.12.0 → 1.12.1; react 19.2.8 → 19.3.1, vite 8.2.2 → 8.3.8, axios 1.20.0 → 1.21.1, react-router-dom 7.18.3 → 7.18.5, tailwindcss 4.3.3 → 4.3.5 y otros. Resultado: 0 vulnerabilidades en las dependencias de producción de ambos proyectos. Quedan 2 moderadas en nodemon (sólo desarrollo; su arreglo exige bajar de versión) y dotenv 18 (versión mayor), planificadas para la próxima revisión.',
    pruebas: 'Regresión completa con las dependencias ya actualizadas: 242 unitarias, 26 de integración y 22 funcionales en verde; compilación del frontend sin errores; revisión en el navegador del panel, Mantenimiento y Reportar.',
    archivos: ['pharmatalent-backend/package-lock.json', 'pharmatalent-frontend/package-lock.json'],
  },
  {
    codigo: 'MNT-2026-018', fecha: '2026-11-13T03:02', cierre: '2026-11-13T03:06',
    tipo: 'CORRECTIVO', origen: 'EQUIPO', prioridad: 'ALTA', area: 'payroll', version: '1.1.0',
    titulo: 'El ajuste a la RMV no alcanzaba los contratos ya renovados',
    descripcion: 'La prueba funcional CP-05 falló en su primera ejecución: una boleta de octubre 2026 seguía con un básico de S/ 1,130 después del ajuste a la RMV.',
    analisis: 'El trabajador (practicante de Inkafarma Huancayo Real) tenía el contrato de octubre en estado RENOVADO, porque ya existía el siguiente desde el 14/11. El ajuste sólo actualizaba contratos VIGENTES, pero el motor de planilla elige el contrato por fechas, no por estado.',
    solucion: 'El ajuste alcanza a todo contrato que rige algún día desde el 01/10/2026 (fecha de fin vacía o posterior), sea cual sea su estado; la planilla del período se recalcula si queda alguna boleta bajo la RMV de su período.',
    pruebas: 'CP-05 repetido: 416 boletas de octubre, asignación familiar de S/ 123 y ninguna bajo la RMV. Suite funcional 22/22.',
    archivos: ['scripts/coherencia.js'],
  },
  {
    codigo: 'MNT-2026-019', fecha: '2026-11-13T03:07', cierre: '2026-11-13T03:11',
    tipo: 'PREVENTIVO', origen: 'PLAN', prioridad: 'MEDIA', area: 'vacations', version: '1.1.0',
    titulo: 'Prueba de carga con 100 usuarios y optimización de la bandeja de descansos',
    descripcion: 'El requisito RNF1 (95 % de respuestas en menos de 2 s con 100 usuarios concurrentes) estaba pendiente de medición desde el Avance 2.',
    analisis: 'Primera medición (npm run carga, 100 usuarios, 30 s, 14 consultas): 6047 peticiones, 0 errores, p95 1666 ms, 98.8 % bajo 2 s (cumple). Cuello de botella: la bandeja de solicitudes de descanso (/vacations/pending) con p50 1803 ms y p95 2236 ms, cuatro veces el resto, porque evaluaba cada solicitud una tras otra (unas cuatro consultas seguidas por solicitud).',
    solucion: 'La bandeja evalúa las solicitudes por lotes de 25 en paralelo y consulta el contexto de cada trabajador una sola vez, conservando el orden y el tope de 50.',
    pruebas: 'Segunda medición: p95 total 1367 ms, 99.6 % bajo 2 s, 0 errores; bandeja p50 1501 ms y p95 2021 ms (−17 % y −10 %). Regresión completa en verde. Pendiente para la próxima revisión: precalcular la cobertura por botica, que sigue siendo lo más costoso de la bandeja.',
    archivos: ['src/routes/vacations.js', 'scripts/prueba-carga.js'],
  },
];

const etapasDe = (tipo) => require('../src/config/mantenimiento').TIPOS[tipo].etapas;

/** El historial de un mantenimiento cerrado: una entrada por etapa cumplida */
function historialDe(r, usuarioId) {
  const etapas = etapasDe(r.tipo);
  const ini = new Date(r.fecha).getTime();
  const fin = new Date(r.cierre).getTime();
  const nota = {
    analisis: r.analisis, solucion: r.solucion, pruebas: r.pruebas, version: `Versión ${r.version} publicada`,
  };
  return [
    { etapa: 0, accion: 'REGISTRO', nota: 'Registrado', por: usuarioId, porNombre: EQUIPO, en: new Date(ini) },
    ...etapas.map((e, i) => ({
      etapa: i,
      accion: i === etapas.length - 1 ? 'CIERRE' : 'AVANCE',
      nota: `${e.etiqueta}: ${e.exige ? nota[e.exige].slice(0, 180) : i === 0 ? 'Recibido y clasificado' : 'Documentado en el CHANGELOG y en la guía'}`,
      por: usuarioId,
      porNombre: EQUIPO,
      en: new Date(ini + ((fin - ini) * (i + 1)) / etapas.length),
    })),
  ];
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Mantenimiento = require('../src/models/Mantenimiento');
  const Usuario = require('../src/models/Usuario');
  const M = require('../src/config/mantenimiento');
  const admin = await Usuario.findOne({ rol: 'ADMIN', activo: true }).select('_id').lean();

  let nuevos = 0;
  for (const r of REGISTROS) {
    if (await Mantenimiento.exists({ codigo: r.codigo })) continue;
    const doc = new Mantenimiento({
      codigo: r.codigo, tipo: r.tipo, titulo: r.titulo, descripcion: r.descripcion,
      area: r.area, prioridad: r.prioridad, origen: r.origen,
      estado: 'CERRADO', etapa: etapasDe(r.tipo).length,
      reportadoPor: admin?._id, responsable: admin?._id,
      contexto: { versionSistema: r.version },
      analisis: r.analisis, solucion: r.solucion, pruebas: r.pruebas, version: r.version, archivos: r.archivos,
      fechaLimite: M.fechaLimiteDe(r.prioridad, new Date(r.fecha)),
      cerradoEn: new Date(r.cierre),
      historial: historialDe(r, admin?._id),
      creadoEn: new Date(r.fecha),
      actualizadoEn: new Date(r.cierre),
    });
    await doc.save({ timestamps: false });
    nuevos++;
  }
  const total = await Mantenimiento.countDocuments();
  console.log(`Historial de mantenimiento: ${nuevos} registro(s) nuevo(s); ${total} en total.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
