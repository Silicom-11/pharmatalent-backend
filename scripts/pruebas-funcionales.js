#!/usr/bin/env node
require('dotenv').config({ quiet: true });
require('../src/config/zonaHoraria').fijarZonaHoraria();
/**
 * Pruebas funcionales de caja negra, con el sistema completo.
 *
 * Cada caso se ejecuta por la API, como lo haría la interfaz, sobre una copia
 * de los datos de la exposición en una base aparte (nunca la real): se
 * restaura el respaldo, se ancla a hoy y se levanta un servidor propio en el
 * puerto 5055. El caso dice qué se espera; el resultado real es lo que el
 * sistema respondió en esta ejecución.
 *
 * Es también la prueba de integración no incremental («big bang»): todos los
 * módulos juntos, con 400 trabajadores, 21 roles y su historial.
 *
 *   npm run test:funcional                 restaura, levanta, prueba y cierra
 *   npm run test:funcional -- --sin-preparar  usa la base de pruebas tal como está
 *
 * Deja el detalle en docs/pruebas/casos-funcionales.json y .md
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const BASE = path.join(__dirname, '..');
const DOCS = path.join(BASE, '..', 'docs', 'pruebas');
const PUERTO = 5055;
const API = `http://127.0.0.1:${PUERTO}/api`;
const BD = process.env.MONGODB_URI_FUNCIONALES || 'mongodb://localhost:27017/pharmatalent_pruebas_funcionales';
const RESPALDO = path.join(BASE, 'respaldos', 'pharmatalent-20261106-000245.json.gz');
const CLAVE = require('./lib/clave-demo').claveDemo();
const correo = (c) => `${c}@pharmatalent.pe`;
const claveTerminal = (codigo) => crypto.createHmac('sha256', process.env.JWT_SECRET || 'pharmatalent').update(`terminal:${codigo}`).digest('base64url').slice(0, 16);
const entorno = { ...process.env, MONGODB_URI: BD, PORT: String(PUERTO), MODO_EXPOSICION: '', NODE_ENV: 'development', EXPOSICION_PIN: '' };
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function preparar() {
  console.log(`Preparando la base de pruebas ${BD.split('/').pop()} (restaurar + anclar a hoy)…`);
  for (const args of [['scripts/restaurar.js', RESPALDO, '--si'], ['scripts/coherencia.js', '--aplicar', '--demo'], ['scripts/registrar-mantenimiento.js']]) {
    const r = spawnSync(process.execPath, args, { cwd: BASE, env: entorno, encoding: 'utf8' });
    if (r.status) { console.error(r.stdout, r.stderr); throw new Error(`Falló ${args[0]}`); }
  }
}

async function pedir(metodo, ruta, { token, cuerpo, cabeceras = {} } = {}) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...cabeceras },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let datos; try { datos = JSON.parse(texto); } catch { datos = texto; }
  return { estado: r.status, datos };
}

const tokens = {};
async function token(cuenta) {
  if (!tokens[cuenta]) {
    const r = await pedir('POST', '/auth/login', { cuerpo: { correo: correo(cuenta), contrasena: CLAVE } });
    if (r.estado !== 200) throw new Error(`No se pudo ingresar como ${cuenta}: ${r.estado} ${JSON.stringify(r.datos)}`);
    tokens[cuenta] = r.datos.token;
  }
  return tokens[cuenta];
}
const lista = (d) => (Array.isArray(d) ? d : d?.data || []);
const marcar = (codigo, dni) => pedir('POST', '/terminal/marcar', {
  cabeceras: { 'X-Terminal-Local': codigo, 'X-Terminal-Clave': claveTerminal(codigo) }, cuerpo: { dni, metodo: 'DNI' },
});

// ─── Contexto que los casos necesitan ────────────────────────────────────────
const ctx = {};
async function descubrir() {
  const admin = await token('admin');
  const locales = lista((await pedir('GET', '/locations?limit=500', { token: admin })).datos);
  ctx.ikf733 = locales.find((l) => l.codigo === 'IKF-733');
  ctx.mif318 = locales.find((l) => l.codigo === 'MIF-318');
  ctx.concepcion = locales.find((l) => /Concepci/i.test(l.nombre));
  const cargos = lista((await pedir('GET', '/positions?limit=200', { token: admin })).datos);
  ctx.cargoTecnico = cargos.find((c) => c.nombre === 'Técnico en Farmacia');
  const yo = (await pedir('GET', '/auth/me', { token: await token('tecnico.huancayo') })).datos;
  ctx.tecnico = yo.empleado || yo.usuario?.empleado;
}

// ─── Casos ───────────────────────────────────────────────────────────────────
const hoy = new Date();
const manana = new Date(hoy.getTime() + 86400000);
const proximoDomingo = (desde, extraSemanas = 0) => { const d = new Date(desde); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7) + extraSemanas * 7); return d; };
const dniNuevo = () => String(Math.floor(60000000 + Math.random() * 9999999));

const CASOS = [
  {
    id: 'CP-01', rf: 'RF1 · RNF4', modulo: 'Acceso', tecnica: 'Caja negra (partición de equivalencia)',
    descripcion: 'Ingreso al sistema con contraseña correcta e incorrecta',
    precondiciones: 'Cuenta activa del cajero de demostración',
    pasos: 'POST /auth/login con la contraseña correcta; luego con una incorrecta',
    datos: 'cajero@pharmatalent.pe · contraseña de demostración / «Equivocada123»',
    esperado: '200 con token de sesión; 401 «Credenciales inválidas» sin revelar si la cuenta existe',
    async ejecutar() {
      const ok = await pedir('POST', '/auth/login', { cuerpo: { correo: correo('cajero'), contrasena: CLAVE } });
      const mal = await pedir('POST', '/auth/login', { cuerpo: { correo: correo('cajero'), contrasena: 'Equivocada123' } });
      return { ok: ok.estado === 200 && Boolean(ok.datos.token) && mal.estado === 401, real: `${ok.estado} con token; ${mal.estado} «${mal.datos.error}»` };
    },
  },
  {
    id: 'CP-02', rf: 'RF1', modulo: 'Empleados', tecnica: 'Caja negra (valor límite) · regresión MNT-2026-001',
    descripcion: 'Registrar un empleado con fecha de ingreso futura',
    precondiciones: 'Sesión de la Gerente de RRHH',
    pasos: 'POST /employees con fechaIngreso = mañana',
    datos: () => `DNI nuevo, Técnico en Farmacia, Inkafarma Huancayo Real, ingreso ${iso(manana)}, S/ 1,500`,
    esperado: '400: la fecha de ingreso no puede ser futura',
    async ejecutar() {
      const r = await pedir('POST', '/employees', { token: await token('gerente.rrhh'), cuerpo: cuerpoEmpleado({ fechaIngreso: iso(manana), sueldoBasico: 1500 }) });
      return { ok: r.estado === 400, real: `${r.estado} «${r.datos.error}»` };
    },
  },
  {
    id: 'CP-03', rf: 'RF1', modulo: 'Empleados', tecnica: 'Caja negra (partición de equivalencia)',
    descripcion: 'Registrar un empleado válido y encontrarlo en la búsqueda',
    precondiciones: 'Sesión de la Gerente de RRHH; puesto y botica existentes',
    pasos: 'POST /employees con datos válidos; GET /employees?search=<DNI>',
    datos: () => `DNI nuevo, ingreso ${iso(hoy)}, sueldo S/ 1,230 (la RMV)`,
    esperado: '201 y la búsqueda por DNI lo devuelve',
    async ejecutar() {
      const cuerpo = cuerpoEmpleado({ fechaIngreso: iso(hoy), sueldoBasico: 1230 });
      const r = await pedir('POST', '/employees', { token: await token('gerente.rrhh'), cuerpo });
      const b = await pedir('GET', `/employees?search=${cuerpo.dni}`, { token: await token('gerente.rrhh') });
      const hallado = lista(b.datos).some((e) => e.dni === cuerpo.dni);
      return { ok: r.estado === 201 && hallado, real: `${r.estado}; búsqueda por DNI ${hallado ? 'lo encuentra' : 'no lo encuentra'}` };
    },
  },
  {
    id: 'CP-04', rf: 'RF1 · RNF5', modulo: 'Empleados', tecnica: 'Caja negra (valor límite) · MNT-2026-014',
    descripcion: 'Registrar un sueldo por debajo de la nueva RMV',
    precondiciones: 'RMV vigente S/ 1,230 desde el 01/10/2026',
    pasos: 'POST /employees con sueldoBasico = 1130 y 1229.99',
    datos: () => `Ingreso ${iso(hoy)}, sueldos S/ 1,130 y S/ 1,229.99`,
    esperado: '400 en ambos, citando la RMV de S/ 1,230 y el D.S. 015-2026-TR',
    async ejecutar() {
      const t = await token('gerente.rrhh');
      const a = await pedir('POST', '/employees', { token: t, cuerpo: cuerpoEmpleado({ fechaIngreso: iso(hoy), sueldoBasico: 1130 }) });
      const b = await pedir('POST', '/employees', { token: t, cuerpo: cuerpoEmpleado({ fechaIngreso: iso(hoy), sueldoBasico: 1229.99 }) });
      return { ok: a.estado === 400 && b.estado === 400 && /015-2026-TR/.test(a.datos.error), real: `${a.estado} y ${b.estado} «${a.datos.error}»` };
    },
  },
  {
    id: 'CP-05', rf: 'RF6 · RNF5', modulo: 'Planilla', tecnica: 'Caja negra · MNT-2026-014',
    descripcion: 'La planilla de octubre 2026 usa la nueva RMV',
    precondiciones: 'Octubre 2026 calculada; trabajadores con hijos y con sueldo mínimo',
    pasos: 'GET /payroll?periodo=2026-10 (Analista de Planillas)',
    datos: 'Período 2026-10',
    esperado: 'Asignación familiar de S/ 123 (10 % de 1230) y ningún sueldo básico menor de S/ 1,230',
    async ejecutar() {
      // Todas las páginas: la API entrega de a 200
      const boletas = [];
      let r;
      for (let pagina = 1; pagina <= 20; pagina++) {
        r = await pedir('GET', `/payroll?periodo=2026-10&limit=200&page=${pagina}`, { token: await token('planillas') });
        boletas.push(...lista(r.datos));
        if (pagina >= (r.datos.pagination?.pages || 1)) break;
      }
      const conAsig = boletas.filter((b) => b.ingresos?.asignacionFamiliar > 0);
      const valores = [...new Set(conAsig.map((b) => b.ingresos.asignacionFamiliar))];
      const bajo = boletas.filter((b) => b.sueldoBasico < 1230).length;
      return {
        ok: boletas.length > 0 && valores.length === 1 && valores[0] === 123 && bajo === 0,
        real: `${boletas.length} boletas; asignación familiar ${valores.map((v) => `S/ ${v}`).join(', ')} en ${conAsig.length}; ${bajo} con básico bajo la RMV`,
      };
    },
  },
  {
    id: 'CP-06', rf: 'RF4', modulo: 'Vacaciones', tecnica: 'Caja negra (valor límite)',
    descripcion: 'Pedir vacaciones de menos de 7 días',
    precondiciones: 'Técnico con saldo disponible',
    pasos: 'POST /me/vacations del 01/12 al 03/12',
    datos: '3 días calendario',
    esperado: '400: las vacaciones se gozan en bloques de 7 días como mínimo (D.Leg. 713)',
    async ejecutar() {
      const r = await pedir('POST', '/me/vacations', { token: await token('tecnico.huancayo'), cuerpo: { tipo: 'VACACIONES', fechaInicio: `${hoy.getFullYear()}-12-01`, fechaFin: `${hoy.getFullYear()}-12-03` } });
      return { ok: r.estado === 400, real: `${r.estado} «${r.datos.error}»` };
    },
  },
  {
    id: 'CP-07', rf: 'RF4', modulo: 'Vacaciones', tecnica: 'Caja negra (flujo de punta a punta)',
    descripcion: 'Cadena de aprobación: botica avala, zona autoriza, baja el saldo',
    precondiciones: 'Técnico de Inkafarma Huancayo Real con saldo ≥ 7 días',
    pasos: 'Técnico solicita → Administrador de Botica avala (endorse) → Jefe de Zona autoriza (approve) → técnico consulta',
    datos: 'Del 01/12 al 07/12 (7 días)',
    esperado: 'PENDIENTE → APROBADO_LOCAL → APROBADO; el saldo disminuye 7 días',
    async ejecutar() {
      const tt = await token('tecnico.huancayo');
      const antes = (await pedir('GET', '/me/vacations', { token: tt })).datos.balance.diasDisponibles;
      const s = await pedir('POST', '/me/vacations', { token: tt, cuerpo: { tipo: 'VACACIONES', fechaInicio: `${hoy.getFullYear()}-12-01`, fechaFin: `${hoy.getFullYear()}-12-07` } });
      if (s.estado !== 201) return { ok: false, real: `Solicitud: ${s.estado} «${s.datos.error}»` };
      const id = s.datos.vacation._id;
      const e1 = s.datos.vacation.estado;
      const a = await pedir('PUT', `/vacations/${id}/endorse`, { token: await token('admin.huancayo'), cuerpo: { comentario: 'Cobertura asegurada', acknowledgeCoverage: true } });
      const z = await pedir('PUT', `/vacations/${id}/approve`, { token: await token('zona.huancayo'), cuerpo: { comentario: 'Autorizado', acknowledgeCoverage: true } });
      const despues = (await pedir('GET', '/me/vacations', { token: tt })).datos;
      const sol = despues.requests.find((r) => r._id === id);
      const ok = a.estado === 200 && z.estado === 200 && sol?.estado === 'APROBADO' && antes - despues.balance.diasDisponibles === 7;
      return { ok, real: `${e1} → avalar ${a.estado} → autorizar ${z.estado} → ${sol?.estado}; saldo ${antes} → ${despues.balance.diasDisponibles}${a.estado !== 200 ? ` «${a.datos.error}»` : ''}${z.estado !== 200 ? ` «${z.datos.error}»` : ''}` };
    },
  },
  {
    id: 'CP-08', rf: 'RF4', modulo: 'Terminal de marcación', tecnica: 'Caja negra (tabla de decisión)',
    descripcion: 'El terminal decide según el turno y el estado de la persona',
    precondiciones: 'Terminal IKF-733 registrado; un técnico con turno hoy, una QF sin turno y una persona de vacaciones',
    pasos: 'POST /terminal/marcar con cada DNI',
    datos: () => `Con turno: ${ctx.dniEntrada}; sin turno: ${ctx.dniLibre}; de vacaciones: ${ctx.dniVacaciones || '—'}`,
    esperado: 'ENTRADA (201); «No tiene turno asignado hoy» (404); «figura de vacaciones» (403)',
    async ejecutar() {
      const e = await marcar('IKF-733', ctx.dniEntrada);
      ctx.entradaEn = Date.now();
      const l = await marcar('IKF-733', ctx.dniLibre);
      const v = ctx.dniVacaciones ? await marcar('IKF-733', ctx.dniVacaciones) : { estado: 403, datos: { error: '(sin caso de vacaciones hoy)' } };
      return {
        ok: e.estado === 201 && e.datos.accion === 'ENTRADA' && l.estado === 404 && v.estado === 403,
        real: `${e.estado} ${e.datos.accion || e.datos.error}; ${l.estado} «${l.datos.error}»; ${v.estado} «${v.datos.error}»`,
      };
    },
  },
  {
    id: 'CP-09', rf: 'RF3', modulo: 'Turnos', tecnica: 'Caja negra (regla de negocio)',
    descripcion: 'No se publica un cronograma de una botica sin Químico Farmacéutico',
    precondiciones: 'Cronograma en borrador de Inkafarma Concepción con turnos sin QF',
    pasos: 'PUT /schedules/:id/publish (Gerente de RRHH)',
    datos: () => `Cronograma ${ctx.horarioConcepcion ? iso(new Date(ctx.horarioConcepcion.inicioSemana)) : '—'} de ${ctx.concepcion?.nombre || 'Concepción'}`,
    esperado: 'Rechazo con la brecha crítica de QF; el cronograma sigue en BORRADOR',
    async ejecutar() {
      if (!ctx.horarioConcepcion) return { ok: false, real: 'No hay cronograma en borrador de Concepción' };
      const r = await pedir('PUT', `/schedules/${ctx.horarioConcepcion._id}/publish`, { token: await token('gerente.rrhh'), cuerpo: {} });
      return { ok: r.estado >= 400 && r.estado < 500 && /QF|Químico/i.test(JSON.stringify(r.datos)), real: `${r.estado} «${r.datos.error}»` };
    },
  },
  {
    id: 'CP-10', rf: 'RF2', modulo: 'Turnos', tecnica: 'Caja negra · regresión MNT-2026-008',
    descripcion: 'Generar el cronograma de una semana nueva',
    precondiciones: 'Botica con su dotación y formato; semana sin cronograma',
    pasos: 'POST /schedules/generate (Administrador de Botica)',
    datos: () => `Inkafarma Huancayo Real, semana del ${iso(ctx.semanaNueva)}`,
    esperado: '201 con el cronograma en BORRADOR y QF en cada turno',
    async ejecutar() {
      const r = await pedir('POST', '/schedules/generate', { token: await token('admin.huancayo'), cuerpo: { local: ctx.ikf733._id, inicioSemana: iso(ctx.semanaNueva) } });
      const h = r.datos.horario || r.datos.schedule || r.datos;
      const turnos = r.datos.turnos || h.turnos || [];
      const sinQF = turnos.filter((t) => t.tieneQF === false).length;
      return { ok: r.estado === 201 && sinQF === 0, real: `${r.estado}; ${turnos.length} turnos, ${sinQF} sin QF${r.estado !== 201 ? ` «${r.datos.error}»` : ''}` };
    },
  },
  {
    id: 'CP-11', rf: 'RF6', modulo: 'Planilla', tecnica: 'Caja negra (segregación de funciones)',
    descripcion: 'Quien calcula la planilla no la aprueba; la Gerencia sí',
    precondiciones: 'Octubre 2026 calculada y por aprobar',
    pasos: 'POST /payroll/2026-10/approve-all con la Analista; luego con la Gerente de RRHH',
    datos: 'Período 2026-10',
    esperado: 'Analista: 403. Gerente: 200 con las boletas aprobadas (menos la suya)',
    async ejecutar() {
      const a = await pedir('POST', '/payroll/2026-10/approve-all', { token: await token('planillas'), cuerpo: {} });
      const g = await pedir('POST', '/payroll/2026-10/approve-all', { token: await token('gerente.rrhh'), cuerpo: {} });
      return { ok: a.estado === 403 && g.estado === 200, real: `Analista ${a.estado}; Gerente ${g.estado} ${g.datos.mensaje || g.datos.error || JSON.stringify(g.datos).slice(0, 120)}` };
    },
  },
  {
    id: 'CP-12', rf: 'RF12', modulo: 'Autoservicio', tecnica: 'Caja negra',
    descripcion: 'El trabajador ve su boleta recién cuando está aprobada',
    precondiciones: 'CP-11 ejecutado (octubre aprobado)',
    pasos: 'GET /me/payroll (técnico)',
    datos: 'Período 2026-10',
    esperado: 'La boleta de octubre aparece en estado APROBADO, con asignación familiar según la RMV del período',
    async ejecutar() {
      const r = await pedir('GET', '/me/payroll?periodo=2026-10', { token: await token('tecnico.huancayo') });
      const b = lista(r.datos).find((x) => x.periodo === '2026-10');
      return { ok: r.estado === 200 && b?.estado === 'APROBADO', real: `${r.estado}; boleta 2026-10 ${b ? `${b.estado}, neto S/ ${b.netoAPagar}` : 'no visible'}` };
    },
  },
  {
    id: 'CP-13', rf: 'RF9', modulo: 'Bienestar', tecnica: 'Caja negra · regresión MNT-2026-006',
    descripcion: 'Registrar un descanso médico con su CITT',
    precondiciones: 'Sesión del Gestor de Bienestar',
    pasos: 'POST /welfare/leaves',
    datos: () => `Técnico ${ctx.tecnico?.nombres || ''}, enfermedad común, 3 días desde el ${iso(proximoDomingo(hoy, 3))}`,
    esperado: '201 con el reparto de días entre empleador y EsSalud',
    async ejecutar() {
      const ini = proximoDomingo(hoy, 3);
      const fin = new Date(ini.getTime() + 2 * 86400000);
      const r = await pedir('POST', '/welfare/leaves', {
        token: await token('bienestar'),
        cuerpo: { empleado: ctx.tecnico._id, tipo: 'ENFERMEDAD_COMUN', fechaInicio: iso(ini), fechaFin: iso(fin), diagnostico: 'Faringitis aguda', centroMedico: 'EsSalud Huancayo', citt: { numero: `A-${Date.now()}`, emitido: true, fechaEmision: iso(hoy) } },
      });
      return { ok: r.estado === 201, real: `${r.estado}${r.estado === 201 ? ` · ${r.datos.diasTotales ?? '?'} días` : ` «${r.datos.error}»`}` };
    },
  },
  {
    id: 'CP-14', rf: 'RF11', modulo: 'Auditoría DIGEMID', tecnica: 'Caja negra · regresión MNT-2026-007',
    descripcion: 'Registrar una visita DIGEMID con hallazgos',
    precondiciones: 'Sesión del Auditor de Calidad',
    pasos: 'POST /audits con dos hallazgos',
    datos: 'Inkafarma Huancayo Real; hallazgos CADENA_FRIO (MAYOR) y ROTULADO_VENCIMIENTOS (MENOR)',
    esperado: '201 con la visita y sus hallazgos',
    async ejecutar() {
      const r = await pedir('POST', '/audits', {
        token: await token('auditor'),
        cuerpo: {
          local: ctx.ikf733._id, fechaVisita: iso(hoy), tipo: 'INOPINADA', directorTecnicoPresente: true,
          hallazgos: [
            { categoria: 'CADENA_FRIO', severidad: 'MAYOR', descripcion: 'Registro de temperatura incompleto' },
            { categoria: 'ROTULADO_VENCIMIENTOS', severidad: 'MENOR', descripcion: 'Dos productos sin rótulo de vencimiento' },
          ],
        },
      });
      return { ok: r.estado === 201 && (r.datos.hallazgos || []).length === 2, real: `${r.estado}${r.estado === 201 ? ` · ${(r.datos.hallazgos || []).length} hallazgos` : ` «${r.datos.error}»`}` };
    },
  },
  {
    id: 'CP-15', rf: 'RF10', modulo: 'Reclutamiento', tecnica: 'Caja negra (regla de negocio)',
    descripcion: 'Sólo se contrata a un candidato en la etapa de oferta',
    precondiciones: 'Candidato en una etapa anterior a OFERTA',
    pasos: 'POST /recruitment/:id/hire (Analista de Selección)',
    datos: () => `Candidato en etapa ${ctx.candidato?.etapa || '—'}`,
    esperado: 'Rechazo: primero debe llegar a la oferta',
    async ejecutar() {
      if (!ctx.candidato) return { ok: false, real: 'No hay candidatos antes de la oferta' };
      const r = await pedir('POST', `/recruitment/${ctx.candidato._id}/hire`, { token: await token('seleccion'), cuerpo: {} });
      return { ok: r.estado === 400, real: `${r.estado} «${r.datos.error}»` };
    },
  },
  {
    id: 'CP-16', rf: 'RF7', modulo: 'Ceses', tecnica: 'Caja negra',
    descripcion: 'Simular la liquidación de beneficios sociales',
    precondiciones: 'Trabajador activo con contrato',
    pasos: 'POST /liquidaciones/simular (Gerente de RRHH)',
    datos: () => `Técnico del guion, renuncia con cese el ${iso(hoy)}`,
    esperado: '200 con CTS, vacaciones, gratificación trunca y neto',
    async ejecutar() {
      const r = await pedir('POST', '/liquidaciones/simular', { token: await token('gerente.rrhh'), cuerpo: { employeeId: ctx.tecnico._id, fechaCese: iso(hoy), causa: 'RENUNCIA' } });
      const neto = r.datos.totales?.netoAPagar ?? r.datos.totales?.neto;
      return { ok: r.estado === 200 && neto > 0, real: `${r.estado}${r.estado === 200 ? ` · neto S/ ${neto}` : ` «${r.datos.error}»`}` };
    },
  },
  {
    id: 'CP-17', rf: 'RNF4', modulo: 'Seguridad', tecnica: 'Caja gris (matriz de permisos)',
    descripcion: 'Cada rol ve sólo lo que le corresponde',
    precondiciones: 'Cuentas de técnico, jefe de zona y gerente',
    pasos: 'GET /employees con cada cuenta',
    datos: 'tecnico.huancayo, zona.huancayo, gerente.rrhh',
    esperado: 'Técnico: 403. Jefe de zona: lista sin sueldos. Gerente: lista con sueldos',
    async ejecutar() {
      const t = await pedir('GET', '/employees?limit=5', { token: await token('tecnico.huancayo') });
      const z = await pedir('GET', '/employees?limit=5', { token: await token('zona.huancayo') });
      const g = await pedir('GET', '/employees?limit=5', { token: await token('gerente.rrhh') });
      const zSueldo = lista(z.datos).some((e) => e.sueldoBasico !== undefined);
      const gSueldo = lista(g.datos).some((e) => e.sueldoBasico !== undefined);
      return { ok: t.estado === 403 && z.estado === 200 && !zSueldo && gSueldo, real: `Técnico ${t.estado}; zona ${z.estado} ${zSueldo ? 'con' : 'sin'} sueldos; gerente ${g.estado} ${gSueldo ? 'con' : 'sin'} sueldos` };
    },
  },
  {
    id: 'CP-18', rf: 'Mantenimiento', modulo: 'Soporte', tecnica: 'Caja negra · MNT-2026-015',
    descripcion: 'Un trabajador reporta un problema y TI lo recibe',
    precondiciones: 'Sesiones del técnico y del Administrador del Sistema',
    pasos: 'POST /mantenimiento/reportes (técnico); GET /mantenimiento?q=<código> (admin); GET /mantenimiento/mis-reportes (técnico)',
    datos: '«No veo mi boleta de octubre», área Mi Espacio',
    esperado: '201 con código MNT; el admin lo ve en «Recepción del informe de error»; el técnico lo sigue en «Mis reportes»',
    async ejecutar() {
      const r = await pedir('POST', '/mantenimiento/reportes', { token: await token('tecnico.huancayo'), cuerpo: { tipo: 'CORRECTIVO', titulo: 'No veo mi boleta de octubre', descripcion: 'Entro a Mis Boletas y no aparece octubre', area: 'autoservicio', pagina: '/mis-boletas' } });
      ctx.reporte = r.datos;
      const a = await pedir('GET', `/mantenimiento?q=${r.datos.codigo}`, { token: await token('admin') });
      const item = lista(a.datos)[0];
      const m = await pedir('GET', '/mantenimiento/mis-reportes', { token: await token('tecnico.huancayo') });
      return { ok: r.estado === 201 && item?.etapaActual?.codigo === 'RECEPCION' && lista(m.datos).some((x) => x.codigo === r.datos.codigo), real: `${r.estado} ${r.datos.codigo}; admin lo ve en «${item?.etapaActual?.etiqueta}»; en Mis reportes: ${lista(m.datos).length}` };
    },
  },
  {
    id: 'CP-19', rf: 'Mantenimiento', modulo: 'Soporte', tecnica: 'Caja negra (regla del proceso)',
    descripcion: 'No se cierra el análisis sin documentar la causa',
    precondiciones: 'Reporte de CP-18 recibido',
    pasos: 'POST /mantenimiento/:id/avanzar dos veces sin análisis; luego con análisis',
    datos: 'Nota «Recibido», «Revisado»; análisis «La boleta aún no estaba aprobada»',
    esperado: 'Pasa a Análisis; sin análisis: 400; con análisis: pasa a Corrección',
    async ejecutar() {
      const t = await token('admin');
      const id = ctx.reporte._id;
      const a = await pedir('POST', `/mantenimiento/${id}/avanzar`, { token: t, cuerpo: { nota: 'Recibido' } });
      const b = await pedir('POST', `/mantenimiento/${id}/avanzar`, { token: t, cuerpo: { nota: 'Revisado' } });
      const c = await pedir('POST', `/mantenimiento/${id}/avanzar`, { token: t, cuerpo: { nota: 'Revisado', analisis: 'La boleta aún no estaba aprobada' } });
      return { ok: a.estado === 200 && b.estado === 400 && c.datos.etapaActual?.codigo === 'CORRECCION', real: `${a.estado} → ${b.estado} «${b.datos.error}» → ${c.estado} «${c.datos.etapaActual?.etiqueta}»` };
    },
  },
  {
    id: 'CP-20', rf: 'Mantenimiento', modulo: 'Monitoreo', tecnica: 'Caja negra · MNT-2026-014',
    descripcion: 'El monitoreo muestra los parámetros legales vigentes',
    precondiciones: 'Sesión del Administrador del Sistema',
    pasos: 'GET /mantenimiento/salud',
    datos: '—',
    esperado: 'RMV S/ 1,230 (D.S. 015-2026-TR) y UIT 2026 S/ 5,500 (D.S. 301-2025-EF)',
    async ejecutar() {
      const r = await pedir('GET', '/mantenimiento/salud', { token: await token('admin') });
      const l = r.datos.parametrosLegales;
      return { ok: l?.rmv.valor === 1230 && l?.uit.valor === 5500, real: `${r.estado}; RMV S/ ${l?.rmv.valor} (${l?.rmv.norma}); UIT S/ ${l?.uit.valor} (${l?.uit.norma}); semáforo ${r.datos.semaforo}` };
    },
  },
  {
    id: 'CP-21', rf: 'RF8', modulo: 'Capacitación', tecnica: 'Caja negra',
    descripcion: 'Reporte de cumplimiento de capacitaciones obligatorias',
    precondiciones: 'Sesión de la Analista de Capacitación',
    pasos: 'GET /training/compliance',
    datos: '—',
    esperado: '200 con el cumplimiento de SST (Ley 29783) e inducción',
    async ejecutar() {
      const r = await pedir('GET', '/training/compliance', { token: await token('capacitacion') });
      return { ok: r.estado === 200, real: `${r.estado} · ${JSON.stringify(r.datos).slice(0, 90)}…` };
    },
  },
  {
    id: 'CP-22', rf: 'RF4', modulo: 'Terminal de marcación', tecnica: 'Caja negra · regresión MNT-2026-012',
    descripcion: 'La salida se marca en la botica de la entrada',
    precondiciones: 'CP-08: entrada abierta en Inkafarma Huancayo Real hace más de 2 minutos',
    pasos: 'Marcar el mismo DNI en el terminal de Mifarma Huancayo Giráldez; luego en el de Huancayo Real',
    datos: () => `DNI ${ctx.dniEntrada}; terminales MIF-318 e IKF-733`,
    esperado: 'MIF-318: 403 «Su jornada de hoy está abierta en Inkafarma Huancayo Real»; IKF-733: 201 SALIDA',
    async ejecutar() {
      const espera = 125000 - (Date.now() - (ctx.entradaEn || 0));
      if (espera > 0) { console.log(`  (esperando ${Math.ceil(espera / 1000)} s: dos lecturas seguidas se toman como la misma)`); await dormir(espera); }
      const otro = await marcar('MIF-318', ctx.dniEntrada);
      const propio = await marcar('IKF-733', ctx.dniEntrada);
      return { ok: otro.estado === 403 && propio.estado === 201 && propio.datos.accion === 'SALIDA', real: `MIF-318 ${otro.estado} «${otro.datos.error}»; IKF-733 ${propio.estado} ${propio.datos.accion || propio.datos.error}` };
    },
  },
];

function cuerpoEmpleado(extra) {
  return {
    dni: dniNuevo(), nombres: 'Prueba', apellidos: 'Funcional Caja Negra', tipoProfesional: 'TECNICO',
    cargoActual: ctx.cargoTecnico._id, localActual: ctx.ikf733._id, ...extra,
  };
}

/** Datos que dependen del día: quién tiene turno, qué cronograma está en borrador */
async function descubrirDelDia() {
  const ab = await token('admin.huancayo');
  const horarios = (await pedir('GET', '/schedules', { token: ab })).datos;
  const hoy0 = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const conHoy = horarios.find((h) => new Date(h.inicioSemana) <= hoy0 && new Date(h.finSemana) >= hoy0) || horarios[0];
  const detalle = (await pedir('GET', `/schedules/${conHoy._id}`, { token: ab })).datos;
  const deHoy = detalle.turnos.filter((t) => iso(new Date(t.fecha)) === iso(hoy));
  const conTurno = new Set(deHoy.flatMap((t) => t.asignaciones.map((a) => String(a.empleado?._id || a.empleado))));
  const plantilla = lista((await pedir('GET', `/employees?local=${ctx.ikf733._id}&limit=200`, { token: await token('gerente.rrhh') })).datos);
  // El técnico del guion no recibe marca simulada (MNT-2026-013): es el de la entrada
  ctx.dniEntrada = conTurno.has(String(ctx.tecnico._id)) ? ctx.tecnico.dni : plantilla.find((e) => conTurno.has(String(e._id)) && e.estado === 'ACTIVO')?.dni;
  ctx.dniLibre = plantilla.find((e) => !conTurno.has(String(e._id)) && e.estado === 'ACTIVO' && e.tipoProfesional === 'QF')?.dni
    || plantilla.find((e) => !conTurno.has(String(e._id)) && e.estado === 'ACTIVO')?.dni;
  ctx.dniVacaciones = plantilla.find((e) => e.estado === 'VACACIONES')?.dni;
  const todos = (await pedir('GET', '/schedules?estado=BORRADOR', { token: await token('gerente.rrhh') })).datos;
  ctx.horarioConcepcion = todos.find((h) => /Concepci/i.test(h.local?.nombre || ''));
  const existentes = new Set(horarios.map((h) => iso(new Date(h.inicioSemana))));
  ctx.semanaNueva = proximoDomingo(hoy, 0);
  while (existentes.has(iso(ctx.semanaNueva))) ctx.semanaNueva = new Date(ctx.semanaNueva.getTime() + 7 * 86400000);
  const candidatos = lista((await pedir('GET', '/recruitment?limit=200', { token: await token('seleccion') })).datos);
  ctx.candidato = candidatos.find((c) => ['POSTULADO', 'FILTRO_CV', 'ENTREVISTA'].includes(c.etapa));
}

