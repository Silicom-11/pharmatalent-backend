#!/usr/bin/env node
require('../src/config/zonaHoraria').fijarZonaHoraria();
/**
 * Deja la base lista para exponer, aunque se haya ensayado antes.
 *
 * Vuelve al respaldo «listo para exponer» —el cronograma de la próxima semana
 * en borrador, setiembre por aprobar, nadie con las marcas de la tarde— y
 * ancla los datos a la fecha de hoy: turnos de esta semana y marcas de hoy.
 *
 *   npm run exposicion                       con el respaldo de la exposición
 *   npm run exposicion -- otro.json.gz       con otro respaldo
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASE = path.join(__dirname, '..');
const RESPALDO = process.argv[2] || path.join(BASE, 'respaldos', 'pharmatalent-20261106-000245.json.gz');

function correr(args) {
  const r = spawnSync(process.execPath, args, { cwd: BASE, stdio: 'inherit' });
  if (r.status) {
    console.error(`\nFalló: node ${args.join(' ')}`);
    process.exit(r.status);
  }
}

correr(['scripts/restaurar.js', RESPALDO, '--si']);
correr(['scripts/coherencia.js', '--aplicar', '--demo']);
// El historial de la fase de mantenimiento (idempotente: no duplica)
correr(['scripts/registrar-mantenimiento.js']);
console.log('\nBase lista para exponer. Abra el sistema y elija «Empezar el recorrido guiado».');
