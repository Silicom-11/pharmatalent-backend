const test = require('node:test');
const assert = require('node:assert/strict');
const { limpiar, accionDeRuta, moduloDeRuta, describir, CAMPOS_OCULTOS } = require('../src/middleware/bitacora');
const { revisarEntorno, origenesPermitidos } = require('../src/config/entorno');

// ─── Qué NO debe quedar escrito ──────────────────────────────────────────────

test('la bitácora nunca guarda contraseñas ni cuentas bancarias', () => {
  const limpio = limpiar({
    correo: 'ana@pharmatalent.pe',
    contrasena: 'Secreta2026',
    newPassword: 'Otra2026',
    cuentaBancaria: '191-1234567890',
    cuspp: '123456ABCDE7',
    rol: 'TECNICO',
  });
  assert.equal(limpio.contrasena, '«oculto»');
  assert.equal(limpio.newPassword, '«oculto»');
  assert.equal(limpio.cuentaBancaria, '«oculto»');
  assert.equal(limpio.cuspp, '«oculto»');
  // Lo que sí importa para auditar se conserva
  assert.equal(limpio.correo, 'ana@pharmatalent.pe');
  assert.equal(limpio.rol, 'TECNICO');
});

test('oculta los campos sensibles también dentro de objetos anidados', () => {
  const limpio = limpiar({ cuenta: { datos: { contrasena: 'x', nombre: 'Ana' } } });
  assert.equal(limpio.cuenta.datos.contrasena, '«oculto»');
  assert.equal(limpio.cuenta.datos.nombre, 'Ana');
});

test('recorta los textos largos en vez de guardarlos enteros', () => {
  const largo = 'a'.repeat(2000);
  const limpio = limpiar({ observaciones: largo });
  assert.ok(limpio.observaciones.length < 600);
  assert.match(limpio.observaciones, /2000 caracteres/);
});

test('no se cuelga con estructuras muy profundas', () => {
  let nodo = { fin: 'aquí' };
  for (let i = 0; i < 30; i++) nodo = { dentro: nodo };
  assert.doesNotThrow(() => limpiar(nodo));
});

test('la lista de campos ocultos cubre las credenciales del sistema', () => {
  for (const campo of ['contrasena', 'newPassword', 'currentPassword', 'token']) {
    assert.ok(CAMPOS_OCULTOS.includes(campo), `falta ocultar ${campo}`);
  }
});

// ─── Cómo se nombra lo ocurrido ──────────────────────────────────────────────

test('reconoce el módulo a partir de la ruta', () => {
  assert.equal(moduloDeRuta('/api/payroll/123/aprobar'), 'payroll');
  assert.equal(moduloDeRuta('/api/vacations'), 'vacations');
  assert.equal(moduloDeRuta('/api/me/attendance/clock-in'), 'me');
});

test('una aprobación no se registra como una modificación cualquiera', () => {
  assert.equal(accionDeRuta('PUT', '/api/vacations/123/approve'), 'APROBAR');
  assert.equal(accionDeRuta('PUT', '/api/vacations/123/reject'), 'RECHAZAR');
  assert.equal(accionDeRuta('PUT', '/api/schedules/123/publicar'), 'PUBLICAR');
  assert.equal(accionDeRuta('PUT', '/api/users/123/role'), 'CAMBIAR_ROL');
  assert.equal(accionDeRuta('PUT', '/api/users/123/reset-password'), 'RESTABLECER_CLAVE');
  // Sin sufijo reconocible se cae al verbo HTTP
  assert.equal(accionDeRuta('PUT', '/api/employees/123'), 'MODIFICAR');
  assert.equal(accionDeRuta('POST', '/api/employees'), 'CREAR');
});

test('la descripción se lee sin conocer la API', () => {
  assert.equal(describir('APROBAR', 'vacations'), 'Aprobó un descanso');
  assert.equal(describir('CREAR', 'contracts'), 'Registró un nuevo contrato');
  assert.match(describir('CALCULAR', 'payroll', { periodo: '2026-08' }), /2026-08/);
  assert.match(describir('CAMBIAR_ROL', 'users', { rol: 'ADMIN' }), /ADMIN/);
});

// ─── El guardián del entorno ─────────────────────────────────────────────────

test('no deja arrancar sin cadena de conexión ni secreto', () => {
  const { errores } = revisarEntorno({});
  assert.ok(errores.some((e) => e.includes('MONGODB_URI')));
  assert.ok(errores.some((e) => e.includes('JWT_SECRET')));
});

test('en producción rechaza un secreto de ejemplo o demasiado corto', () => {
  const base = { MONGODB_URI: 'mongodb://x', CORS_ORIGINS: 'https://x', NODE_ENV: 'production' };
  for (const secreto of ['secret', 'changeme123', 'pharmatalent2026']) {
    const { errores } = revisarEntorno({ ...base, JWT_SECRET: secreto });
    assert.ok(errores.some((e) => e.includes('JWT_SECRET')), `debió rechazar "${secreto}"`);
  }
});

test('en desarrollo un secreto flojo sólo avisa, no impide trabajar', () => {
  const r = revisarEntorno({ MONGODB_URI: 'mongodb://x', JWT_SECRET: 'secret', NODE_ENV: 'development' });
  assert.equal(r.errores.length, 0);
  assert.ok(r.avisos.some((a) => a.includes('JWT_SECRET')));
});

test('acepta una configuración de producción bien formada', () => {
  const { errores } = revisarEntorno({
    MONGODB_URI: 'mongodb://servidor/pharmatalent',
    JWT_SECRET: require('crypto').randomBytes(48).toString('hex'),
    JWT_EXPIRES_IN: '8h',
    CORS_ORIGINS: 'https://pharmatalent.inretail.pe',
    NODE_ENV: 'production',
  });
  assert.equal(errores.length, 0);
});

test('en producción exige declarar los orígenes autorizados', () => {
  const { errores } = revisarEntorno({
    MONGODB_URI: 'mongodb://x',
    JWT_SECRET: require('crypto').randomBytes(48).toString('hex'),
    NODE_ENV: 'production',
  });
  assert.ok(errores.some((e) => e.includes('CORS_ORIGINS')));
});

test('los orígenes se leen separados por coma', () => {
  const o = origenesPermitidos({ CORS_ORIGINS: 'https://a.pe, https://b.pe ,https://c.pe' });
  assert.deepEqual(o, ['https://a.pe', 'https://b.pe', 'https://c.pe']);
});

test('las frases concuerdan en género', () => {
  assert.equal(describir('MODIFICAR', 'notifications'), 'Modificó una notificación');
  assert.equal(describir('CREAR', 'evaluations'), 'Registró una nueva evaluación');
  assert.equal(describir('CREAR', 'contracts'), 'Registró un nuevo contrato');
  assert.equal(describir('ELIMINAR', 'zones'), 'Eliminó una zona');
  assert.match(describir('CALCULAR', 'payroll'), /^Calculó la planilla/);
});
