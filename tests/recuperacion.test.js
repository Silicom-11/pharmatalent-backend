const test = require('node:test');
const assert = require('node:assert/strict');
const rec = require('../src/services/recuperacion');

/**
 * El código de recuperación es, durante media hora, tan bueno como la
 * contraseña. Su seguridad no descansa en la longitud —seis dígitos se dictan
 * por teléfono, que es el punto— sino en la vigencia corta y el corte por
 * intentos.
 */

test('el código tiene seis dígitos, siempre', () => {
  for (let i = 0; i < 500; i++) {
    const c = rec.generarCodigo();
    assert.match(c, /^\d{6}$/, `código mal formado: ${c}`);
  }
});

test('los códigos no se repiten con facilidad', () => {
  const vistos = new Set();
  for (let i = 0; i < 5000; i++) vistos.add(rec.generarCodigo());
  // Con un millón de posibles, 5000 extracciones repiten unas pocas veces
  assert.ok(vistos.size > 4950, `demasiadas repeticiones: ${5000 - vistos.size}`);
});

test('los dígitos se reparten sin sesgo', () => {
  // El módulo directo sobre bytes favorecería los valores bajos
  const conteo = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) {
    for (const d of rec.generarCodigo()) conteo[Number(d)]++;
  }
  const esperado = (20000 * 6) / 10;
  for (let d = 0; d < 10; d++) {
    const desvio = Math.abs(conteo[d] - esperado) / esperado;
    assert.ok(desvio < 0.08, `el dígito ${d} aparece un ${(desvio * 100).toFixed(1)}% fuera de lo esperado`);
  }
});

test('sólo se guarda la huella, nunca el código', () => {
  const s = rec.nuevaSolicitud();
  assert.match(s.huella, /^[0-9a-f]{64}$/);
  assert.notEqual(s.huella, s.codigo);
  assert.ok(!s.huella.includes(s.codigo), 'la huella no debe contener el código');
});

test('la huella permite verificar sin poder deshacerse', () => {
  const c = rec.generarCodigo();
  assert.equal(rec.coincide(c, rec.huella(c)), true);
  assert.equal(rec.coincide('000000', rec.huella(c)), false);
});

test('la comparación no revienta con entradas ausentes o deformes', () => {
  assert.equal(rec.coincide(null, 'abc'), false);
  assert.equal(rec.coincide('123456', null), false);
  assert.equal(rec.coincide('123456', 'no-es-una-huella'), false);
  assert.equal(rec.coincide('', ''), false);
});

// ─── Vigencia y agotamiento ──────────────────────────────────────────────────

test('una solicitud recién creada es canjeable', () => {
  const s = rec.nuevaSolicitud();
  assert.equal(rec.estadoDeSolicitud(s).valida, true);
  assert.ok(rec.minutosRestantes(s) > 0);
  assert.ok(rec.minutosRestantes(s) <= rec.VIGENCIA_MINUTOS);
});

test('un código caducado deja de servir', () => {
  const s = rec.nuevaSolicitud();
  s.expiraEn = new Date(Date.now() - 1000);
  const r = rec.estadoDeSolicitud(s);
  assert.equal(r.valida, false);
  assert.match(r.motivo, /caducó/);
  assert.equal(rec.minutosRestantes(s), 0);
});

test('un código ya usado no se reutiliza', () => {
  const s = { ...rec.nuevaSolicitud(), usadaEn: new Date() };
  const r = rec.estadoDeSolicitud(s);
  assert.equal(r.valida, false);
  assert.match(r.motivo, /ya fue utilizado/);
});

test('el código muere tras los intentos permitidos', () => {
  const s = { ...rec.nuevaSolicitud(), intentos: rec.MAX_INTENTOS_CANJE };
  const r = rec.estadoDeSolicitud(s);
  assert.equal(r.valida, false);
  assert.match(r.motivo, /intentos fallidos/);
});

test('sin solicitud en curso no hay nada que canjear', () => {
  assert.equal(rec.estadoDeSolicitud(null).valida, false);
  assert.equal(rec.estadoDeSolicitud({}).valida, false);
  assert.equal(rec.estadoDeSolicitud({ huella: null }).valida, false);
});

// ─── Los parámetros son la defensa ───────────────────────────────────────────

test('la vigencia es corta y los intentos pocos', () => {
  // Seis dígitos sólo son seguros si la ventana de ataque es estrecha
  assert.ok(rec.VIGENCIA_MINUTOS <= 60, 'un código que dura horas es un código robado con tiempo');
  assert.ok(rec.MAX_INTENTOS_CANJE <= 10, 'demasiados intentos hacen viable la fuerza bruta');

  const probabilidad = rec.MAX_INTENTOS_CANJE / 1000000;
  assert.ok(probabilidad < 0.00001,
    `probabilidad de acierto por fuerza bruta demasiado alta: ${probabilidad}`);
});

test('se acota cuántas veces se puede pedir en la misma hora', () => {
  assert.ok(rec.MAX_SOLICITUDES >= 1 && rec.MAX_SOLICITUDES <= 5);
  assert.ok(rec.VENTANA_SOLICITUDES_MINUTOS >= 15);
});
