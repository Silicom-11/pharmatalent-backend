const test = require('node:test');
const assert = require('node:assert/strict');
const { periodoDe, limitesDelPeriodo } = require('../src/services/periodo');

/**
 * El período de planilla delimita qué días entran en una boleta.
 * Si los límites se corren, o entran días de otro mes o se quedan fuera días
 * trabajados — y en ambos casos alguien cobra de menos o de más.
 */

test('deduce el período de cualquier fecha', () => {
  assert.equal(periodoDe('2026-08-29'), '2026-08');
  assert.equal(periodoDe('2026-01-01'), '2026-01');
  assert.equal(periodoDe('2026-12-31'), '2026-12');
  assert.equal(periodoDe(new Date(2026, 7, 15)), '2026-08');
});

test('el mes se escribe siempre con dos dígitos', () => {
  for (let m = 1; m <= 12; m++) {
    const p = periodoDe(new Date(2026, m - 1, 15));
    assert.match(p, /^\d{4}-\d{2}$/, `mes ${m} mal formado: ${p}`);
  }
});

test('un día de fin de mes no se escapa al mes siguiente', () => {
  // El caso que rompía en UTC: las 22:00 del 31 caían ya en el 1 del siguiente
  assert.equal(periodoDe(new Date(2026, 7, 31, 22, 0)), '2026-08');
  assert.equal(periodoDe(new Date(2026, 7, 31, 23, 59)), '2026-08');
});

test('los límites cubren el mes entero, del primero al último día', () => {
  const { desde, hasta } = limitesDelPeriodo('2026-08');
  assert.equal(desde.getDate(), 1);
  assert.equal(desde.getMonth(), 7);
  assert.equal(hasta.getDate(), 31);
  assert.equal(hasta.getMonth(), 7);
  // Y el último instante del último día, no su medianoche
  assert.equal(hasta.getHours(), 23);
  assert.equal(hasta.getMinutes(), 59);
});

test('respeta cuántos días tiene realmente cada mes', () => {
  for (const [periodo, ultimo] of [
    ['2026-01', 31], ['2026-02', 28], ['2026-04', 30],
    ['2026-11', 30], ['2026-12', 31],
    ['2028-02', 29],   // bisiesto
  ]) {
    assert.equal(limitesDelPeriodo(periodo).hasta.getDate(), ultimo,
      `${periodo} debería terminar el ${ultimo}`);
  }
});

test('los límites de meses consecutivos no se solapan ni dejan hueco', () => {
  const agosto = limitesDelPeriodo('2026-08');
  const septiembre = limitesDelPeriodo('2026-09');
  // Entre el último instante de agosto y el primero de septiembre: un milisegundo
  assert.equal(septiembre.desde - agosto.hasta, 1);
});

test('diciembre enlaza con enero del año siguiente', () => {
  const diciembre = limitesDelPeriodo('2026-12');
  const enero = limitesDelPeriodo('2027-01');
  assert.equal(diciembre.hasta.getFullYear(), 2026);
  assert.equal(enero.desde.getFullYear(), 2027);
  assert.equal(enero.desde - diciembre.hasta, 1);
});
