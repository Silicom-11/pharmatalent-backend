const test = require('node:test');
const assert = require('node:assert/strict');
const { periodoPendiente } = require('../src/services/leaveRules');

// D.L. 713, art. 23: el período adquirido al cumplir N años se goza dentro del
// año siguiente; si no, se paga triple. Lo gozado cubre primero lo más antiguo.

const INGRESO = new Date(2021, 3, 10);          // 10/04/2021
const HOY = new Date(2026, 9, 23);              // 23/10/2026: 5 años cumplidos

test('cinco años sin gozar vacaciones: el primer período venció hace tiempo', () => {
  const r = periodoPendiente(INGRESO, 5, 0, HOY);
  assert.equal(r.periodo, 1);
  assert.equal(r.fechaLimite.getFullYear(), 2023);
  assert.equal(r.vencido, true);
});

test('con los cuatro primeros períodos gozados no hay riesgo', () => {
  const r = periodoPendiente(INGRESO, 5, 120, HOY);
  assert.equal(r.periodo, 5);
  assert.equal(r.fechaLimite.getFullYear(), 2027);   // el quinto se goza hasta abril de 2027
  assert.equal(r.vencido, false);
});

test('un período gozado a medias sigue siendo el más antiguo pendiente', () => {
  const r = periodoPendiente(INGRESO, 5, 100, HOY);  // 3 períodos y 10 días del cuarto
  assert.equal(r.periodo, 4);
  assert.equal(r.fechaLimite.getFullYear(), 2026);   // venció el 10/04/2026
  assert.equal(r.vencido, true);
});

test('quien aún no cumple el año no tiene nada vencido', () => {
  const r = periodoPendiente(new Date(2026, 0, 15), 0, 0, HOY);
  assert.equal(r.vencido, false);
});

test('el primer período no vence hasta cumplir dos años', () => {
  const ingreso = new Date(2025, 0, 15);          // un año cumplido, sin gozar
  assert.equal(periodoPendiente(ingreso, 1, 0, HOY).vencido, false);
  assert.equal(periodoPendiente(ingreso, 2, 0, new Date(2027, 0, 16)).vencido, true);
});
