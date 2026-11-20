const test = require('node:test');
const assert = require('node:assert/strict');
const { validarContrasena, generarTemporal, LONGITUD_MINIMA } = require('../src/routes/users');

const correo = 'prueba.acceso@pharmatalent.pe';

test('rechaza contraseñas demasiado cortas', () => {
  const p = validarContrasena('Ab1', correo);
  assert.ok(p.some((x) => x.includes(String(LONGITUD_MINIMA))));
});

test('exige mayúsculas y minúsculas', () => {
  assert.ok(validarContrasena('sinmayusculas123', correo).some((x) => /may|min/i.test(x)));
  assert.ok(validarContrasena('SINMINUSCULAS123', correo).some((x) => /may|min/i.test(x)));
});

test('exige al menos un número', () => {
  assert.ok(validarContrasena('SinNumerosAqui', correo).some((x) => /número/i.test(x)));
});

test('rechaza el nombre de la cuenta aunque cambien los separadores', () => {
  // "prueba.acceso" y "PruebaAcceso" son el mismo nombre para este control
  for (const intento of ['PruebaAcceso99', 'prueba.acceso2026', 'Prueba-Acceso-99']) {
    assert.ok(
      validarContrasena(intento, correo).some((x) => /nombre de la cuenta/i.test(x)),
      `debió rechazar ${intento}`
    );
  }
});

test('rechaza contraseñas de uso común', () => {
  assert.ok(validarContrasena('MiPassword123', correo).some((x) => /común/i.test(x)));
  assert.ok(validarContrasena('Admin123456', correo).some((x) => /común/i.test(x)));
});

test('acepta una contraseña que cumple todo', () => {
  assert.deepEqual(validarContrasena('Manzana2026Verde', correo), []);
});

test('un nombre de cuenta muy corto no invalida cualquier contraseña', () => {
  // Con cuentas como "rh@" no debe bloquearse toda contraseña que contenga "rh"
  assert.deepEqual(validarContrasena('Manzana2026Verde', 'rh@pharmatalent.pe'), []);
});

test('la contraseña temporal cumple la propia política', () => {
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(validarContrasena(generarTemporal(), correo), [],
      'la temporal generada debe pasar el propio validador');
  }
});

test('dos temporales consecutivas no coinciden', () => {
  assert.notEqual(generarTemporal(), generarTemporal());
});
