const test = require('node:test');
const assert = require('node:assert/strict');
const { aFechaLocal, inicioDelDia, finDelDia, comoYMD, comoTexto } = require('../src/utils/fechas');

test('«2026-08-29» es el 29 de agosto aquí, no el 28', () => {
  // El fallo clásico: interpretarla en UTC y perder un día al mostrarla en Perú
  const f = aFechaLocal('2026-08-29');
  assert.equal(f.getFullYear(), 2026);
  assert.equal(f.getMonth(), 7);      // agosto
  assert.equal(f.getDate(), 29);
  assert.equal(comoYMD(f), '2026-08-29');
  assert.equal(comoTexto(f), '29/08/2026');
});

test('el día no se corre en ningún mes del año', () => {
  for (let m = 1; m <= 12; m++) {
    const texto = `2026-${String(m).padStart(2, '0')}-01`;
    assert.equal(comoYMD(aFechaLocal(texto)), texto, `se corrió en ${texto}`);
  }
});

test('respeta las fechas con hora explícita', () => {
  const f = aFechaLocal('2026-08-29T14:30:00');
  assert.equal(f.getHours(), 14);
  assert.equal(f.getMinutes(), 30);
});

test('acepta un Date tal cual y rechaza lo que no es fecha', () => {
  const d = new Date(2026, 7, 29);
  assert.equal(aFechaLocal(d), d);
  assert.equal(aFechaLocal('no es una fecha'), null);
  assert.equal(aFechaLocal(null), null);
  assert.equal(aFechaLocal(undefined), null);
  assert.equal(aFechaLocal(''), null);
});

test('el fin del día cubre cualquier hora de hoy', () => {
  // Registrar un pago «hoy a las 3 de la tarde» no debe leerse como futuro
  const hoy3pm = new Date();
  hoy3pm.setHours(15, 0, 0, 0);
  assert.ok(hoy3pm <= finDelDia(), 'una hora de hoy no puede quedar fuera de hoy');
  assert.ok(inicioDelDia() <= hoy3pm);
});

test('un año bisiesto no descuadra el 29 de febrero', () => {
  assert.equal(comoYMD(aFechaLocal('2028-02-29')), '2028-02-29');
});

test('comoTexto no revienta con una fecha ausente', () => {
  assert.equal(comoTexto(null), '—');
  assert.equal(comoTexto('cualquier cosa'), '—');
});
