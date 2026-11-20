const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/config/mantenimiento');
const P = require('../src/config/payrollParams');
const { revisarSueldoMinimo } = require('../src/services/sueldoMinimo');

// ─── El proceso de cada tipo es el de la GP 08 ───────────────────────────────

test('los cuatro tipos de mantenimiento de la GP 08 existen', () => {
  assert.deepEqual(M.TIPOS_CODIGOS, ['CORRECTIVO', 'ADAPTATIVO', 'PERFECTIVO', 'PREVENTIVO']);
});

test('cada tipo tiene las etapas de su proceso general', () => {
  assert.equal(M.etapasDe('CORRECTIVO').length, 6);
  assert.equal(M.etapasDe('ADAPTATIVO').length, 6);
  assert.equal(M.etapasDe('PERFECTIVO').length, 6);
  assert.equal(M.etapasDe('PREVENTIVO').length, 5);
  assert.equal(M.etapasDe('CORRECTIVO')[0].etiqueta, 'Recepción del informe de error');
  assert.equal(M.etapasDe('CORRECTIVO').at(-1).etiqueta, 'Documentación de la corrección');
});

test('cada proceso exige análisis, solución y pruebas antes de cerrarse', () => {
  for (const tipo of M.TIPOS_CODIGOS) {
    const exige = M.etapasDe(tipo).map((e) => e.exige).filter(Boolean);
    for (const campo of ['analisis', 'solucion', 'pruebas']) {
      assert.ok(exige.includes(campo), `${tipo} no exige ${campo}`);
    }
  }
});

// ─── Reglas de avance (caja blanca: cada rama de motivoParaNoAvanzar) ───────

test('no avanza un mantenimiento cerrado ni uno descartado', () => {
  assert.match(M.motivoParaNoAvanzar({ tipo: 'CORRECTIVO', estado: 'CERRADO', etapa: 6 }), /cerrado/);
  assert.match(M.motivoParaNoAvanzar({ tipo: 'CORRECTIVO', estado: 'DESCARTADO', etapa: 2 }), /descartado/);
});

test('no sale del análisis sin el análisis escrito', () => {
  const r = { tipo: 'CORRECTIVO', estado: 'EN_CURSO', etapa: 1 };
  assert.match(M.motivoParaNoAvanzar(r), /análisis/);
  assert.match(M.motivoParaNoAvanzar({ ...r, analisis: '   ' }), /análisis/, 'sólo espacios no cuenta');
  assert.equal(M.motivoParaNoAvanzar({ ...r, analisis: 'Causa encontrada' }), null);
});

test('no sale del despliegue sin la versión', () => {
  const r = { tipo: 'CORRECTIVO', estado: 'EN_CURSO', etapa: 4, analisis: 'a', solucion: 's', pruebas: 'p' };
  assert.match(M.motivoParaNoAvanzar(r), /versión/);
  assert.equal(M.motivoParaNoAvanzar({ ...r, version: '1.1.0' }), null);
});

test('una etapa sin exigencias avanza libremente', () => {
  assert.equal(M.motivoParaNoAvanzar({ tipo: 'PREVENTIVO', estado: 'ABIERTO', etapa: 0 }), null);
});

test('el estado sigue a la etapa', () => {
  assert.equal(M.estadoDeEtapa('CORRECTIVO', 0), 'ABIERTO');
  assert.equal(M.estadoDeEtapa('CORRECTIVO', 3), 'EN_CURSO');
  assert.equal(M.estadoDeEtapa('CORRECTIVO', 6), 'CERRADO');
  assert.equal(M.estadoDeEtapa('PREVENTIVO', 5), 'CERRADO');
});

test('el plazo de atención depende de la prioridad', () => {
  const desde = new Date(2026, 10, 13);
  const dias = (p) => (M.fechaLimiteDe(p, desde) - desde) / 86400000;
  assert.equal(dias('CRITICA'), 1);
  assert.equal(dias('ALTA'), 3);
  assert.equal(dias('MEDIA'), 7);
  assert.equal(dias('BAJA'), 15);
  assert.equal(dias('DESCONOCIDA'), 7, 'una prioridad no declarada usa el plazo medio');
});

// ─── Parámetros legales con vigencia (MNT-2026-014) ─────────────────────────

test('la RMV depende de la fecha: 1130 hasta setiembre de 2026, 1230 desde octubre', () => {
  assert.equal(P.rmvVigente(new Date(2026, 8, 30)), 1130);
  assert.equal(P.rmvVigente(new Date(2026, 9, 1)), 1230);
  assert.equal(P.rmvVigente(new Date(2024, 5, 1)), 1025);
  assert.equal(P.rmvVigenteDetalle(new Date(2026, 10, 13)).norma, 'D.S. 015-2026-TR');
});

test('la RMV de un período es la de su último día', () => {
  assert.equal(P.rmvDelPeriodo('2026-09'), 1130);
  assert.equal(P.rmvDelPeriodo('2026-10'), 1230);
});

test('la UIT es la de cada ejercicio', () => {
  assert.equal(P.uitDe(2025), 5350);
  assert.equal(P.uitDe(2026), 5500);
  assert.equal(P.uitDetalle(2026).norma, 'D.S. 301-2025-EF');
});

test('un año sin UIT registrada usa la última conocida y lo avisa', () => {
  const u = P.uitDetalle(2031);
  assert.equal(u.registrada, false);
  assert.equal(u.valor, P.VIGENCIAS_UIT.at(-1).valor);
});

test('las tablas de vigencia están en orden y sin fechas repetidas', () => {
  const desde = P.VIGENCIAS_RMV.map((v) => v.desde);
  assert.deepEqual([...desde].sort(), desde);
  assert.equal(new Set(desde).size, desde.length);
  const anios = P.VIGENCIAS_UIT.map((u) => u.anio);
  assert.deepEqual([...anios].sort((a, b) => a - b), anios);
});

// ─── Sueldo mínimo (caja negra: entradas y salidas) ──────────────────────────

test('rechaza un sueldo bajo la RMV de su fecha y explica cuál es', () => {
  const motivo = revisarSueldoMinimo(1130, { fecha: new Date(2026, 10, 1) });
  assert.match(motivo, /1230\.00/);
  assert.match(motivo, /D\.S\. 015-2026-TR/);
});

test('acepta el mismo sueldo en una fecha en que era legal', () => {
  assert.equal(revisarSueldoMinimo(1130, { fecha: new Date(2026, 7, 1) }), null);
});

test('valores límite: la RMV exacta pasa y un céntimo menos no', () => {
  const nov = new Date(2026, 10, 1);
  assert.equal(revisarSueldoMinimo(1230, { fecha: nov }), null);
  assert.notEqual(revisarSueldoMinimo(1229.99, { fecha: nov }), null);
});

test('el tiempo parcial y un monto ausente quedan fuera de la regla', () => {
  assert.equal(revisarSueldoMinimo(600, { fecha: new Date(2026, 10, 1), tipoContrato: 'PART_TIME' }), null);
  assert.equal(revisarSueldoMinimo(undefined), null);
});
