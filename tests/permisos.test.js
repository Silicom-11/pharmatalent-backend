const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROLES, ROLE_CODES, can } = require('../src/config/roles');

const RUTAS = path.join(__dirname, '..', 'src', 'routes');

/**
 * Rutas que legítimamente no consultan la matriz de permisos porque devuelven
 * datos del propio usuario o material de referencia sin información personal.
 */
const SIN_GUARDA_JUSTIFICADA = {
  'auth.js': ["'/me'", "'/password-policy'"],
  'me.js': ["'/profile'", "'/schedule'", "'/attendance'", "'/trainings'", "'/payroll'"],
  'meSelfService.js': ["'/attendance/today'", "'/vacations'", "'/contracts'", "'/payroll/:id/boleta'", "'/evaluations'"],
  // El terminal de marcación no tiene usuario ni rol: se autentica con la
  // clave del dispositivo (cabeceras X-Terminal-*), que la ruta verifica
  'terminal.js': ["'/estado'"],
  'notifications.js': ["'/'", "'/count'"],
  'org.js': ["'/catalog'"],
  'schedules.js': ["'/formats'"],
  // Las evaluaciones propias pendientes de firma: filtra por req.user.employee
  'evaluations.js': ["'/mias/pendientes'"],
  'dashboard.js': ["'/summary'", "'/qf-coverage'", "'/zone-overview'", "'/cedi-overview'"],
  // Dice si el modo exposición está activo y con qué cuentas: sin datos personales
  'exposicion.js': ["'/'"],
  // Tipos y etapas del mantenimiento (referencia) y los reportes propios
  // (filtra por reportadoPor: req.usuario._id)
  'mantenimiento.js': ["'/catalogo'", "'/mis-reportes'"],
};

const archivos = fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'));

