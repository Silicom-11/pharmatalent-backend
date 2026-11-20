#!/usr/bin/env node
require('dotenv').config();
require('../src/config/zonaHoraria').fijarZonaHoraria();
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Usuario = require('../src/models/Usuario');

/**
 * Primera cuenta de administración de una instalación nueva.
 *
 * En producción no se carga el seed: sus personas, sus boticas y su
 * contraseña común son de demostración. Hace falta, sin embargo, una cuenta
 * para entrar y dar de alta lo demás —zonas, centros de trabajo, puestos,
 * personal y sus cuentas— desde la propia aplicación.
 *
 * La contraseña es temporal, aleatoria y se muestra una sola vez; el sistema
 * obliga a cambiarla en el primer ingreso.
 *
 *   node scripts/crear-administrador.js sistemas@empresa.pe
 *   node scripts/crear-administrador.js sistemas@empresa.pe --forzar   (si ya hay otra)
 */
async function main() {
  const correo = (process.argv[2] || '').trim().toLowerCase();
  const forzar = process.argv.includes('--forzar');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) {
    console.error('Uso: node scripts/crear-administrador.js correo@empresa.pe');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  if (await Usuario.exists({ correo })) {
    console.error(`Ya existe una cuenta con el correo ${correo}.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const otras = await Usuario.countDocuments({ rol: 'ADMIN', activo: true });
  if (otras && !forzar) {
    console.error(`Ya hay ${otras} cuenta(s) de administración activa(s). Para crear otra, use --forzar.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Cumple la política: largo, mayúsculas, minúsculas y números
  const temporal = `${crypto.randomBytes(12).toString('base64url')}Aa7`;
  await Usuario.create({ correo, contrasena: temporal, rol: 'ADMIN', activo: true, debeCambiarContrasena: true });

  console.log('\nCuenta de administración creada.\n');
  console.log(`  Correo:               ${correo}`);
  console.log(`  Contraseña temporal:  ${temporal}`);
  console.log('\nSe muestra sólo esta vez. El sistema pedirá cambiarla en el primer ingreso.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect();
  process.exit(1);
});
