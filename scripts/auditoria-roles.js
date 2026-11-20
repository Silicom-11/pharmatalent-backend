#!/usr/bin/env node
/**
 * Auditoría de la API por rol: entra con una cuenta de cada rol y llama a cada
 * ruta de lectura. Compara lo que responde con lo que declara la matriz de
 * permisos (src/config/roles.js) y separa:
 *
 *   ERROR500   la ruta falló
 *   FUGA       respondió datos a un rol que no tiene permiso
 *   BLOQUEADO  negó el acceso a un rol que sí lo tiene
 *   VACIO      respondió bien pero sin datos (revisar si es legítimo)
 *
 * Necesita el servidor en marcha y los datos de demostración (usa sus cuentas
 * por rol y su contraseña común). No escribe nada.
 *
 *   node scripts/auditoria-roles.js            contra http://localhost:5000/api
 *   API_URL=https://... node scripts/auditoria-roles.js
 */
require('../src/config/zonaHoraria').fijarZonaHoraria();
const path = require('path');
const { ROLES, can } = require(path.join(__dirname, '..', 'src', 'config', 'roles'));

const API = process.env.API_URL || 'http://localhost:5000/api';
const CLAVE = require('./lib/clave-demo').claveDemo();
const CUENTAS = [
  'admin@pharmatalent.pe', 'gerente.rrhh@pharmatalent.pe', 'zona.norte@pharmatalent.pe',
  'auditor@pharmatalent.pe', 'jefe.cedi@pharmatalent.pe', 'planillas@pharmatalent.pe',
  'seleccion@pharmatalent.pe', 'capacitacion@pharmatalent.pe', 'bienestar@pharmatalent.pe',
  'admin.sanmiguel@pharmatalent.pe', 'admin.miraflores@pharmatalent.pe', 'rutas@pharmatalent.pe',
  'qf.sanmiguel@pharmatalent.pe', 'qf.asistente@pharmatalent.pe', 'tecnico@pharmatalent.pe',
  'dermoconsultora@pharmatalent.pe', 'operario.cedi@pharmatalent.pe', 'cajero@pharmatalent.pe',
  'almacen@pharmatalent.pe', 'prevencionista@pharmatalent.pe', 'motorizado@pharmatalent.pe',
  'trainee@pharmatalent.pe',
];

// endpoint -> [modulo, accion] o null cuando no depende de un módulo (autoservicio)
const ENDPOINTS = {
  '/attendance': ['attendance', 'read'], '/attendance/report': ['attendance', 'read'],
  '/audits': ['audits', 'read'], '/audits/risk-map': ['audits', 'read'],
  '/bitacora': ['bitacora', 'read'], '/bitacora/resumen': ['bitacora', 'read'],
  '/contracts': ['contracts', 'read'], '/contracts/alerts': ['contracts', 'read'],
  '/contracts/pipeline': ['contracts', 'read'],
  '/dashboard/summary': ['dashboard', 'read'], '/dashboard/qf-coverage': ['dashboard', 'read'],
  '/dashboard/zone-overview': ['dashboard', 'read'], '/dashboard/cedi-overview': ['dashboard', 'read'],
  '/employees': ['employees', 'read'], '/employees/stats': ['employees', 'read'],
  '/evaluations': ['evaluations', 'read'], '/evaluations/mias/pendientes': null,
  '/liquidaciones': ['contracts', 'read'], '/liquidaciones/causas': ['contracts', 'read'],
  '/locations': ['locations', 'read'],
  '/me/attendance': null, '/me/attendance/today': null, '/me/contracts': null, '/me/payroll': null,
  '/me/profile': null, '/me/schedule': null, '/me/trainings': null, '/me/vacations': null,
  '/notifications': null, '/notifications/count': null,
  '/org/catalog': ['org', 'read'], '/org/chart': ['org', 'read'],
  '/payroll': ['payroll', 'read'], '/payroll/periodos': ['payroll', 'read'], '/me/evaluations': null, '/positions': ['positions', 'read'],
  '/recruitment': ['recruitment', 'read'], '/recruitment/pipeline': ['recruitment', 'read'],
  '/recruitment/stats': ['recruitment', 'read'],
  '/requisitions': ['requisitions', 'read'], '/requisitions/stats': ['requisitions', 'read'],
  '/schedules': ['schedules', 'read'],
  // Catálogo de formatos de botica: referencia sin datos personales (ver permisos.test.js)
  '/schedules/formats': null,
  '/training': ['training', 'read'], '/training/compliance': ['training', 'read'],
  '/users': ['users', 'read'], '/users/roles': ['users', 'read'],
  '/vacations': ['vacations', 'read'], '/vacations/pending': ['vacations', 'read'],
  '/welfare/leaves': ['welfare', 'read'], '/welfare/stats': ['welfare', 'read'],
  '/zones': ['zones', 'read'],
  // Fase de mantenimiento
  '/mantenimiento': ['mantenimiento', 'read'], '/mantenimiento/resumen': ['mantenimiento', 'read'],
  '/mantenimiento/salud': ['mantenimiento', 'read'], '/mantenimiento/errores': ['mantenimiento', 'read'],
  '/mantenimiento/catalogo': null, '/mantenimiento/mis-reportes': null,
};

const tam = (d) => {
  if (Array.isArray(d)) return d.length;
  if (d && Array.isArray(d.data)) return d.pagination?.total ?? d.total ?? d.data.length;
  if (d && typeof d === 'object') return Object.keys(d).length + 'k';
  return '?';
};

(async () => {
  const hallazgos = { error500: [], fuga: [], bloqueado: [], vacio: [] };
  const resumen = [];
  for (const correo of CUENTAS) {
    const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correo, contrasena: CLAVE }) });
    const d = await r.json();
    if (!d.token) { resumen.push([correo, 'NO PUDO ENTRAR', JSON.stringify(d).slice(0, 80)]); continue; }
    const yo = await (await fetch(API + '/auth/me', { headers: { Authorization: 'Bearer ' + d.token } })).json();
    const rol = yo.rol;
    let ok = 0;
    for (const [ep, req] of Object.entries(ENDPOINTS)) {
      const resp = await fetch(API + ep, { headers: { Authorization: 'Bearer ' + d.token } });
      let cuerpo = null; try { cuerpo = await resp.json(); } catch {}
      const debe = req === null ? true : can(rol, req[0], req[1]);
      const s = resp.status;
      if (s >= 500) hallazgos.error500.push(`${rol.padEnd(21)} ${ep}  ${s}  ${(cuerpo && (cuerpo.error || cuerpo.message)) || ''}`.slice(0, 160));
      else if (s === 200 && !debe) hallazgos.fuga.push(`${rol.padEnd(21)} ${ep}  (recibe ${tam(cuerpo)})`);
      else if ((s === 403 || s === 401) && debe) hallazgos.bloqueado.push(`${rol.padEnd(21)} ${ep}  ${s}  ${(cuerpo && cuerpo.error) || ''}`.slice(0, 160));
      else if (s === 200 && debe && (tam(cuerpo) === 0)) hallazgos.vacio.push(`${rol.padEnd(21)} ${ep}`);
      if (s === 200) ok++;
    }
    resumen.push([correo, rol, ok + ' respondieron 200']);
  }
  console.log('=== CUENTAS ===');
  resumen.forEach((x) => console.log('  ' + x.join('  ·  ')));
  for (const [k, v] of Object.entries(hallazgos)) {
    console.log(`\n=== ${k.toUpperCase()} (${v.length}) ===`);
    v.forEach((x) => console.log('  ' + x));
  }
})();
