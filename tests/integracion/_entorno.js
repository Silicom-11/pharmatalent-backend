/**
 * Entorno de las pruebas de integración.
 *
 * Levanta la aplicación real (rutas, middleware, modelos) en un puerto libre,
 * contra una base propia que se borra al empezar: nunca toca la base de la
 * exposición ni la de producción. Cada archivo de prueba corre en su propio
 * proceso y en serie (--test-concurrency=1).
 *
 *   npm run test:integracion
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
process.env.MONGODB_URI = process.env.MONGODB_URI_PRUEBAS || 'mongodb://localhost:27017/pharmatalent_pruebas_integracion';
process.env.MODO_EXPOSICION = '';
process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
require('../../src/config/zonaHoraria').fijarZonaHoraria();

const mongoose = require('mongoose');
const M = require('../../src/models');

if (!/pruebas/.test(process.env.MONGODB_URI)) {
  throw new Error('Las pruebas de integración sólo corren contra una base cuyo nombre contiene «pruebas».');
}

async function levantar() {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(M).map((m) => m.init()));   // índices únicos y TTL
  const app = require('../../src/app');
  const servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const base = `http://127.0.0.1:${servidor.address().port}/api`;

  async function pedir(metodo, ruta, { token, cuerpo, cabeceras = {} } = {}) {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: {
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...cabeceras,
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const texto = await r.text();
    let datos = null;
    try { datos = JSON.parse(texto); } catch { datos = texto; }
    return { estado: r.status, datos };
  }

  async function cerrar() {
    servidor.closeAllConnections?.();
    await new Promise((ok) => servidor.close(ok));
    await mongoose.disconnect();
  }
  return { base, pedir, cerrar };
}

const hoy0 = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };

/** Una organización mínima: una zona, dos boticas con terminal, puestos y cuentas */
async function organizacion() {
  const zona = await M.Zona.create({ nombre: 'Junín de prueba', codigo: 'JPR' });
  const clave = { A: 'clave-terminal-a', B: 'clave-terminal-b' };
  const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
  const local = async (codigo, nombre, marca, c) => M.Local.create({
    codigo, nombre, marca, zona: zona._id,
    direccion: { calle: 'Calle Real 100', distrito: 'Huancayo', ciudad: 'Huancayo', departamento: 'Junín' },
    terminal: { claveHash: hash(c), activo: true, altaEn: new Date() },
  });
  const localA = await local('IKF-T01', 'Inkafarma Prueba Real', 'INKAFARMA', clave.A);
  const localB = await local('MIF-T02', 'Mifarma Prueba Giráldez', 'MIFARMA', clave.B);
  const cargo = await M.Cargo.create({
    nombre: 'Técnico en Farmacia', codigo: 'TFP', departamento: 'OPERACIONES', nivel: 3,
    rolPorDefecto: 'TECNICO', rangoSueldo: { minimo: 1230, maximo: 2000 },
  });
  const persona = (dni, nombres, extra = {}) => M.Empleado.create({
    dni, nombres, apellidos: 'Prueba Integración', tipoProfesional: 'TECNICO',
    fechaIngreso: new Date(2024, 0, 15), cargoActual: cargo._id, localActual: localA._id, zona: zona._id,
    sueldoBasico: 1500, estado: 'ACTIVO', ...extra,
  });
  const tecnico = await persona('70000001', 'Técnico');
  const libre = await persona('70000002', 'Sin turno');
  const gerenteEmp = await persona('70000003', 'Gerente', { tipoProfesional: 'GERENCIA' });

  const cuenta = (correo, rol, empleado) => M.Usuario.create({ correo, contrasena: 'Prueba2026!', rol, empleado: empleado?._id });
  const admin = await cuenta('admin@pruebas.pe', 'ADMIN');
  const uTecnico = await cuenta('tecnico@pruebas.pe', 'TECNICO', tecnico);
  const gerente = await cuenta('gerente@pruebas.pe', 'GERENTE_RRHH', gerenteEmp);

  return {
    zona, localA, localB, cargo, clave, tecnico, libre,
    tokens: { admin: admin.generarToken(), tecnico: uTecnico.generarToken(), gerente: gerente.generarToken() },
    usuarios: { admin, tecnico: uTecnico, gerente },
  };
}

module.exports = { levantar, organizacion, hoy0, M, mongoose };
