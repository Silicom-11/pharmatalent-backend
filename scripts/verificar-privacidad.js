#!/usr/bin/env node
/**
 * ¿Quién ve el sueldo de quién? Entra con una cuenta de cada rol, recorre las
 * rutas que devuelven datos de personas (listado, ficha, legajo, contratos,
 * descansos, requerimientos, evaluaciones) y busca campos de remuneración de
 * otra persona en la respuesta. Sólo quien administra la planilla puede
 * recibirlos; cada uno, los suyos.
 *
 * Necesita el servidor en marcha y los datos de demostración. No escribe nada.
 * Sale con código 1 si algún rol recibe remuneraciones ajenas.
 *
 *   node scripts/verificar-privacidad.js
 */
require('../src/config/zonaHoraria').fijarZonaHoraria();
const path = require('path');
const { can } = require(path.join(__dirname, '..', 'src', 'config', 'roles'));
const API = process.env.API_URL || 'http://localhost:5000/api';
const CLAVE = require('./lib/clave-demo').claveDemo();
const CUENTAS = ['admin', 'gerente.rrhh', 'planillas', 'bienestar', 'zona.norte', 'auditor', 'jefe.cedi', 'seleccion',
  'capacitacion', 'admin.sanmiguel', 'rutas', 'qf.sanmiguel', 'qf.asistente', 'tecnico', 'cajero'];
const CAMPOS = ['sueldoBasico', 'historialSueldos', 'cuentaBancaria', 'cuspp', 'netoAPagar', 'sueldo'];  // sueldoOfrecido es de la vacante, no de una persona

function buscar(obj, propio, ruta = '', hallados = []) {
  if (Array.isArray(obj)) obj.forEach((x, i) => buscar(x, propio, `${ruta}[${i}]`, hallados));
  else if (obj && typeof obj === 'object') {
    const esPropio = propio && (String(obj._id) === propio || String(obj.empleado?._id || obj.empleado) === propio);
    for (const [k, v] of Object.entries(obj)) {
      if (CAMPOS.includes(k) && v != null && !esPropio) hallados.push(`${ruta}.${k}`);
      buscar(v, esPropio ? null : propio, `${ruta}.${k}`, hallados);
    }
  }
  return hallados;
}

(async () => {
  let fallos = 0;
  for (const c of CUENTAS) {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correo: `${c}@pharmatalent.pe`, contrasena: CLAVE }) });
    const d = await r.json();
    if (!d.token) { console.log(c, 'NO ENTRA', d.error); fallos++; continue; }
    const H = { Authorization: `Bearer ${d.token}` };
    const rol = d.usuario.rol;
    const propio = String(d.usuario.empleado?._id || d.usuario.empleado || '');
    const debeVer = can(rol, 'payroll', 'read');
    const get = async (u) => { const x = await fetch(API + u, { headers: H }); return x.ok ? x.json() : null; };
    const lista = await get('/employees?limit=50');
    const otro = lista?.data?.find((e) => String(e._id) !== propio);
    const rutas = ['/employees?limit=50', '/welfare/leaves', '/contracts?limit=50', '/requisitions', '/evaluations'];
    if (otro) rutas.push(`/employees/${otro._id}`, `/employees/${otro._id}/dossier`);
    const vistos = [];
    for (const u of rutas) {
      const datos = await get(u);
      if (!datos) continue;
      const h = buscar(datos, propio);
      if (h.length) vistos.push(`${u.split('?')[0]} (${[...new Set(h.map((x) => x.split('.').pop()))].join(',')})`);
    }
    const ok = debeVer || !vistos.length;
    if (!ok) fallos++;
    console.log(`${ok ? 'OK ' : 'MAL'} ${rol.padEnd(22)} ${debeVer ? 've remuneraciones (le corresponde)' : vistos.length ? 'VE: ' + vistos.join(' · ') : 'no ve remuneraciones ajenas'}`);
  }
  console.log(fallos ? `\n${fallos} rol(es) con remuneraciones a la vista` : '\nNingún rol ve remuneraciones que no le corresponden');
  process.exitCode = fallos ? 1 : 0;
})();
