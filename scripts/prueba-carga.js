#!/usr/bin/env node
require('dotenv').config({ quiet: true });
require('../src/config/zonaHoraria').fijarZonaHoraria();
/**
 * Prueba de carga (mantenimiento preventivo: anticipar fallos por alta demanda).
 *
 * N usuarios concurrentes repiten, durante unos segundos, las consultas que
 * más se usan (panel, legajos, turnos, asistencia, vacaciones, boletas,
 * notificaciones), cada uno con la cuenta del rol que las usa. Mide tiempos
 * de respuesta (p50, p95, p99), peticiones por segundo y errores, y los
 * compara con el requisito RNF1: el 95 % de las respuestas en menos de 2 s con
 * 100 usuarios concurrentes.
 *
 * Corre contra la base de pruebas funcionales, con un servidor propio
 * (puerto 5056): no carga el sistema de la exposición.
 *
 *   npm run carga                                 100 usuarios, 30 s
 *   npm run carga -- --usuarios 200 --segundos 60
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const USUARIOS = arg('usuarios', 100);
const SEGUNDOS = arg('segundos', 30);
const PUERTO = 5056;
const API = `http://127.0.0.1:${PUERTO}/api`;
const BASE = path.join(__dirname, '..');
const BD = process.env.MONGODB_URI_FUNCIONALES || 'mongodb://localhost:27017/pharmatalent_pruebas_funcionales';
const CLAVE = require('./lib/clave-demo').claveDemo();
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Qué consulta cada rol y con qué peso (lo más usado pesa más)
const MEZCLA = [
  { cuenta: 'tecnico.huancayo', ruta: '/me/schedule', peso: 3 },
  { cuenta: 'tecnico.huancayo', ruta: '/me/attendance', peso: 3 },
  { cuenta: 'tecnico.huancayo', ruta: '/me/vacations', peso: 3 },
  { cuenta: 'tecnico.huancayo', ruta: '/me/payroll', peso: 2 },
  { cuenta: 'tecnico.huancayo', ruta: '/notifications/count', peso: 4 },
  { cuenta: 'admin.huancayo', ruta: '/dashboard/summary', peso: 2 },
  { cuenta: 'admin.huancayo', ruta: '/schedules', peso: 2 },
  { cuenta: 'admin.huancayo', ruta: '/attendance?limit=20', peso: 2 },
  { cuenta: 'admin.huancayo', ruta: '/vacations/pending', peso: 2 },
  { cuenta: 'zona.huancayo', ruta: '/dashboard/zone-overview', peso: 1 },
  { cuenta: 'gerente.rrhh', ruta: '/employees?limit=20', peso: 2 },
  { cuenta: 'gerente.rrhh', ruta: '/employees/stats', peso: 1 },
  { cuenta: 'planillas', ruta: '/payroll?periodo=2026-10&limit=20', peso: 1 },
  { cuenta: 'admin', ruta: '/mantenimiento/salud', peso: 1 },
];
const BOLSA = MEZCLA.flatMap((m) => Array(m.peso).fill(m));

const percentil = (ordenados, p) => ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)] || 0;

async function main() {
  const servidor = spawn(process.execPath, ['src/app.js'], {
    cwd: BASE, stdio: 'ignore',
    env: { ...process.env, MONGODB_URI: BD, PORT: String(PUERTO), MODO_EXPOSICION: '', NODE_ENV: 'development', LIMITE_INGRESOS_IP: '100000' },
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${API}/salud`)).ok) break; } catch { /* arrancando */ }
      await dormir(500);
    }
    const tokens = {};
    for (const cuenta of new Set(MEZCLA.map((m) => m.cuenta))) {
      const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correo: `${cuenta}@pharmatalent.pe`, contrasena: CLAVE }) });
      tokens[cuenta] = (await r.json()).token;
      if (!tokens[cuenta]) throw new Error(`No se pudo ingresar como ${cuenta}`);
    }

    console.log(`\nPRUEBA DE CARGA · ${USUARIOS} usuarios concurrentes · ${SEGUNDOS} s · ${MEZCLA.length} consultas\n`);
    const medidas = [];
    const fin = Date.now() + SEGUNDOS * 1000;
    const inicio = Date.now();
    async function usuario() {
      while (Date.now() < fin) {
        const m = BOLSA[Math.floor(Math.random() * BOLSA.length)];
        const t0 = performance.now();
        let estado = 0;
        try {
          const r = await fetch(API + m.ruta, { headers: { Authorization: `Bearer ${tokens[m.cuenta]}` } });
          await r.arrayBuffer();
          estado = r.status;
        } catch { estado = -1; }
        medidas.push({ ruta: m.ruta, ms: performance.now() - t0, estado });
      }
    }
    await Promise.all(Array.from({ length: USUARIOS }, usuario));
    const duracion = (Date.now() - inicio) / 1000;

    const resumen = (lista) => {
      const ms = lista.map((x) => x.ms).sort((a, b) => a - b);
      return {
        peticiones: lista.length,
        errores: lista.filter((x) => x.estado < 200 || x.estado >= 400).length,
        p50: Math.round(percentil(ms, 50)), p95: Math.round(percentil(ms, 95)), p99: Math.round(percentil(ms, 99)),
        max: Math.round(ms.at(-1) || 0),
        bajo500: Math.round((ms.filter((x) => x < 500).length / ms.length) * 1000) / 10,
        bajo2000: Math.round((ms.filter((x) => x < 2000).length / ms.length) * 1000) / 10,
      };
    };
    const total = resumen(medidas);
    const porRuta = MEZCLA.map((m) => ({ ruta: m.ruta, rol: m.cuenta, ...resumen(medidas.filter((x) => x.ruta === m.ruta)) }));
    const cumple = total.bajo2000 >= 95 && total.errores === 0;

    console.log('  Consulta                                   n      p50    p95    p99   err');
    for (const r of porRuta) console.log(`  ${r.ruta.padEnd(40)} ${String(r.peticiones).padStart(5)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.p99).padStart(6)} ${String(r.errores).padStart(5)}`);
    console.log(`\n  Total: ${total.peticiones} peticiones en ${duracion.toFixed(1)} s (${Math.round(total.peticiones / duracion)}/s) · p50 ${total.p50} ms · p95 ${total.p95} ms · p99 ${total.p99} ms · ${total.errores} errores`);
    console.log(`  ${total.bajo2000} % bajo 2 s y ${total.bajo500} % bajo 500 ms → RNF1 ${cumple ? 'CUMPLE' : 'NO CUMPLE'}\n`);

    const informe = {
      fecha: new Date().toISOString(), usuarios: USUARIOS, segundos: SEGUNDOS, duracion,
      equipo: `${os.cpus()[0]?.model} · ${os.cpus().length} hilos · ${Math.round(os.totalmem() / 1073741824)} GB · ${os.platform()} · Node ${process.version}`,
      porSegundo: Math.round(total.peticiones / duracion), total, porRuta, rnf1: { meta: '95 % < 2 s con 100 usuarios', cumple },
    };
    const docs = path.join(BASE, '..', 'docs', 'pruebas');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'prueba-carga.json'), JSON.stringify(informe, null, 2));
    process.exitCode = cumple ? 0 : 1;
  } finally {
    servidor.kill();
  }
}

main().catch((err) => { console.error('La prueba de carga no pudo correr:', err.message); process.exit(2); });
