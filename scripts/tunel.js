#!/usr/bin/env node
require('../src/config/zonaHoraria').fijarZonaHoraria();
/**
 * Abre un túnel de Cloudflare hacia el sistema de esta computadora, para entrar
 * desde cualquier red: el celular con el internet de la universidad, o una PC
 * del aula. Sin cuenta: la dirección es nueva cada vez que se abre.
 *
 *   npm run tunel          (con el sistema encendido en el puerto 5000)
 *
 * Mientras esté abierto, el sistema está en internet. El acceso por rol sin
 * contraseña pide entonces el PIN de EXPOSICION_PIN (.env). Ctrl+C lo cierra.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PUERTO = process.env.PORT || 5000;
const CANDIDATOS = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared',
];
const ejecutable = CANDIDATOS.find((c) => c === 'cloudflared' || fs.existsSync(c));
const ARCHIVO = path.join(__dirname, '..', 'tunel-url.txt');

const proceso = spawn(ejecutable, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PUERTO}`], { windowsHide: true });
let anunciada = false;

function revisar(trozo) {
  const texto = trozo.toString();
  const m = texto.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !anunciada) {
    anunciada = true;
    fs.writeFileSync(ARCHIVO, `${m[0]}\n`);
    const linea = '═'.repeat(m[0].length + 4);
    console.log(`\n  ${linea}\n    ${m[0]}\n  ${linea}`);
    console.log('\n  Esa es la dirección del sistema desde cualquier red.');
    console.log('  · En el celular: ábrala en la app PharmaTalent (o en el navegador).');
    console.log('  · En una PC de la universidad: ábrala en el navegador.');
    console.log(`  · Queda guardada en ${path.basename(ARCHIVO)}. Ctrl+C cierra el túnel.\n`);
  }
  if (/error|failed/i.test(texto) && !/no such host|retrying/i.test(texto)) process.stderr.write(texto);
}

proceso.stdout.on('data', revisar);
proceso.stderr.on('data', revisar);
proceso.on('error', (e) => {
  console.error(`No se pudo iniciar cloudflared (${e.message}). Instálelo con: winget install Cloudflare.cloudflared`);
  process.exit(1);
});
proceso.on('exit', (codigo) => {
  try { fs.unlinkSync(ARCHIVO); } catch { /* ya no estaba */ }
  console.log(`Túnel cerrado (${codigo ?? 0}).`);
  process.exit(codigo ?? 0);
});
process.on('SIGINT', () => proceso.kill());
