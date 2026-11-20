/**
 * Integración: terminal de marcación + turnos + asistencia (MNT-2026-012).
 *
 * La regla corregida sólo existe cuando se juntan las piezas: la jornada se
 * abre en un local (asistencia), el turno dice dónde trabaja (turnos) y el
 * terminal identifica el lugar con su clave (terminal). Se prueba con las
 * tres a la vez, por HTTP, como lo usa la botica.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { levantar, organizacion, hoy0, M } = require('./_entorno');

let api; let org;
const marcar = (local, clave, dni) => api.pedir('POST', '/terminal/marcar', {
  cabeceras: { 'X-Terminal-Local': local, 'X-Terminal-Clave': clave }, cuerpo: { dni, metodo: 'DNI' },
});

before(async () => {
  api = await levantar();
  org = await organizacion();
  // Turno de hoy del técnico en la botica A
  await M.Turno.create({
    horario: new mongoose.Types.ObjectId(), local: org.localA._id, fecha: hoy0(),
    tipoTurno: 'MANANA', horaInicio: '08:00', horaFin: '15:00',
    asignaciones: [{ empleado: org.tecnico._id, rol: 'TECNICO' }],
  });
});
after(async () => { await api.cerrar(); });

test('un equipo sin la clave del terminal no puede marcar', async () => {
  const r = await marcar('IKF-T01', 'otra-clave', '70000001');
  assert.equal(r.estado, 401);
});

test('con turno hoy, la primera marca es la ENTRADA', async () => {
  const r = await marcar('IKF-T01', org.clave.A, '70000001');
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  assert.equal(r.datos.accion, 'ENTRADA');
});

test('quien no tiene turno hoy es rechazado', async () => {
  const r = await marcar('IKF-T01', org.clave.A, '70000002');
  assert.equal(r.estado, 404);
  assert.match(r.datos.error, /No tiene turno asignado hoy/);
});

test('MNT-2026-012 · con la jornada abierta en A, el terminal de B no registra la salida', async () => {
  // La entrada fue hace tres horas: no es una lectura repetida
  await M.Asistencia.updateOne({ empleado: org.tecnico._id }, { marcaEntrada: new Date(Date.now() - 3 * 3600000) });
  const r = await marcar('MIF-T02', org.clave.B, '70000001');
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /abierta en Inkafarma Prueba Real/);
  const a = await M.Asistencia.findOne({ empleado: org.tecnico._id }).lean();
  assert.equal(a.marcaSalida, undefined, 'la salida no debe quedar registrada');
});

test('en su propio local, la segunda marca es la SALIDA', async () => {
  const r = await marcar('IKF-T01', org.clave.A, '70000001');
  assert.equal(r.estado, 201);
  assert.equal(r.datos.accion, 'SALIDA');
  const a = await M.Asistencia.findOne({ empleado: org.tecnico._id }).lean();
  assert.ok(a.marcaSalida);
  assert.equal(String(a.local), String(org.localA._id));
});

test('con la jornada cerrada no se abre otra el mismo día', async () => {
  const r = await marcar('IKF-T01', org.clave.A, '70000001');
  assert.equal(r.estado, 409);
});
