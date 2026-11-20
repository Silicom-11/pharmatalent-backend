/**
 * Integración: parámetros legales + motor de planilla + contratos + rutas
 * (MNT-2026-014, RMV S/ 1,230 desde el 01/10/2026 y UIT 2026 S/ 5,500).
 *
 * Las pruebas unitarias comprueban la tabla de vigencias; éstas, que el motor
 * la use con los contratos y la asistencia guardados en la base, y que las
 * rutas de alta apliquen la regla del sueldo mínimo.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { levantar, organizacion, M } = require('./_entorno');
const { computePayroll } = require('../../src/services/payroll');

let api; let org; let conHijos;

before(async () => {
  api = await levantar();
  org = await organizacion();
  conHijos = await M.Empleado.create({
    dni: '70000010', nombres: 'Con hijos', apellidos: 'Prueba Planilla', tipoProfesional: 'TECNICO',
    fechaIngreso: new Date(2025, 0, 2), cargoActual: org.cargo._id, localActual: org.localA._id,
    sueldoBasico: 1230, tieneHijos: true, sistemaPensiones: 'ONP', estado: 'ACTIVO',
  });
  await M.Contrato.create({ empleado: conHijos._id, tipo: 'INDETERMINADO', fechaInicio: new Date(2025, 0, 2), sueldo: 1230, estado: 'VIGENTE' });
});
after(async () => { await api.cerrar(); });

test('la asignación familiar de setiembre usa la RMV de 1130 y la de octubre la de 1230', async () => {
  const setiembre = await computePayroll(conHijos, '2026-09');
  const octubre = await computePayroll(conHijos, '2026-10');
  assert.equal(setiembre.ingresos.asignacionFamiliar, 113);
  assert.equal(octubre.ingresos.asignacionFamiliar, 123);
});

test('el aporte a EsSalud de octubre no baja de la base mínima de la RMV vigente', async () => {
  const octubre = await computePayroll(conHijos, '2026-10');
  assert.ok(octubre.aportesEmpleador.esSalud >= Math.round(1230 * 0.09 * 100) / 100);
});

test('un sueldo bajo la RMV vigente se rechaza al registrar un empleado', async () => {
  const cuerpo = {
    dni: '70000020', nombres: 'Nuevo', apellidos: 'Bajo Mínimo', tipoProfesional: 'TECNICO',
    fechaIngreso: new Date().toISOString().slice(0, 10), cargoActual: String(org.cargo._id), localActual: String(org.localA._id),
    sueldoBasico: 1130,
  };
  const r = await api.pedir('POST', '/employees', { token: org.tokens.gerente, cuerpo });
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /Remuneración Mínima Vital.*1230.*D\.S\. 015-2026-TR/);
  const ok = await api.pedir('POST', '/employees', { token: org.tokens.gerente, cuerpo: { ...cuerpo, sueldoBasico: 1230 } });
  assert.equal(ok.estado, 201, JSON.stringify(ok.datos));
});

test('un contrato de agosto de 2026 con S/ 1,130 era legal; uno de noviembre, no', async () => {
  const base = { empleado: String(conHijos._id), tipo: 'PLAZO_FIJO', sueldo: 1130 };
  const agosto = await api.pedir('POST', '/contracts', { token: org.tokens.gerente, cuerpo: { ...base, fechaInicio: '2026-08-01', fechaFin: '2026-09-30' } });
  assert.equal(agosto.estado, 201, JSON.stringify(agosto.datos));
  const noviembre = await api.pedir('POST', '/contracts', { token: org.tokens.gerente, cuerpo: { ...base, fechaInicio: '2026-11-01', fechaFin: '2027-04-30' } });
  assert.equal(noviembre.estado, 400);
});

test('el tiempo parcial se paga en proporción y queda fuera del mínimo', async () => {
  const r = await api.pedir('POST', '/contracts', {
    token: org.tokens.gerente,
    cuerpo: { empleado: String(conHijos._id), tipo: 'PART_TIME', sueldo: 700, fechaInicio: '2026-11-01', fechaFin: '2027-04-30' },
  });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
});

test('subir un sueldo por debajo del mínimo se rechaza al editar el legajo', async () => {
  const r = await api.pedir('PUT', `/employees/${conHijos._id}`, { token: org.tokens.gerente, cuerpo: { sueldoBasico: 1200, motivo: 'Prueba' } });
  assert.equal(r.estado, 400);
});
