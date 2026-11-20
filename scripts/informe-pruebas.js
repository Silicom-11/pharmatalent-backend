#!/usr/bin/env node
require('dotenv').config({ quiet: true });
require('../src/config/zonaHoraria').fijarZonaHoraria();
/**
 * Pruebas de regresión completas y su informe (fase de mantenimiento).
 *
 * Corre, en orden, todos los niveles de prueba y los resume por técnica:
 *
 *   1. Unitarias (node:test)          caja negra · caja blanca · caja gris
 *   2. Integración incremental        módulo a módulo, contra una base de pruebas
 *   3. Funcionales / big bang         22 casos de caja negra con el sistema completo
 *   4. Carga                          100 usuarios concurrentes (RNF1)
 *
 * Después de cada mantenimiento se vuelve a correr completo: eso es la prueba
 * de regresión. El resultado queda en docs/pruebas/informe-pruebas.{json,md}
 * y como tarea REGRESION (y CARGA) del plan preventivo.
 *
 *   npm run pruebas
 *   npm run pruebas -- --rapido        sólo unitarias e integración
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASE = path.join(__dirname, '..');
const DOCS = path.join(BASE, '..', 'docs', 'pruebas');
const rapido = process.argv.includes('--rapido');

/** Técnica principal de cada archivo de pruebas unitarias */
const TECNICA = {
  'validacion.test.js': ['Caja negra', 'Particiones de equivalencia y valores límite de cada validador'],
  'boleta.test.js': ['Caja negra', 'Formato de la boleta (D.S. 001-98-TR) y montos en letras'],
  'liquidacion.test.js': ['Caja negra', 'Beneficios sociales por causa de cese y fecha'],
  'payroll.test.js': ['Caja negra', 'Renta de quinta, horas extra, pensión'],
  'vacaciones.test.js': ['Caja negra', 'Saldo y período pendiente (D.Leg. 713)'],
  'periodo.test.js': ['Caja negra', 'Límites del período de planilla'],
  'fechas.test.js': ['Caja negra', 'Valores límite de fechas locales'],
  'busqueda.test.js': ['Caja negra', 'Búsqueda con caracteres especiales'],
  'staffing.test.js': ['Caja negra', 'Motor de turnos: dotación, 48 h, descansos, QF'],
  'bitacora.test.js': ['Caja negra', 'Qué se oculta y cómo se nombra cada acción'],
  'zona-horaria.test.js': ['Caja blanca', 'Recorre los puntos de entrada del código'],
  'cobertura-esquemas.test.js': ['Caja blanca', 'Compara lo que lee cada ruta con su esquema'],
  'colecciones.test.js': ['Caja blanca', 'Cada $lookup del código apunta a una colección real'],
  'sin-restos-ingles.test.js': ['Caja blanca', 'Busca campos con nombres anteriores en el código'],
  'parametros.test.js': ['Caja blanca', 'Cada ruta lee sólo los parámetros de su camino'],
  'permisos.test.js': ['Caja blanca', 'Toda ruta consulta la matriz de permisos'],
  'mantenimiento.test.js': ['Caja blanca', 'Ramas de las reglas del proceso; valores límite de la RMV'],
  'enumerados.test.js': ['Caja gris', 'Validadores frente a los enumerados del modelo'],
  'credenciales.test.js': ['Caja gris', 'Política de contraseñas y bloqueo'],
  'recuperacion.test.js': ['Caja gris', 'Código de recuperación de un solo uso'],
};

const INTEGRACION = {
  '01-mantenimiento.test.js': ['Incremental', 'Módulo de mantenimiento en 5 niveles: modelo → ruta → permisos → proceso y avisos → monitoreo'],
  '02-marcacion.test.js': ['Incremental', 'Terminal + turnos + asistencia (MNT-2026-012)'],
  '03-rmv-planilla.test.js': ['Incremental', 'Parámetros legales + motor de planilla + contratos + rutas (MNT-2026-014)'],
};