async function main() {
  const preparada = !process.argv.includes('--sin-preparar');
  if (preparada) preparar();
  const servidor = spawn(process.execPath, ['src/app.js'], { cwd: BASE, env: entorno, stdio: ['ignore', 'ignore', 'pipe'] });
  let errores = '';
  servidor.stderr.on('data', (d) => { errores += d; });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${API}/salud`)).ok) break; } catch { /* aún arranca */ }
      await dormir(500);
    }
    await descubrir();
    await descubrirDelDia();
    const resultados = [];
    console.log(`\nPRUEBAS FUNCIONALES · ${new Date().toLocaleString('es-PE')} · ${CASOS.length} casos\n`);
    for (const c of CASOS) {
      const inicio = Date.now();
      let r;
      try { r = await c.ejecutar(); } catch (err) { r = { ok: false, real: `Excepción: ${err.message}` }; }
      const fila = {
        id: c.id, rf: c.rf, modulo: c.modulo, tecnica: c.tecnica, descripcion: c.descripcion,
        precondiciones: c.precondiciones, pasos: c.pasos, datos: typeof c.datos === 'function' ? c.datos() : c.datos,
        esperado: c.esperado, real: r.real, estado: r.ok ? 'PASA' : 'FALLA', ms: Date.now() - inicio,
      };
      resultados.push(fila);
      console.log(`  ${r.ok ? '✓' : '✗'} ${c.id} ${c.descripcion}\n      ${r.real}`);
    }
    const pasan = resultados.filter((r) => r.estado === 'PASA').length;
    console.log(`\n  ${pasan}/${resultados.length} casos pasan\n`);
    fs.mkdirSync(DOCS, { recursive: true });
    const informe = { fecha: new Date().toISOString(), base: BD.split('/').pop(), version: require('../package.json').version, total: resultados.length, pasan, casos: resultados };
    fs.writeFileSync(path.join(DOCS, 'casos-funcionales.json'), JSON.stringify(informe, null, 2));
    const md = [
      `# Casos de prueba funcionales — PharmaTalent ${informe.version}`, '',
      `Ejecución: ${new Date().toLocaleString('es-PE')} · base ${informe.base} (copia de los datos de la exposición) · **${pasan}/${resultados.length} pasan**`, '',
      '| ID | Req. | Descripción | Condiciones previas | Pasos | Datos de entrada | Resultado esperado | Resultado real | Estado |',
      '|---|---|---|---|---|---|---|---|---|',
      ...resultados.map((r) => `| ${r.id} | ${r.rf} | ${r.descripcion} | ${r.precondiciones} | ${r.pasos} | ${r.datos} | ${r.esperado} | ${r.real.replace(/\|/g, '/')} | ${r.estado} |`),
    ].join('\n');
    fs.writeFileSync(path.join(DOCS, 'casos-funcionales.md'), `${md}\n`);
    process.exitCode = pasan === resultados.length ? 0 : 1;
  } finally {
    servidor.kill();
    if (errores.trim()) fs.writeFileSync(path.join(DOCS, 'servidor-pruebas.log'), errores);
  }
}

main().catch((err) => { console.error('Las pruebas funcionales no pudieron correr:', err.message); process.exit(2); });
