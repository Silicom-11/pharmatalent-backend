/**
 * Integración incremental del módulo de mantenimiento (MNT-2026-015/016).
 *
 * Cada nivel suma un componente al anterior y se prueba sólo lo que agrega:
 *   1. modelo + base de datos
 *   2. + ruta y validación (HTTP)
 *   3. + autenticación y matriz de permisos
 *   4. + proceso por etapas y notificaciones
 *   5. + monitoreo: manejador de errores → registro → correctivo
 * Si un nivel falla, el defecto está en lo último que se integró.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { levantar, organizacion, M } = require('./_entorno');

let api; let org; let idReporte;

before(async () => {
  api = await levantar();
  org = await organizacion();
});
after(async () => { await api.cerrar(); });

// ─── Nivel 1 · Modelo + base de datos ────────────────────────────────────────
test('N1 · el código MNT es correlativo por año y no se repite', async () => {
  const a = await M.Mantenimiento.create({ tipo: 'PREVENTIVO', titulo: 'Primera revisión', descripcion: 'Revisión de prueba uno' });
  const b = await M.Mantenimiento.create({ tipo: 'PREVENTIVO', titulo: 'Segunda revisión', descripcion: 'Revisión de prueba dos' });
  const anio = new Date().getFullYear();
  assert.equal(a.codigo, `MNT-${anio}-001`);
  assert.equal(b.codigo, `MNT-${anio}-002`);
  await M.Mantenimiento.deleteMany({});
});

test('N1 · el registro de errores caduca a los 90 días (índice TTL)', async () => {
  const indices = await M.ErrorSistema.collection.indexes();
  const ttl = indices.find((i) => i.key.creadoEn === 1);
  assert.ok(ttl, 'falta el índice de creadoEn');
  assert.equal(ttl.expireAfterSeconds, 90 * 86400);
});

// ─── Nivel 2 · + ruta y validación ───────────────────────────────────────────
test('N2 · sin sesión no se puede reportar', async () => {
  const r = await api.pedir('POST', '/mantenimiento/reportes', { cuerpo: { tipo: 'CORRECTIVO', titulo: 'Algo falla', descripcion: 'Descripción suficiente' } });
  assert.equal(r.estado, 401);
});

test('N2 · un reporte incompleto se rechaza con un mensaje claro', async () => {
  const r = await api.pedir('POST', '/mantenimiento/reportes', {
    token: org.tokens.tecnico, cuerpo: { tipo: 'CORRECTIVO', titulo: 'Mal', descripcion: 'Descripción suficiente' },
  });
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /titulo/);
});

test('N2 · un reporte válido queda registrado en la etapa de recepción', async () => {
  const r = await api.pedir('POST', '/mantenimiento/reportes', {
    token: org.tokens.tecnico,
    cuerpo: {
      tipo: 'CORRECTIVO', titulo: 'No puedo enviar mi solicitud de vacaciones',
      descripcion: 'Al pulsar Enviar solicitud no pasa nada', area: 'vacations', pagina: '/mis-vacaciones',
    },
  });
  assert.equal(r.estado, 201);
  assert.match(r.datos.codigo, /^MNT-\d{4}-\d{3}$/);
  idReporte = r.datos._id;
  const doc = await M.Mantenimiento.findById(idReporte).lean();
  assert.equal(doc.estado, 'ABIERTO');
  assert.equal(doc.etapa, 0);
  assert.equal(doc.origen, 'USUARIO');
  assert.equal(doc.contexto.pagina, '/mis-vacaciones');
});

// ─── Nivel 3 · + autenticación y permisos ────────────────────────────────────
test('N3 · un técnico no ve el tablero de mantenimiento', async () => {
  const r = await api.pedir('GET', '/mantenimiento', { token: org.tokens.tecnico });
  assert.equal(r.estado, 403);
});

test('N3 · la Gerente de RRHH lo consulta pero no lo modifica', async () => {
  const lee = await api.pedir('GET', '/mantenimiento', { token: org.tokens.gerente });
  assert.equal(lee.estado, 200);
  const escribe = await api.pedir('POST', `/mantenimiento/${idReporte}/avanzar`, { token: org.tokens.gerente, cuerpo: { nota: 'intento' } });
  assert.equal(escribe.estado, 403);
});

test('N3 · el técnico sigue su propio reporte en «Mis reportes»', async () => {
  const r = await api.pedir('GET', '/mantenimiento/mis-reportes', { token: org.tokens.tecnico });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.length, 1);
  assert.equal(r.datos[0].etapaActual, 'Recepción del informe de error');
  assert.equal(r.datos[0].analisis, undefined, 'el análisis técnico no se muestra a quien reporta');
});

// ─── Nivel 4 · + proceso por etapas y notificaciones ─────────────────────────
test('N4 · el administrador fue avisado del reporte', async () => {
  const avisos = await M.Notificacion.find({ usuario: org.usuarios.admin._id, idRelacionado: idReporte }).lean();
  assert.equal(avisos.length, 1);
});

test('N4 · no se sale del análisis sin escribir el análisis', async () => {
  let r = await api.pedir('POST', `/mantenimiento/${idReporte}/avanzar`, { token: org.tokens.admin, cuerpo: { nota: 'Recibido y clasificado' } });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.etapaActual.codigo, 'ANALISIS');
  r = await api.pedir('POST', `/mantenimiento/${idReporte}/avanzar`, { token: org.tokens.admin, cuerpo: { nota: 'Reproducido' } });
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /análisis/);
});

test('N4 · recorre las seis etapas del correctivo y avisa a quien reportó', async () => {
  const pasos = [
    { nota: 'Reproducido', analisis: 'El botón quedaba deshabilitado con 7 días exactos' },
    { nota: 'Corregido', solucion: 'Se corrige la comparación de días' },
    { nota: 'Probado', pruebas: 'Solicitud de 7 días enviada y aprobada' },
    { nota: 'Publicado', version: '1.1.0' },
    { nota: 'Documentado en el CHANGELOG' },
  ];
  let r;
  for (const p of pasos) {
    r = await api.pedir('POST', `/mantenimiento/${idReporte}/avanzar`, { token: org.tokens.admin, cuerpo: p });
    assert.equal(r.estado, 200, JSON.stringify(r.datos));
  }
  assert.equal(r.datos.estado, 'CERRADO');
  assert.equal(r.datos.progreso, 100);
  assert.ok(r.datos.cerradoEn);
  const aviso = await M.Notificacion.findOne({ usuario: org.usuarios.tecnico._id, idRelacionado: idReporte }).lean();
  assert.match(aviso.titulo, /fue resuelto/);
  const mios = await api.pedir('GET', '/mantenimiento/mis-reportes', { token: org.tokens.tecnico });
  assert.equal(mios.datos[0].solucion, 'Se corrige la comparación de días');
});

test('N4 · un mantenimiento cerrado ya no se modifica', async () => {
  const r = await api.pedir('PUT', `/mantenimiento/${idReporte}`, { token: org.tokens.admin, cuerpo: { solucion: 'Otra' } });
  assert.equal(r.estado, 400);
});

// ─── Nivel 5 · + monitoreo de errores ────────────────────────────────────────
test('N5 · un error inesperado queda registrado con su código y pasa a correctivo', async () => {
  // Un servicio que falla de verdad, atendido por el manejador de errores real
  const errorHandler = require('../../src/middleware/errorHandler');
  const falla = express();
  falla.get('/api/prueba/falla', () => { throw new Error('Fallo simulado en integración'); });
  falla.use(errorHandler);
  const srv = falla.listen(0, '127.0.0.1');
  await new Promise((ok) => srv.once('listening', ok));
  const respuesta = await fetch(`http://127.0.0.1:${srv.address().port}/api/prueba/falla`).then((x) => x.json());
  srv.close();
  assert.match(respuesta.incidencia, /^[0-9A-F]{8}$/);
  assert.doesNotMatch(JSON.stringify(respuesta), /Fallo simulado/, 'el detalle interno no llega al usuario');

  // El registro es asíncrono: se espera a que aparezca
  let registrado = null;
  for (let i = 0; i < 20 && !registrado; i++) {
    registrado = await M.ErrorSistema.findOne({ incidencia: respuesta.incidencia }).lean();
    if (!registrado) await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(registrado, 'el error no quedó registrado');
  assert.equal(registrado.mensaje, 'Fallo simulado en integración');

  const lista = await api.pedir('GET', '/mantenimiento/errores', { token: org.tokens.admin });
  assert.equal(lista.datos.data[0].incidencia, respuesta.incidencia);

  const r = await api.pedir('POST', `/mantenimiento/errores/${registrado._id}/registrar`, { token: org.tokens.admin });
  assert.equal(r.estado, 201);
  assert.equal(r.datos.tipo, 'CORRECTIVO');
  assert.equal(r.datos.origen, 'MONITOREO');
  const atendido = await M.ErrorSistema.findById(registrado._id).lean();
  assert.equal(atendido.atendido, true);

  const otraVez = await api.pedir('POST', `/mantenimiento/errores/${registrado._id}/registrar`, { token: org.tokens.admin });
  assert.equal(otraVez.estado, 409);
});

test('N5 · el monitoreo resume el estado del sistema', async () => {
  const r = await api.pedir('GET', '/mantenimiento/salud', { token: org.tokens.admin });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.parametrosLegales.rmv.valor >= 1230, true);
  assert.equal(r.datos.plan.length > 0, true);
  assert.ok(['VERDE', 'AMBAR', 'ROJO'].includes(r.datos.semaforo));
});