function correrNodeTest(archivos, extra = []) {
  const r = spawnSync(process.execPath, ['--test', ...extra, ...archivos], { cwd: BASE, encoding: 'utf8', env: { ...process.env } });
  const num = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || 0);
  return { pruebas: num('tests'), pasan: num('pass'), fallan: num('fail'), ms: Math.round(Number((r.stdout.match(/^# duration_ms ([\d.]+)/m) || [])[1] || 0)) };
}

function correrScript(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: BASE, encoding: 'utf8', env: { ...process.env } });
  return r.status;
}

async function main() {
  const inicio = new Date();
  console.log(`\nPRUEBAS DE REGRESIÓN · PharmaTalent ${require('../package.json').version} · ${inicio.toLocaleString('es-PE')}\n`);

  // 1 · Unitarias
  const unitarias = Object.entries(TECNICA).map(([archivo, [tecnica, enfoque]]) => ({ archivo, tecnica, enfoque, ...correrNodeTest([`tests/${archivo}`]) }));
  const sinClasificar = fs.readdirSync(path.join(BASE, 'tests')).filter((f) => f.endsWith('.test.js') && !TECNICA[f]);
  for (const archivo of sinClasificar) unitarias.push({ archivo, tecnica: 'Caja negra', enfoque: '(sin clasificar)', ...correrNodeTest([`tests/${archivo}`]) });
  const porTecnica = {};
  for (const u of unitarias) {
    porTecnica[u.tecnica] ||= { archivos: 0, pruebas: 0, pasan: 0, fallan: 0 };
    Object.assign(porTecnica[u.tecnica], {
      archivos: porTecnica[u.tecnica].archivos + 1, pruebas: porTecnica[u.tecnica].pruebas + u.pruebas,
      pasan: porTecnica[u.tecnica].pasan + u.pasan, fallan: porTecnica[u.tecnica].fallan + u.fallan,
    });
  }
  const totU = unitarias.reduce((a, u) => ({ pruebas: a.pruebas + u.pruebas, pasan: a.pasan + u.pasan, fallan: a.fallan + u.fallan }), { pruebas: 0, pasan: 0, fallan: 0 });
  console.log(`  Unitarias        ${totU.pasan}/${totU.pruebas}  (${Object.entries(porTecnica).map(([t, v]) => `${t.toLowerCase()} ${v.pasan}/${v.pruebas}`).join(' · ')})`);

  // 2 · Integración incremental
  const integracion = Object.entries(INTEGRACION).map(([archivo, [enfoque, detalle]]) => ({ archivo, enfoque, detalle, ...correrNodeTest([`tests/integracion/${archivo}`], ['--test-concurrency=1']) }));
  const totI = integracion.reduce((a, u) => ({ pruebas: a.pruebas + u.pruebas, pasan: a.pasan + u.pasan, fallan: a.fallan + u.fallan }), { pruebas: 0, pasan: 0, fallan: 0 });
  console.log(`  Integración      ${totI.pasan}/${totI.pruebas}  (incremental, base pharmatalent_pruebas_integracion)`);

  // 3 · Funcionales (big bang) y 4 · carga
  let funcionales = null; let carga = null;
  if (!rapido) {
    correrScript('scripts/pruebas-funcionales.js');
    funcionales = JSON.parse(fs.readFileSync(path.join(DOCS, 'casos-funcionales.json'), 'utf8'));
    console.log(`  Funcionales      ${funcionales.pasan}/${funcionales.total}  (caja negra con el sistema completo: integración big bang)`);
    correrScript('scripts/prueba-carga.js');
    carga = JSON.parse(fs.readFileSync(path.join(DOCS, 'prueba-carga.json'), 'utf8'));
    console.log(`  Carga            ${carga.usuarios} usuarios · p95 ${carga.total.p95} ms · ${carga.total.bajo2000} % < 2 s · ${carga.total.errores} errores → RNF1 ${carga.rnf1.cumple ? 'cumple' : 'no cumple'}`);
  }

  // 5 · Auditoría de permisos por rol contra el sistema en marcha (big bang, sólo lectura)
  let auditoria = null;
  if (!rapido) {
    const enMarcha = await fetch('http://localhost:5000/api/salud').then((r) => r.ok).catch(() => false);
    if (enMarcha) {
      const r = spawnSync(process.execPath, ['scripts/auditoria-roles.js'], { cwd: BASE, encoding: 'utf8', timeout: 300000 });
      const cuenta = (k) => Number((r.stdout.match(new RegExp(`=== ${k} \\((\\d+)\\)`)) || [])[1] ?? NaN);
      const textoEndpoints = fs.readFileSync(path.join(BASE, 'scripts', 'auditoria-roles.js'), 'utf8').match(/const ENDPOINTS = \{([\s\S]*?)\n\};/)[1];
      auditoria = {
        cuentas: (r.stdout.match(/@pharmatalent\.pe/g) || []).length,
        endpoints: (textoEndpoints.match(/'\/[^']*':/g) || []).length,
        error500: cuenta('ERROR500'), fugas: cuenta('FUGA'), bloqueados: cuenta('BLOQUEADO'), vacios: cuenta('VACIO'),
      };
      console.log(`  Permisos         ${auditoria.cuentas} cuentas × ${auditoria.endpoints} endpoints · ${auditoria.error500} errores 500 · ${auditoria.fugas} fugas · ${auditoria.bloqueados} bloqueos`);
    } else {
      console.log('  Permisos         (omitida: el sistema no está en marcha en el puerto 5000)');
    }
  }

  const total = totU.pruebas + totI.pruebas + (funcionales?.total || 0);
  const pasan = totU.pasan + totI.pasan + (funcionales?.pasan || 0);
  const informe = {
    fecha: inicio.toISOString(), version: require('../package.json').version,
    unitarias: { ...totU, porTecnica, archivos: unitarias },
    integracion: { ...totI, archivos: integracion },
    funcionales: funcionales && { total: funcionales.total, pasan: funcionales.pasan, fecha: funcionales.fecha },
    auditoria,
    carga: carga && { usuarios: carga.usuarios, segundos: carga.segundos, porSegundo: carga.porSegundo, ...carga.total, cumpleRNF1: carga.rnf1.cumple },
    total, pasan, porcentaje: Math.round((pasan / total) * 1000) / 10,
  };
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'informe-pruebas.json'), JSON.stringify(informe, null, 2));
  const md = [
    `# Informe de pruebas — PharmaTalent ${informe.version}`, '',
    `Ejecución completa: ${inicio.toLocaleString('es-PE')} · **${pasan}/${total} pruebas pasan (${informe.porcentaje} %)**`, '',
    '## Unitarias por técnica', '', '| Técnica | Archivos | Pruebas | Pasan |', '|---|---|---|---|',
    ...Object.entries(porTecnica).map(([t, v]) => `| ${t} | ${v.archivos} | ${v.pruebas} | ${v.pasan} |`), '',
    '| Archivo | Técnica | Qué prueba | Pruebas | Pasan |', '|---|---|---|---|---|',
    ...unitarias.map((u) => `| ${u.archivo} | ${u.tecnica} | ${u.enfoque} | ${u.pruebas} | ${u.pasan} |`), '',
    '## Integración', '', '| Archivo | Enfoque | Qué integra | Pruebas | Pasan |', '|---|---|---|---|---|',
    ...integracion.map((u) => `| ${u.archivo} | ${u.enfoque} | ${u.detalle} | ${u.pruebas} | ${u.pasan} |`), '',
    funcionales ? `## Funcionales (big bang)\n\n${funcionales.pasan}/${funcionales.total} casos: ver casos-funcionales.md\n` : '',
    auditoria ? `## Permisos por rol (big bang, sólo lectura)

${auditoria.cuentas} cuentas × ${auditoria.endpoints} endpoints: ${auditoria.error500} errores 500, ${auditoria.fugas} accesos indebidos, ${auditoria.bloqueados} bloqueos indebidos.
` : '',
    carga ? `## Carga\n\n${carga.usuarios} usuarios concurrentes, ${carga.segundos} s: ${carga.total.peticiones} peticiones (${carga.porSegundo}/s), p50 ${carga.total.p50} ms, p95 ${carga.total.p95} ms, p99 ${carga.total.p99} ms, ${carga.total.errores} errores. ${carga.total.bajo2000} % bajo 2 s → RNF1 ${carga.rnf1.cumple ? 'cumple' : 'no cumple'}.\n` : '',
  ].join('\n');
  fs.writeFileSync(path.join(DOCS, 'informe-pruebas.md'), md);
  console.log(`\n  Total: ${pasan}/${total} (${informe.porcentaje} %) · docs/pruebas/informe-pruebas.md\n`);

  // Queda como revisión del plan preventivo, en la base del sistema
  if (!process.argv.includes('--sin-registro')) {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
      const Mantenimiento = require('../src/models/Mantenimiento');
      const M = require('../src/config/mantenimiento');
      const etapas = M.TIPOS.PREVENTIVO.etapas;
      const tareas = [{ codigo: 'REGRESION', ok: pasan === total, detalle: `${pasan}/${total} pruebas: unitarias ${totU.pasan}/${totU.pruebas}, integración ${totI.pasan}/${totI.pruebas}${funcionales ? `, funcionales ${funcionales.pasan}/${funcionales.total}` : ''}` }];
      if (auditoria) tareas.push({ codigo: 'PERMISOS', ok: auditoria.error500 === 0 && auditoria.fugas === 0 && auditoria.bloqueados === 0, detalle: `${auditoria.cuentas} cuentas × ${auditoria.endpoints} endpoints: ${auditoria.error500} errores 500, ${auditoria.fugas} fugas, ${auditoria.bloqueados} bloqueos` });
      if (carga) tareas.push({ codigo: 'CARGA', ok: carga.rnf1.cumple, detalle: `${carga.usuarios} usuarios: p95 ${carga.total.p95} ms, ${carga.total.bajo2000} % < 2 s, ${carga.total.errores} errores` });
      const quien = 'Pruebas de regresión (npm run pruebas)';
      const r = await Mantenimiento.create({
        tipo: 'PREVENTIVO', titulo: `Pruebas de regresión del ${inicio.toLocaleDateString('es-PE')}`,
        descripcion: 'Ejecución completa de las pruebas unitarias, de integración, funcionales y de carga.',
        area: 'general', prioridad: 'BAJA', origen: 'PLAN', estado: 'CERRADO', etapa: etapas.length,
        analisis: tareas.map((t) => `${t.codigo}: ${t.detalle}`).join('\n'), solucion: 'Sin cambios: revisión de estabilidad',
        pruebas: `${pasan}/${total} (${informe.porcentaje} %)`, version: informe.version, tareas, cerradoEn: new Date(),
        historial: etapas.map((e, i) => ({ etapa: i, accion: i === etapas.length - 1 ? 'CIERRE' : 'AVANCE', nota: e.etiqueta, porNombre: quien, en: new Date() })),
      });
      console.log(`  Registrado como ${r.codigo} en el plan preventivo.\n`);
      await mongoose.disconnect();
    } catch (err) {
      console.log(`  (No se registró en la base: ${err.message})\n`);
    }
  }
  process.exitCode = pasan === total ? 0 : 1;
}

main();