test('toda ruta de lectura consulta la matriz de permisos', () => {
  const desprotegidas = [];

  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    const permitidas = SIN_GUARDA_JUSTIFICADA[archivo] || [];

    for (const linea of contenido.split('\n')) {
      const m = linea.match(/^router\.get\((\s*'[^']+')/);
      if (!m) continue;
      const ruta = m[1].trim();
      if (linea.includes('permit(')) continue;
      if (permitidas.includes(ruta)) continue;
      desprotegidas.push(`${archivo} GET ${ruta}`);
    }
  }

  assert.deepEqual(desprotegidas, [],
    'estas rutas exponen datos sin verificar permisos:\n  ' + desprotegidas.join('\n  '));
});

test('toda ruta de escritura consulta la matriz de permisos', () => {
  const desprotegidas = [];
  const permitidasPorArchivo = {
    // Recuperar la contraseña es previo a tener sesión: no hay rol que consultar
    'auth.js': ["'/login'", "'/change-password'", "'/recuperar'", "'/recuperar/canjear'"],
    'me.js': [],
    // El autoservicio actúa siempre sobre el usuario autenticado
    'meSelfService.js': null,
    // Marcar como leída una notificación propia: el filtro es user: req.user._id
    'notifications.js': ["'/read-all'", "'/:id/read'"],
    // Firmar la propia evaluación: la ruta comprueba que el firmante sea el evaluado
    'evaluations.js': ["'/:id/firmar'"],
    // Firmar la propia liquidación: sólo el interesado, y la ruta lo comprueba
    'settlements.js': ["'/:id/firmar'"],
    // El terminal se autentica con la clave del dispositivo, no con un rol
    'terminal.js': ["'/marcar'"],
    // Sólo existe con MODO_EXPOSICION y fuera de producción, y sólo para las
    // cuatro cuentas de demostración de config/exposicion.js
    'exposicion.js': ["'/ingresar'"],
    // Cualquier persona con sesión reporta un error o sugiere una mejora: el
    // reporte queda a su nombre y no toca datos de nadie más
    'mantenimiento.js': ["'/reportes'"],
  };

  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    // El autoservicio actúa siempre sobre el propio usuario
    if (permitidasPorArchivo[archivo] === null) continue;
    const permitidas = permitidasPorArchivo[archivo] || [];

    for (const linea of contenido.split('\n')) {
      const m = linea.match(/^router\.(post|put|patch|delete)\((\s*'[^']+')/);
      if (!m) continue;
      const ruta = m[2].trim();
      if (linea.includes('permit(')) continue;
      if (permitidas.includes(ruta)) continue;
      desprotegidas.push(`${archivo} ${m[1].toUpperCase()} ${ruta}`);
    }
  }

  assert.deepEqual(desprotegidas, [],
    'estas rutas modifican datos sin verificar permisos:\n  ' + desprotegidas.join('\n  '));
});

test('ningún rol operativo puede leer contratos ajenos', () => {
  const { ROLES } = require('../src/config/roles');
  const operativos = ['TRAINEE', 'CAJERO', 'TECNICO', 'MOTORIZADO', 'PREVENCIONISTA',
    'DERMOCONSULTOR', 'AUX_ALMACEN', 'QF_ASISTENTE', 'OPERARIO_CEDI'];

  for (const rol of operativos) {
    assert.ok(!ROLES[rol].permissions.contracts,
      `${rol} no debe tener acceso al módulo de contratos`);
    assert.ok(!ROLES[rol].permissions.payroll,
      `${rol} no debe tener acceso al módulo de planilla`);
    assert.ok(!ROLES[rol].permissions.positions,
      `${rol} no debe ver las escalas salariales`);
  }
});

test('sólo los roles de alcance nacional aprueban planilla', () => {
  const { ROLES, ROLE_CODES } = require('../src/config/roles');
  for (const codigo of ROLE_CODES) {
    const p = ROLES[codigo].permissions.payroll;
    if (p?.includes('A')) {
      assert.equal(ROLES[codigo].scope, 'NATIONAL',
        `${codigo} aprueba planilla pero su alcance es ${ROLES[codigo].scope}`);
    }
  }
});

test('todo trabajador ve su turno, marca su asistencia y pide sus descansos', () => {
  // Derechos que no dependen del puesto: D.L. 713 alcanza a toda la planilla
  const BASICOS = ['dashboard', 'schedules', 'attendance', 'vacations'];
  const trabajadores = ROLE_CODES.filter(
    (c) => !ROLES[c].deprecated && ROLES[c].scope === 'SELF'
  );

  assert.ok(trabajadores.length > 5, 'debería haber varios roles de alcance propio');

  for (const rol of trabajadores) {
    for (const modulo of BASICOS) {
      assert.ok(
        can(rol, modulo, 'read'),
        `${ROLES[rol].etiqueta} no puede ver «${modulo}»`
      );
    }
    // Pedir las propias vacaciones es autoservicio (/me/vacations) y no pasa
    // por el permiso del módulo; «vacations: write» es decidir las de otros,
    // y eso no le corresponde a quien sólo tiene alcance sobre sí mismo
    assert.ok(
      !can(rol, 'vacations', 'write'),
      `${ROLES[rol].etiqueta} puede avalar solicitudes de terceros`
    );
  }
  // ...y el autoservicio existe para todos, sin depender del rol
  const autoservicio = fs.readFileSync(path.join(RUTAS, 'meSelfService.js'), 'utf8');
  assert.match(autoservicio, /router\.post\('\/vacations'/, 'falta la solicitud de vacaciones por autoservicio');
});

test('todo tipo de notificación que emite una ruta existe en el modelo', () => {
  // Un tipo no declarado hace fallar la creación con ValidationError, y si la
  // ruta no lo aísla, la operación de negocio se cae con ella
  const Notificacion = require('../src/models/Notificacion');
  const declarados = new Set(Notificacion.schema.path('tipo').enumValues);

  const usados = new Set();
  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    for (const m of contenido.matchAll(/tipo:\s*'([A-Z_]+)'/g)) usados.add(m[1]);
  }

  const huerfanos = [...usados].filter((t) => !declarados.has(t));
  assert.deepEqual(huerfanos, [],
    'estos tipos se emiten pero no están en el enum de Notification:\n  ' + huerfanos.join('\n  '));
});

test('el analizador de consultas no convierte corchetes en objetos', () => {
  // 19 rutas meten un parámetro de consulta directo en el filtro de Mongo.
  // Con el analizador «extended», ?status[$ne]=X llegaría como objeto y ese
  // operador se ejecutaría contra la base
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /app\.set\('query parser', 'simple'\)/,
    'app.js debe declarar el analizador de consultas explícitamente');
});

test('cerrar sesión se dispara donde debe', () => {
  // Un token válido tiene que dejar de serlo cuando cambia lo que lleva grabado
  // o cuando se revoca el acceso: si no, cesar a alguien no le quita nada
  const users = fs.readFileSync(path.join(RUTAS, 'users.js'), 'utf8');
  const auth = fs.readFileSync(path.join(RUTAS, 'auth.js'), 'utf8');
  const settlements = fs.readFileSync(path.join(RUTAS, 'settlements.js'), 'utf8');

  const disparadores = [
    ['cambio de rol', users, /rol = rol;[\s\S]{0,200}cerrarSesiones/],
    ['revocación de acceso', users, /desactivadoPor[\s\S]{0,200}cerrarSesiones/],
    ['restablecimiento de contraseña', users, /debeCambiarContrasena = true;[\s\S]{0,200}cerrarSesiones/],
    ['cambio de la propia contraseña', auth, /contrasenaCambiadaEn[\s\S]{0,200}cerrarSesiones/],
    ['recuperación de contraseña', auth, /recuperacion\.usadaEn[\s\S]{0,300}cerrarSesiones/],
    ['cese del empleado', settlements, /versionToken/],
  ];

  const sinCerrar = disparadores
    .filter(([, texto, patron]) => !patron.test(texto))
    .map(([nombre]) => nombre);

  assert.deepEqual(sinCerrar, [],
    `estas operaciones dejarían sesiones abiertas:\n  ${sinCerrar.join('\n  ')}`);
});
