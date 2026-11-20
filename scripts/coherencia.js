#!/usr/bin/env node
require('dotenv').config();
// La zona horaria se impone antes de crear cualquier fecha
require('../src/config/zonaHoraria').fijarZonaHoraria();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Empleado = require('../src/models/Empleado');
const Usuario = require('../src/models/Usuario');
const Local = require('../src/models/Local');
const Zona = require('../src/models/Zona');
const Cargo = require('../src/models/Cargo');
const Contrato = require('../src/models/Contrato');
const Horario = require('../src/models/Horario');
const Turno = require('../src/models/Turno');
const Asistencia = require('../src/models/Asistencia');
const Vacacion = require('../src/models/Vacacion');
const Planilla = require('../src/models/Planilla');
const Boleta = require('../src/models/Boleta');
const Capacitacion = require('../src/models/Capacitacion');
const DescansoMedico = require('../src/models/DescansoMedico');
const Evaluacion = require('../src/models/Evaluacion');
const Requerimiento = require('../src/models/Requerimiento');
const staffing = require('../src/services/staffing');
const payrollEngine = require('../src/services/payroll');
const { sincronizarPlanilla } = require('../src/services/planilla');
const { formatOf, requiredRoster, shiftTypesOf, LEGAL } = require('../src/config/formats');
const { ROLES } = require('../src/config/roles');
const apr = require('../src/services/aprobaciones');
const { hashClave } = require('../src/routes/terminal');
const { ROLES_CON_JORNADA, jornadaDe } = require('../src/config/jornadas');

/**
 * Última capa de datos: deja la base coherente consigo misma y con el día de hoy.
 *
 * Las capas anteriores (seed, enriquecer, completar fichas, planillas) fueron
 * escritas en momentos distintos y cada una resolvió su parte. Juntas dejaron
 * incoherencias que se notaron en la exposición:
 *
 *   · 24 empleados activos sin cuenta: aparecían en los listados, pero no
 *     había forma de entrar como ellos.
 *   · 16 cesados con la cuenta activa: seguían entrando.
 *   · Una persona con dos cuentas (Administrador del Sistema y Gerente de RRHH),
 *     y la cuenta de administración colgada del legajo de la Gerente.
 *   · Siete boticas sin un solo turno programado, y las demás con turnos que
 *     terminaban a principios de setiembre: «Mi Horario» salía vacío.
 *   · Boticas de tres o cuatro personas que no pueden cubrir ni un turno al día.
 *   · La planilla de agosto PAGADA con 158 boletas aún en CALCULADO.
 *   · Junín representado por dos boticas genéricas.
 *
 * Es idempotente: cada paso comprueba lo que ya existe. Ejecutarlo dos veces
 * deja la base igual que ejecutarlo una.
 *
 *   node scripts/coherencia.js                   simula y cuenta
 *   node scripts/coherencia.js --aplicar         escribe
 *   node scripts/coherencia.js --aplicar --demo  además, contraseña común para todas
 *                                                las cuentas y sin cambio obligatorio
 *   ... --regenerar-turnos                       rehace las cuatro semanas de turnos y
 *                                                su asistencia con el motor actual
 *
 * El modo --demo es para exponer el sistema: en producción cada cuenta nace con
 * una contraseña temporal propia y la cambia en su primer ingreso.
 */

const aplicar = process.argv.includes('--aplicar');
const demo = process.argv.includes('--demo');
const regenerar = process.argv.includes('--regenerar-turnos');
const CLAVE_DEMO = demo ? require('./lib/clave-demo').claveDemo() : null;
const DOMINIO = 'pharmatalent.pe';

const HOY = new Date();
const DIA = 86400000;
const inicioDia = (f) => new Date(f.getFullYear(), f.getMonth(), f.getDate());
const HOY0 = inicioDia(HOY);

// ─── Azar reproducible ────────────────────────────────────────────────────────
// Con Math.random cada ejecución inventaría personas distintas y la segunda
// pasada no reconocería a las de la primera. Con semilla fija, sí.
function generador(semilla) {
  let a = semilla >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const azar = generador(20261001);
const entre = (min, max) => min + Math.floor(azar() * (max - min + 1));
const uno = (lista) => lista[Math.floor(azar() * lista.length)];
const redondear = (n) => Math.round(n * 100) / 100;

const informe = [];
const anota = (seccion, detalle) => { informe.push([seccion, detalle]); };

// ══════════════════════════════════════════════════════════════════════════
// JUNÍN — boticas reales de la relación oficial de InRetail
// (scripts/datos/locales-junin.json, extraída del PDF que publica la empresa)
// ══════════════════════════════════════════════════════════════════════════
const ZONAS_JUNIN = {
  HYO: {
    codigo: 'RCENTRO',                     // se conserva: la zona ya existía
    nombre: 'Junín — Huancayo',
    descripcion: 'Huancayo, El Tambo y Chilca: el núcleo urbano del valle del Mantaro.',
  },
  VSC: {
    codigo: 'JUN-VSC',
    nombre: 'Junín — Valle y Selva Central',
    descripcion: 'Jauja, Concepción, Tarma y la selva central (Chanchamayo y Satipo).',
  },
};

// [código, marca, nombre, calle, distrito, provincia, formato, zona]
const LOCALES_JUNIN = [
  ['IKF-734', 'INKAFARMA', 'Inkafarma Real Plaza Huancayo', 'Av. Ferrocarril 1035, Int. LC-106', 'Huancayo', 'Huancayo', 'ESTANDAR', 'HYO'],
  ['IKF-735', 'INKAFARMA', 'Inkafarma Open Plaza Huancayo', 'Av. Ferrocarril 146, Int. LC-23', 'Huancayo', 'Huancayo', 'ESTANDAR', 'HYO'],
  ['IKF-736', 'INKAFARMA', 'Inkafarma El Tambo', 'Jr. Santa Isabel 989', 'El Tambo', 'Huancayo', 'ESTANDAR', 'HYO'],
  ['IKF-737', 'INKAFARMA', 'Inkafarma Chilca', 'Av. 9 de Diciembre 810', 'Chilca', 'Huancayo', 'EXPRESS', 'HYO'],
  ['MIF-319', 'MIFARMA', 'Mifarma El Tambo', 'Av. Huancavelica 2001, Urb. Los Andes', 'El Tambo', 'Huancayo', 'ESTANDAR', 'HYO'],
  ['MIF-320', 'MIFARMA', 'Mifarma Huancayo Carrión', 'Av. Daniel Alcides Carrión 1549 (frente al Hospital)', 'Huancayo', 'Huancayo', 'H24', 'HYO'],
  ['IKF-738', 'INKAFARMA', 'Inkafarma Jauja', 'Av. Ricardo Palma 100', 'Jauja', 'Jauja', 'ESTANDAR', 'VSC'],
  ['IKF-739', 'INKAFARMA', 'Inkafarma Concepción', 'Jr. Nueve de Julio 191', 'Concepción', 'Concepción', 'EXPRESS', 'VSC'],
  ['IKF-740', 'INKAFARMA', 'Inkafarma Tarma', 'Jr. Lima 639', 'Tarma', 'Tarma', 'ESTANDAR', 'VSC'],
  ['IKF-741', 'INKAFARMA', 'Inkafarma La Merced', 'Jr. Tarma 315', 'Chanchamayo', 'Chanchamayo', 'ESTANDAR', 'VSC'],
  ['MIF-321', 'MIFARMA', 'Mifarma Satipo', 'Calle Manuel Prado 234', 'Satipo', 'Satipo', 'EXPRESS', 'VSC'],
];

// Brechas que se dejan a propósito: el semáforo y el bloqueo de publicación
// tienen que tener algo que mostrar. Sin ellas la demostración no enseña
// la regla más importante del sistema.
const BRECHAS_INTENCIONALES = { 'MIF-098': { QF: 1 }, 'IKF-739': { QF: 1 } };

// Cuentas con nombre fácil para la exposición
const CUENTAS_FIJAS = {
  'IKF-734:ADMIN_BOTICA': 'admin.realplaza',
  'MIF-319:ADMIN_BOTICA': 'admin.eltambo',
  'IKF-740:QF': 'qf.tarma',
  'IKF-738:ADMIN_BOTICA': 'admin.jauja',
  'IKF-736:TECNICO': 'tecnico.eltambo',
};

// Las cuentas por rol del seed (README): son las que se prueban primero, así
// que tienen que ser de personas activas con un día normal de trabajo
const CUENTAS_DEMO = ['admin.huancayo', 'admin.miraflores', 'admin.sanmiguel', 'almacen', 'auditor', 'bienestar',
  'cajero', 'capacitacion', 'dermoconsultora', 'gerente.rrhh', 'jefe.cedi', 'motorizado', 'operario.cedi',
  'planillas', 'prevencionista', 'qf.asistente', 'qf.huancayo', 'qf.miraflores', 'qf.sanmiguel', 'rutas',
  'seleccion', 'tecnico.huancayo', 'tecnico', 'trainee', 'zona.huancayo', 'zona.moderna', 'zona.norte'];

// ─── Nombres: comunes en el valle del Mantaro y en Lima ───────────────────────
const NOMBRES_M = ['Abel', 'Alberto', 'Alex', 'Andrés', 'Ángel', 'Brayan', 'Carlos', 'Christian', 'Daniel',
  'David', 'Edwin', 'Elmer', 'Eduardo', 'Fernando', 'Franklin', 'Freddy', 'Guillermo', 'Héctor', 'Hernán',
  'Jhon', 'Jorge', 'José', 'Juan', 'Julio', 'Luis', 'Marco', 'Miguel', 'Nilton', 'Pedro', 'Raúl',
  'Renzo', 'Ricardo', 'Rubén', 'Samuel', 'Víctor', 'Walter', 'Wilfredo', 'Yuri'];
const NOMBRES_F = ['Ana', 'Andrea', 'Beatriz', 'Carmen', 'Cinthia', 'Claudia', 'Diana', 'Edith', 'Elizabeth',
  'Evelyn', 'Flor', 'Gladys', 'Giovanna', 'Jackeline', 'Jenny', 'Judith', 'Karen', 'Katherine', 'Liliana',
  'Lucía', 'Luz', 'Magaly', 'María', 'Marisol', 'Milagros', 'Nancy', 'Noemí', 'Patricia', 'Pilar',
  'Raquel', 'Rosa', 'Roxana', 'Ruth', 'Sandra', 'Sonia', 'Susana', 'Vanessa', 'Yanet', 'Yesenia'];
const APELLIDOS_JUNIN = ['Huamán', 'Quispe', 'Ccanto', 'Huaynalaya', 'Ricse', 'Huatuco', 'Inga', 'Rojas',
  'Cárdenas', 'Lazo', 'Ñaupari', 'Taipe', 'Vilcahuamán', 'Camarena', 'Orihuela', 'Meza', 'Yupanqui', 'Poma',
  'Arauco', 'Baldeón', 'Canchanya', 'Chuquillanqui', 'Mucha', 'Zevallos', 'Ccahuana', 'Palacios', 'Solís',
  'Matos', 'Arroyo', 'Torres', 'Hinostroza', 'Gamarra', 'Laura', 'Rosales', 'Sulca', 'Quinto', 'Romero',
  'Aliaga', 'Vásquez', 'De La Cruz', 'Galarza', 'Huari', 'Llacza', 'Paucar', 'Rivera', 'Ticse'];
const APELLIDOS_LIMA = ['García', 'Flores', 'Sánchez', 'Ramírez', 'Mendoza', 'Castillo', 'Chávez', 'Vargas',
  'Gutiérrez', 'Morales', 'Ríos', 'Salazar', 'Herrera', 'Medina', 'Aguilar', 'Rivas', 'Paredes', 'Cruz',
  'Ortiz', 'Silva', 'Reyes', 'Ramos', 'Peña', 'León', 'Cabrera', 'Valdivia', 'Espinoza', 'Montoya'];

// ─── Correspondencia de puesto ───────────────────────────────────────────────
const CARGO_DE_ROL = {
  QF_DT: 'QFD', QF: 'QFA', TECNICO: 'TCF', CAJERO: 'CAJ', DERMOCONSULTOR: 'DER',
  AUX_ALMACEN: 'AXA', PREVENCIONISTA: 'PRV', MOTORIZADO: 'MOT', ADMIN_BOTICA: 'ADB',
  OPERARIO_CEDI: 'OPK', COORD_RUTAS: 'CRD', JEFE_ZONA: 'SZO',
};
const TIPO_PROFESIONAL = {
  QFD: 'QF', QFA: 'QF', TCF: 'TECNICO', TRN: 'TECNICO', ADB: 'JEFE_LOCAL', SZO: 'JEFE_ZONA',
  CAJ: 'OPERARIO', DER: 'OPERARIO', AXA: 'OPERARIO', PRV: 'OPERARIO', MOT: 'OPERARIO',
  OPK: 'OPERARIO', OMC: 'OPERARIO', CRD: 'OPERARIO', JCD: 'JEFE_LOCAL', JSI: 'GERENCIA',
};

/** Personas que hacen falta por puesto para cubrir una semana sin pasar los topes de ley */
function dotacionNecesaria(local) {
  const fmt = formatOf(local);
  const turnosSemana = {};
  for (const tipo of shiftTypesOf(local)) {
    for (const [rol, n] of Object.entries(requiredRoster(local, tipo))) {
      turnosSemana[rol] = (turnosSemana[rol] || 0) + n * 7;
    }
  }
  // Seis turnos por persona: 48 horas de 8, con su día de descanso
  const porPersona = Math.min(LEGAL.maxConsecutiveDays, Math.floor(LEGAL.maxWeeklyHours / LEGAL.maxDailyHours));
  const dotacion = {};
  for (const [rol, slots] of Object.entries(turnosSemana)) {
    // Un respaldo en los puestos de los que depende abrir: QF y técnico
    dotacion[rol] = Math.ceil(slots / porPersona) + (['QF', 'TECNICO'].includes(rol) ? 1 : 0);
  }
  if (fmt.requiresAdmin && !fmt.esLogistico) dotacion.ADMIN_BOTICA = 1;
  return dotacion;
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(aplicar ? '\nAPLICANDO coherencia de datos' : '\nSIMULACIÓN (nada se escribe; use --aplicar)');
  if (demo) console.log('Modo demostración: contraseña común para todas las cuentas\n');

  const cargos = Object.fromEntries((await Cargo.find().lean()).map((c) => [c.codigo, c]));
  const usados = {
    dni: new Set(await Empleado.distinct('dni')),
    correo: new Set((await Usuario.distinct('correo')).map((c) => c.toLowerCase())),
    nombre: new Set((await Empleado.find().select('nombres apellidos').lean()).map((e) => `${e.nombres} ${e.apellidos}`)),
  };
  const hashDemo = demo ? await bcrypt.hash(CLAVE_DEMO, 12) : null;
  const rrhh = await Usuario.findOne({ rol: 'GERENTE_RRHH', activo: true }).select('_id').lean();

  // ── Utilidades que dependen de lo leído ─────────────────────────────────────
  function nuevoDni() {
    let d;
    do { d = String(entre(41000000, 47999999)); } while (usados.dni.has(d));
    usados.dni.add(d);
    return d;
  }
  function nuevaPersona(region) {
    const apellidos = region === 'JUNIN' ? APELLIDOS_JUNIN : APELLIDOS_LIMA;
    for (;;) {
      const mujer = azar() < 0.55;
      const nombres = uno(mujer ? NOMBRES_F : NOMBRES_M);
      const ape = `${uno(apellidos)} ${uno(azar() < 0.7 ? apellidos : APELLIDOS_LIMA)}`;
      if (ape.split(' ')[0] === ape.split(' ')[1]) continue;
      const completo = `${nombres} ${ape}`;
      if (usados.nombre.has(completo)) continue;
      usados.nombre.add(completo);
      return { nombres, apellidos: ape, sexo: mujer ? 'F' : 'M' };
    }
  }
  const sinTilde = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/gi, 'n').toLowerCase();
  function nuevoCorreo(persona, fijo) {
    if (fijo && !usados.correo.has(`${fijo}@${DOMINIO}`)) {
      usados.correo.add(`${fijo}@${DOMINIO}`);
      return `${fijo}@${DOMINIO}`;
    }
    const base = `${sinTilde(persona.nombres.split(' ')[0])}.${sinTilde(persona.apellidos.split(' ')[0]).replace(/\s+/g, '')}`;
    let c = `${base}@${DOMINIO}`;
    for (let i = 2; usados.correo.has(c); i++) c = `${base}${i}@${DOMINIO}`;
    usados.correo.add(c);
    return c;
  }

  /** Crea el legajo, el contrato y la cuenta de una persona nueva */
  async function contratar({ local, zonaId, codigoCargo, region, fijo, esDirectorTecnico = false, ingresaHoy = false }) {
    const cargo = cargos[codigoCargo];
    const persona = nuevaPersona(region);
    const anios = ingresaHoy ? 0 : entre(0, 9);
    const ingreso = ingresaHoy ? new Date(HOY0) : new Date(HOY.getFullYear() - anios, entre(0, 11), entre(1, 28));
    if (ingreso > HOY) ingreso.setFullYear(ingreso.getFullYear() - 1);
    const rango = cargo.rangoSueldo || { minimo: 1130, maximo: 1500 };
    const sueldo = Math.round((rango.minimo + azar() * (rango.maximo - rango.minimo)) / 10) * 10;
    const tipoProfesional = TIPO_PROFESIONAL[codigoCargo] || 'OPERARIO';
    const dni = nuevoDni();
    const correo = nuevoCorreo(persona, fijo);

    const datos = {
      dni, ...persona,
      fechaNacimiento: new Date(HOY.getFullYear() - entre(22, 52), entre(0, 11), entre(1, 28)),
      telefono: `9${entre(10000000, 99999999)}`,
      correo,
      direccion: {
        calle: `${uno(['Jr.', 'Av.', 'Psje.'])} ${uno(['Ancash', 'Ica', 'Lima', 'Puno', 'Cusco', 'Huánuco', 'Arequipa', 'Libertad', 'Junín'])} ${entre(100, 1999)}`,
        distrito: local.direccion?.distrito,
        ciudad: local.direccion?.ciudad,
        departamento: local.direccion?.departamento,
      },
      tipoProfesional,
      ...(tipoProfesional === 'QF' ? {
        numeroCQF: `CQF-${entre(10000, 29999)}`,
        vencimientoCQF: new Date(HOY.getFullYear() + entre(0, 2), entre(0, 11), 28),
        esDirectorTecnico,
      } : {}),
      fechaIngreso: ingreso,
      ...(codigoCargo === 'TRN' ? { esPracticante: true, fechaFinPracticas: new Date(ingreso.getTime() + 180 * DIA) } : {}),
      cargoActual: cargo._id,
      localActual: local._id,
      zona: zonaId,
      estado: 'ACTIVO',
      sueldoBasico: sueldo,
      sistemaPensiones: uno(['ONP', 'AFP_INTEGRA', 'AFP_PRIMA', 'AFP_PROFUTURO', 'AFP_HABITAT']),
      tieneHijos: azar() < 0.4,
      preferenciasTurno: { turnoPreferido: uno(['CUALQUIERA', 'CUALQUIERA', 'MANANA', 'TARDE']) },
    };
    if (!aplicar) return { ...datos, _id: new mongoose.Types.ObjectId() };

    const emp = await Empleado.create(datos);

    // Contrato: con cinco años o más, la relación es indeterminada por ley
    // (D.S. 003-97-TR); antes, plazo fijo con su renovación vigente
    const indeterminado = anios >= 5;
    const practicas = codigoCargo === 'TRN';
    const inicioVigente = indeterminado || ingresaHoy ? ingreso : new Date(Math.max(ingreso, HOY - entre(30, 300) * DIA));
    const finVigente = indeterminado ? null
      : new Date(inicioVigente.getTime() + (practicas ? 180 : uno([180, 180, 365, 365, 365])) * DIA);
    // Algunos vencen dentro de 30 días: las alertas necesitan casos reales
    if (finVigente && !ingresaHoy && azar() < 0.1) finVigente.setTime(HOY0.getTime() + entre(5, 28) * DIA);
    await Contrato.create({
      empleado: emp._id, tipo: indeterminado ? 'INDETERMINADO' : (practicas ? 'PRACTICAS' : 'PLAZO_FIJO'),
      fechaInicio: inicioVigente, fechaFin: finVigente, cargo: cargo._id, sueldo,
      estado: !finVigente ? 'VIGENTE' : (finVigente - HOY0 <= 30 * DIA ? 'POR_VENCER' : 'VIGENTE'),
    });

    const rol = cargo.rolPorDefecto;
    if (rol && ROLES[rol] && rol !== 'ADMIN') {
      await Usuario.create({
        correo, contrasena: demo ? CLAVE_DEMO : crypto.randomBytes(9).toString('base64url'),
        rol, empleado: emp._id, activo: true, debeCambiarContrasena: !demo,
      });
    }
    return emp;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1 · Estructura: zonas y boticas de Junín
  // ══════════════════════════════════════════════════════════════════════════
  const zonas = {};
  for (const [clave, z] of Object.entries(ZONAS_JUNIN)) {
    let zona = await Zona.findOne({ codigo: z.codigo });
    if (!zona && aplicar) zona = await Zona.create({ codigo: z.codigo, nombre: z.nombre, descripcion: z.descripcion, activo: true });
    else if (zona && aplicar && zona.nombre !== z.nombre) {
      zona.nombre = z.nombre; zona.descripcion = z.descripcion; await zona.save();
    }
    zonas[clave] = zona || { _id: new mongoose.Types.ObjectId(), ...z };
  }

  const departamentoDe = { Huancayo: 'Junín', Jauja: 'Junín', Concepción: 'Junín', Tarma: 'Junín', Chanchamayo: 'Junín', Satipo: 'Junín' };
  let localesNuevos = 0;
  for (const [codigo, marca, nombre, calle, distrito, provincia, formato, zonaClave] of LOCALES_JUNIN) {
    if (await Local.exists({ codigo })) continue;
    localesNuevos++;
    if (!aplicar) continue;
    const fmt = formatOf({ formato });
    const h24 = formato === 'H24';
    await Local.create({
      codigo, nombre, marca, tipo: 'BOTICA', formato,
      direccion: { calle, distrito, ciudad: provincia, departamento: departamentoDe[provincia] || 'Junín' },
      zona: zonas[zonaClave]._id,
      horarioAtencion: h24 ? { apertura: '00:00', cierre: '23:59' } : { apertura: '08:00', cierre: '22:00' },
      turnos: {
        tipos: fmt.shiftTypes,
        horario: h24
          ? { MANANA: { inicio: '07:00', fin: '15:00' }, TARDE: { inicio: '15:00', fin: '23:00' }, NOCHE: { inicio: '23:00', fin: '07:00' } }
          : { MANANA: { inicio: '08:00', fin: '15:00' }, TARDE: { inicio: '15:00', fin: '22:00' } },
      },
      codigoDigemid: `EF-12-${codigo.slice(-3)}`,
      activo: true,
    });
  }
  // Las dos boticas de Huancayo que ya existían pasan a la zona con su nombre
  if (aplicar) await Local.updateMany({ codigo: { $in: ['IKF-733', 'MIF-318'] } }, { zona: zonas.HYO._id });
  anota('Junín', `${localesNuevos} boticas reales añadidas · 2 zonas (Huancayo; Valle y Selva Central)`);

  // ══════════════════════════════════════════════════════════════════════════
  // 2 · Dotación: cada botica con la gente que su formato necesita
  // ══════════════════════════════════════════════════════════════════════════
  const VIGENTES = ['ACTIVO', 'VACACIONES', 'LICENCIA'];
  // 2.0  Quien administraba una botica con un cargo corporativo mal cargado
  //      (Gerente de RRHH) pasó a cajero en una corrección anterior, y su
  //      botica se quedó sin administrador. Era el administrador: se le
  //      reconoce el puesto en lugar de contratar a otro.
  let reconocidos = 0;
  for (const e of await Empleado.find({ 'historialCargos.motivo': /^Corrección de cargo/, cargoActual: cargos.CAJ?._id, estado: { $in: VIGENTES } }).lean()) {
    if (await Empleado.exists({ localActual: e.localActual, cargoActual: cargos.ADB._id, estado: { $in: VIGENTES } })) continue;
    reconocidos++;
    if (!aplicar) continue;
    await Empleado.updateOne({ _id: e._id }, {
      cargoActual: cargos.ADB._id, tipoProfesional: TIPO_PROFESIONAL.ADB,
      $push: { historialCargos: { cargo: cargos.ADB._id, local: e.localActual, fechaInicio: HOY0, motivo: 'Reconocido como Administrador de Botica: ya ejercía el puesto' } },
    });
  }
  anota('Dotación', `${reconocidos} administrador(es) de botica reconocido(s) en su puesto (el responsable de cada botica se fija más abajo)`);

  const operativos = await Local.find({ tipo: { $in: ['BOTICA', 'CEDI'] }, activo: true });
  let contratados = 0;
  for (const local of operativos) {
    const esJunin = String(local.zona) === String(zonas.HYO._id) || String(local.zona) === String(zonas.VSC._id);
    // Quien está de vacaciones o de licencia sigue siendo plantilla: no es una
    // vacante y no se contrata por él
    const staff = await Empleado.find({ localActual: local._id, estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
      .populate('cargoActual', 'codigo rolPorDefecto').lean();
    const tengo = {};
    for (const e of staff) {
      const rol = staffing.shiftRoleOf(e);
      const clave = rol === 'QF_ASISTENTE' ? 'QF' : rol;
      tengo[clave] = (tengo[clave] || 0) + 1;
    }
    const necesito = dotacionNecesaria(local);
    for (const [rol, n] of Object.entries(BRECHAS_INTENCIONALES[local.codigo] || {})) necesito[rol] -= n;

    const tieneDT = staff.some((e) => e.esDirectorTecnico);
    for (const [rol, n] of Object.entries(necesito)) {
      const faltan = n - (tengo[rol] || 0);
      for (let i = 0; i < faltan; i++) {
        const esDT = rol === 'QF' && !tieneDT && i === 0;
        const codigoCargo = esDT ? 'QFD' : CARGO_DE_ROL[rol];
        if (!codigoCargo || !cargos[codigoCargo]) continue;
        const fijo = CUENTAS_FIJAS[`${local.codigo}:${esDT ? 'QF' : rol}`];
        const emp = await contratar({
          local, zonaId: local.zona, codigoCargo, region: esJunin ? 'JUNIN' : 'LIMA', fijo, esDirectorTecnico: esDT,
        });
        contratados++;
        if (!aplicar) console.log(`  contrataría: ${local.codigo} ${rol}`);
        if (aplicar && esDT) await Local.updateOne({ _id: local._id }, { directorTecnico: emp._id });
        if (aplicar && rol === 'ADMIN_BOTICA') await Local.updateOne({ _id: local._id }, { responsable: emp._id });
      }
    }
  }
  anota('Dotación', `${contratados} personas contratadas para que cada botica cubra su formato (con legajo, contrato y cuenta)`);

  // 2.b  Nadie trabaja sin contrato vigente. Quien siguió laborando después del
  //      vencimiento tiene, por ley, la relación renovada (D.S. 003-97-TR): se
  //      registra la renovación; con cinco años acumulados, indeterminada.
  //      Un contrato «por vencer» cuya fecha ya pasó no está al día: antes se
  //      daba por bueno y 32 personas trabajaban con el contrato vencido. Tres
  //      quedan así a propósito, para que la alerta de desnaturalización
  //      (LPCL, art. 77) tenga qué mostrar.
  const VENCIDOS_A_PROPOSITO = 3;
  const alDia = { estado: { $in: ['VIGENTE', 'POR_VENCER'] }, $or: [{ fechaFin: null }, { fechaFin: { $gte: HOY0 } }] };
  const sinContrato = [];
  for (const e of await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } }).lean()) {
    if (await Contrato.exists({ empleado: e._id, ...alDia })) continue;
    sinContrato.push(e);
  }
  const correosDeDemo = [...CUENTAS_DEMO, ...Object.values(CUENTAS_FIJAS)].map((c) => `${c}@${DOMINIO}`);
  const demoContrato = new Set((await Usuario.find({ correo: { $in: correosDeDemo } }).select('empleado').lean())
    .map((u) => String(u.empleado)));
  const vencidosAProposito = new Set(sinContrato
    .filter((e) => !demoContrato.has(String(e._id)))
    .sort((a, b) => parseInt(String(a._id).slice(-6), 16) - parseInt(String(b._id).slice(-6), 16))
    .slice(0, VENCIDOS_A_PROPOSITO).map((e) => String(e._id)));
  let renovados = 0;
  for (const e of sinContrato) {
    if (vencidosAProposito.has(String(e._id))) continue;
    renovados++;
    if (!aplicar) continue;
    const ultimo = await Contrato.findOne({ empleado: e._id }).sort({ fechaInicio: -1 });
    const anios = (HOY - new Date(e.fechaIngreso)) / (365.25 * DIA);
    const desde = ultimo?.fechaFin ? new Date(new Date(ultimo.fechaFin).getTime() + DIA) : new Date(e.fechaIngreso);
    const indeterminado = anios >= 5;
    const hasta = indeterminado ? null : new Date(Math.max(desde.getTime(), HOY0.getTime()) + uno([180, 365]) * DIA);
    if (ultimo && ['VIGENTE', 'VENCIDO', 'POR_VENCER'].includes(ultimo.estado)) {
      ultimo.estado = 'RENOVADO';
      await ultimo.save();
    }
    await Contrato.create({
      empleado: e._id, tipo: indeterminado ? 'INDETERMINADO' : (ultimo?.tipo === 'INDETERMINADO' ? 'INDETERMINADO' : 'PLAZO_FIJO'),
      fechaInicio: desde, fechaFin: hasta, cargo: e.cargoActual, sueldo: e.sueldoBasico, estado: 'VIGENTE',
    });
  }
  anota('Contratos', `${renovados} contratos renovados de personal que seguía trabajando sin uno vigente · `
    + `${vencidosAProposito.size} vencidos a propósito (alerta de desnaturalización)`);

  // 2.c  Incorporaciones del mes: el personal nuevo entra el día 1. Que el mes
  //      en curso no tenga ninguna dejaba sin respuesta la pregunta más típica
  //      del docente: «¿cuántos se contrataron este mes?»
  const inicioMes = new Date(HOY.getFullYear(), HOY.getMonth(), 1);
  let incorporados = 0;
  if (!(await Empleado.exists({ fechaIngreso: { $gte: inicioMes } }))) {
    for (const codigo of ['IKF-734', 'IKF-736', 'MIF-319']) {
      const local = await Local.findOne({ codigo }).lean();
      if (!local) continue;
      await contratar({ local, zonaId: local.zona, codigoCargo: 'TRN', region: 'JUNIN', ingresaHoy: true });
      incorporados++;
    }
  }
  anota('Contratos', `${incorporados} técnicos en entrenamiento incorporados hoy en boticas de Huancayo`);

  // Responsables de local: Administrador si lo hay; si no (Express), el Director Técnico
  if (aplicar) {
    for (const local of await Local.find({ tipo: 'BOTICA' })) {
      const staff = await Empleado.find({ localActual: local._id, estado: 'ACTIVO' }).populate('cargoActual', 'codigo').lean();
      const admin = staff.find((e) => e.cargoActual?.codigo === 'ADB');
      const dt = staff.find((e) => e.esDirectorTecnico) || staff.find((e) => e.cargoActual?.codigo === 'QFD');
      const cambios = {};
      if (dt && String(local.directorTecnico) !== String(dt._id)) cambios.directorTecnico = dt._id;
      const resp = admin || dt;
      if (resp && String(local.responsable) !== String(resp._id)) cambios.responsable = resp._id;
      if (Object.keys(cambios).length) await Local.updateOne({ _id: local._id }, cambios);
    }
  }

  // 2.d  Ajuste a la RMV (mantenimiento adaptativo MNT-2026-014). Desde el
  //      01/10/2026 la RMV es S/ 1,230 (D.S. 015-2026-TR): nadie a jornada
  //      completa puede ganar menos. Se sube el sueldo de quien quedó debajo,
  //      con su línea en el historial, el de su contrato vigente y el mínimo
  //      del puesto, para que las contrataciones nuevas ya nazcan legales.
  const P = require('../src/config/payrollParams');
  const rmvActual = P.rmvVigenteDetalle(HOY);
  const desdeRmv = (() => { const [y, m, d] = rmvActual.desde.split('-').map(Number); return new Date(y, m - 1, d); })();
  const motivoRmv = `Ajuste a la RMV de S/ ${rmvActual.valor} (${rmvActual.norma})`;
  let ajustadosRmv = 0, contratosRmv = 0, puestosRmv = 0;
  if (aplicar) {
    for (const c of await Cargo.find({ 'rangoSueldo.minimo': { $lt: rmvActual.valor } })) {
      c.rangoSueldo.minimo = rmvActual.valor;
      if ((c.rangoSueldo.maximo || 0) < rmvActual.valor) c.rangoSueldo.maximo = rmvActual.valor;
      await c.save();
      puestosRmv++;
    }
    const bajoRmv = await Empleado.find({ estado: { $ne: 'CESADO' }, sueldoBasico: { $lt: rmvActual.valor } });
    for (const e of bajoRmv) {
      if (!e.historialSueldos?.length) {
        e.historialSueldos.push({ monto: e.sueldoBasico, fechaVigencia: e.fechaIngreso || desdeRmv, motivo: 'Remuneración de ingreso' });
      }
      // Quien ingresó después del alza cobra el mínimo desde su ingreso
      const vigencia = e.fechaIngreso && e.fechaIngreso > desdeRmv ? e.fechaIngreso : desdeRmv;
      e.historialSueldos.push({ monto: rmvActual.valor, fechaVigencia: vigencia, motivo: motivoRmv });
      e.sueldoBasico = rmvActual.valor;
      await e.save();
      ajustadosRmv++;
    }
    // Todo contrato que rige algún día desde el alza, no sólo el VIGENTE: la
    // planilla toma el contrato por fechas, y uno de prácticas que terminó en
    // noviembre (ya RENOVADO) seguía pagando octubre con S/ 1,130. Lo encontró
    // la prueba funcional CP-05.
    const r = await Contrato.updateMany(
      {
        tipo: { $ne: 'PART_TIME' }, sueldo: { $lt: rmvActual.valor },
        $or: [{ fechaFin: null }, { fechaFin: { $gte: desdeRmv } }],
      },
      { $set: { sueldo: rmvActual.valor } },
    );
    contratosRmv = r.modifiedCount;
  }
  anota('Contratos', `RMV S/ ${rmvActual.valor} (${rmvActual.norma}): ${ajustadosRmv} sueldos, ${contratosRmv} contratos y ${puestosRmv} puestos ajustados al mínimo legal`);

  // ══════════════════════════════════════════════════════════════════════════
  // 3 · Jefaturas de zona: cada zona con operación, con su supervisor activo
  // ══════════════════════════════════════════════════════════════════════════
  let jefesNuevos = 0;
  for (const zona of await Zona.find({ activo: true })) {
    const locales = await Local.find({ zona: zona._id, tipo: 'BOTICA', activo: true }).select('_id').lean();
    if (!locales.length) continue;
    const candidatos = await Empleado.find({ zona: zona._id, estado: 'ACTIVO' }).populate('cargoActual', 'codigo').lean();
    let jefe = candidatos.find((e) => e.cargoActual?.codigo === 'SZO');
    if (!jefe) {
      const sede = await Local.findOne({ codigo: 'SEDE-01' }).lean();
      const fijo = zona.codigo === 'JUN-VSC' ? 'zona.junin' : zona.codigo === 'LSUR' ? 'zona.sur' : null;
      jefe = await contratar({
        local: { _id: null, direccion: (await Local.findById(locales[0]._id).lean()).direccion },
        zonaId: zona._id, codigoCargo: 'SZO',
        region: ['JUN-VSC', 'RCENTRO'].includes(zona.codigo) ? 'JUNIN' : 'LIMA', fijo,
      });
      if (aplicar) await Empleado.updateOne({ _id: jefe._id }, { $unset: { localActual: 1 } });
      jefesNuevos++;
      void sede;
    }
    if (aplicar && String(zona.responsable) !== String(jefe._id)) await Zona.updateOne({ _id: zona._id }, { responsable: jefe._id });
  }
  anota('Jefaturas', `${jefesNuevos} supervisores de zona designados donde no había uno activo`);

  // 3.b  Un puesto de una sola persona no puede quedar vacío por un estado de
  //      demostración. El enriquecimiento eligió al azar a dos veteranos para
  //      dejarlos suspendidos y uno era el único Analista de Capacitación: el
  //      rol se quedó sin nadie que lo ejerza y ninguna de sus pantallas se
  //      podía probar. La suspensión pasa a un técnico de la botica que más
  //      técnicos tiene, donde su ausencia no deja turnos sin cubrir.
  const PUESTOS_UNICOS = ['GERENTE_RRHH', 'ANALISTA_NOMINAS', 'ANALISTA_SELECCION', 'ANALISTA_CAPACITACION',
    'GESTOR_BIENESTAR', 'AUDITOR_CALIDAD', 'JEFE_CEDI', 'COORD_RUTAS'];
  const conCuentaFija = (await Usuario.find({ correo: { $in: Object.values(CUENTAS_FIJAS).map((c) => `${c}@${DOMINIO}`) } })
    .select('empleado').lean()).map((u) => u.empleado);
  let restituidos = 0;
  for (const cargo of Object.values(cargos).filter((c) => c.activo !== false && PUESTOS_UNICOS.includes(c.rolPorDefecto))) {
    if (await Empleado.exists({ cargoActual: cargo._id, estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })) continue;
    const suspendido = await Empleado.findOne({ cargoActual: cargo._id, estado: 'INACTIVO' }).sort({ fechaIngreso: 1 }).lean();
    if (!suspendido) continue;
    restituidos++;
    if (!aplicar) { anota('Jefaturas', `${suspendido.nombres} ${suspendido.apellidos} volvería a su puesto (${cargo.nombre})`); continue; }
    const [mayor] = await Empleado.aggregate([
      { $match: { cargoActual: cargos.TCF._id, estado: 'ACTIVO', esPracticante: { $ne: true }, _id: { $nin: conCuentaFija } } },
      { $group: { _id: '$localActual', ids: { $push: '$_id' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 1 },
    ]);
    await Empleado.updateOne({ _id: suspendido._id }, { estado: 'ACTIVO' });
    if (mayor) await Empleado.updateOne({ _id: mayor.ids[mayor.ids.length - 1] }, { estado: 'INACTIVO' });
    anota('Jefaturas', `${suspendido.nombres} ${suspendido.apellidos} vuelve a su puesto (${cargo.nombre}): era el único titular`);
  }
  if (!restituidos) anota('Jefaturas', 'Todos los puestos de una sola persona tienen titular');

  // ══════════════════════════════════════════════════════════════════════════
  // 4.0 · El estado del legajo sale de un registro
  // ══════════════════════════════════════════════════════════════════════════
  // 18 personas figuraban «de vacaciones» y 8 «de licencia» sin una vacación
  // aprobada ni una licencia que cubriera hoy: los dejó así el enriquecimiento,
  // con fechas que ya pasaron. Su jornada salía vacía, el tablero contaba
  // vacaciones que no existían y algunas eran las cuentas de demostración.
  // Se registra lo que el estado afirma (hasta seis de vacaciones y tres de
  // licencia, aprobadas por su cadena real) y el resto vuelve a ACTIVO.
  const demoIds = new Set((await Usuario.find({ correo: { $in: [...CUENTAS_DEMO, ...Object.values(CUENTAS_FIJAS)].map((c) => `${c}@${DOMINIO}`) } })
    .select('empleado').lean()).map((u) => String(u.empleado)));
  const cubreHoy = { fechaInicio: { $lte: HOY0 }, fechaFin: { $gte: HOY0 } };
  const aprobadaHoy = async (empleado, tipo) => Vacacion.exists({ empleado, tipo, estado: { $in: ['APROBADO', 'EN_CURSO'] }, ...cubreHoy });
  /** Vacación o licencia aprobada por cada paso de su cadena, con su aprobador real */
  async function registrarAusencia(e, tipo, dias) {
    const ctx = await apr.contextoDe(e._id);
    if (!ctx?.rol) return false;
    const cadena = apr.cadenaDe(ctx);
    const inicio = new Date(HOY0.getTime() - entre(1, Math.min(5, dias - 2)) * DIA);
    const aprobaciones = [];
    for (const paso of cadena) {
      const [quien] = await apr.destinatariosDe(paso, ctx);
      aprobaciones.push({ paso, usuario: quien, decision: 'APROBADO', comentario: paso === 'LOCAL' ? 'Cobertura confirmada con el equipo' : 'Autorizado', fecha: new Date(inicio.getTime() - entre(8, 20) * DIA) });
    }
    if (!aplicar) return true;
    await Vacacion.create({
      empleado: e._id, tipo, fechaInicio: inicio, fechaFin: new Date(inicio.getTime() + (dias - 1) * DIA), diasTotales: dias,
      estado: 'APROBADO', cadena, aprobaciones,
      aprobadoPor: aprobaciones.at(-1)?.usuario, aprobadoEn: aprobaciones.at(-1)?.fecha,
      motivo: tipo === 'VACACIONES' ? uno(['Vacaciones programadas', 'Viaje familiar', 'Descanso anual']) : uno(['Asuntos familiares', 'Estudios', 'Trámite personal']),
    });
    return true;
  }
  let respaldadas = 0, estadosCorregidos = 0;
  for (const [estado, tipo, cupo, dias] of [['VACACIONES', 'VACACIONES', 6, 15], ['LICENCIA', 'LICENCIA_SIN_GOCE', 3, 10]]) {
    const enEstado = await Empleado.find({ estado }).sort({ dni: 1 }).lean();
    let conRespaldo = 0;
    const sinRespaldo = [];
    for (const e of enEstado) {
      const ok = await aprobadaHoy(e._id, tipo)
        || (estado === 'LICENCIA' && await DescansoMedico.exists({ empleado: e._id, estado: { $ne: 'RECHAZADO' }, ...cubreHoy }));
      if (ok) conRespaldo++; else sinRespaldo.push(e);
    }
    for (const e of sinRespaldo) {
      if (!demoIds.has(String(e._id)) && conRespaldo < cupo && await registrarAusencia(e, tipo, dias)) {
        conRespaldo++; respaldadas++;
        continue;
      }
      estadosCorregidos++;
      if (aplicar) await Empleado.updateOne({ _id: e._id }, { estado: 'ACTIVO' });
    }
  }
  // Y al revés: con una vacación o licencia aprobada que cubre hoy, el estado lo dice
  for (const [tipo, estado] of [['VACACIONES', 'VACACIONES'], ['LICENCIA_SIN_GOCE', 'LICENCIA']]) {
    const ids = await Vacacion.distinct('empleado', { tipo, estado: { $in: ['APROBADO', 'EN_CURSO'] }, ...cubreHoy });
    const r = aplicar
      ? (await Empleado.updateMany({ _id: { $in: ids }, estado: 'ACTIVO' }, { estado })).modifiedCount
      : await Empleado.countDocuments({ _id: { $in: ids }, estado: 'ACTIVO' });
    estadosCorregidos += r;
  }
  anota('Legajos', `${respaldadas} ausencias registradas con su aprobación · ${estadosCorregidos} estados corregidos para que coincidan con lo registrado`);

  // 4.0.b  Cada cuenta por rol, de una persona activa del mismo cargo. Si su
  //        titular está cesado, suspendido o ausente, la cuenta pasa a un
  //        compañero activo (de su mismo local si lo hay), cuya cuenta personal
  //        se cierra: una persona, una cuenta. Quien la tenía conserva o
  //        recibe una cuenta personal en el paso 4.e.
  let reasignadasDemo = 0;
  for (const usuario of await Usuario.find({ correo: { $in: CUENTAS_DEMO.map((c) => `${c}@${DOMINIO}`) } })) {
    const titular = await Empleado.findById(usuario.empleado).lean();
    if (titular?.estado === 'ACTIVO' && usuario.activo) continue;
    if (!titular?.cargoActual) continue;
    const ocupados = [...demoIds];
    const base = { cargoActual: titular.cargoActual, estado: 'ACTIVO', _id: { $nin: ocupados } };
    const reemplazo = await Empleado.findOne({ ...base, localActual: titular.localActual }).sort({ fechaIngreso: 1 }).lean()
      || await Empleado.findOne({ ...base, zona: titular.zona }).sort({ fechaIngreso: 1 }).lean()
      || await Empleado.findOne(base).sort({ fechaIngreso: 1 }).lean();
    if (!reemplazo) continue;
    reasignadasDemo++;
    demoIds.add(String(reemplazo._id));
    if (!aplicar) { anota('Cuentas', `${usuario.correo} pasaría de ${titular.nombres} ${titular.apellidos} (${titular.estado}) a ${reemplazo.nombres} ${reemplazo.apellidos}`); continue; }
    await Usuario.updateMany({ empleado: reemplazo._id, _id: { $ne: usuario._id }, activo: true },
      { $set: { activo: false, desactivadoEn: new Date() }, $inc: { versionToken: 1 } });
    usuario.empleado = reemplazo._id;
    usuario.activo = true;
    usuario.desactivadoEn = undefined;
    usuario.cerrarSesiones();
    await usuario.save();
    anota('Cuentas', `${usuario.correo} pasa de ${titular.nombres} ${titular.apellidos} (${titular.estado}) a ${reemplazo.nombres} ${reemplazo.apellidos}`);
  }
  if (!reasignadasDemo) anota('Cuentas', 'Todas las cuentas por rol son de personas activas');

  // ══════════════════════════════════════════════════════════════════════════
  // 4 · Cuentas: una por persona, del rol de su cargo, cerradas al cesar
  // ══════════════════════════════════════════════════════════════════════════
  // 4.a  El alias histórico deja de usarse
  const alias = aplicar ? (await Usuario.updateMany({ rol: 'JEFE_LOCAL' }, { rol: 'ADMIN_BOTICA' })).modifiedCount
    : await Usuario.countDocuments({ rol: 'JEFE_LOCAL' });
  anota('Cuentas', `${alias} cuenta(s) JEFE_LOCAL pasan a ADMIN_BOTICA (era un alias del mismo puesto)`);

  // 4.b  La cuenta de administración, en un legajo propio y no en el de la Gerente de RRHH
  let jsi = cargos.JSI;
  if (!jsi && aplicar) {
    jsi = (await Cargo.create({
      codigo: 'JSI', nombre: 'Jefe de Sistemas', departamento: 'ADMINISTRACION',
      nivelOrganizacional: 'CORPORATIVO', rolPorDefecto: 'ADMIN', nivel: 9,
      rangoSueldo: { minimo: 9000, maximo: 14000 },
      descripcion: 'Administra la plataforma: cuentas, roles, terminales y respaldos.', activo: true,
    })).toObject();
    cargos.JSI = jsi;
  }
  const cuentaAdmin = await Usuario.findOne({ correo: `admin@${DOMINIO}` });
  if (cuentaAdmin) {
    const actual = await Empleado.findById(cuentaAdmin.empleado).populate('cargoActual', 'codigo').lean();
    if (actual?.cargoActual?.codigo !== 'JSI') {
      const sede = await Local.findOne({ codigo: 'SEDE-01' }).lean();
      if (aplicar) {
        const emp = await Empleado.create({
          dni: nuevoDni(), nombres: 'Ricardo', apellidos: 'Valdez Zapata', sexo: 'M',
          fechaNacimiento: new Date(1984, 4, 12), telefono: '987654321', correo: `admin@${DOMINIO}`,
          direccion: { calle: 'Av. Javier Prado Oeste 1650', distrito: 'San Isidro', ciudad: 'Lima', departamento: 'Lima' },
          tipoProfesional: 'GERENCIA', fechaIngreso: new Date(2017, 1, 1),
          cargoActual: jsi._id, localActual: sede?._id, estado: 'ACTIVO', sueldoBasico: 11500,
          sistemaPensiones: 'AFP_INTEGRA',
        });
        await Contrato.create({ empleado: emp._id, tipo: 'INDETERMINADO', fechaInicio: emp.fechaIngreso, cargo: jsi._id, sueldo: 11500, estado: 'VIGENTE' });
        cuentaAdmin.empleado = emp._id;
        await cuentaAdmin.save();
      }
      anota('Cuentas', 'admin@ deja el legajo de la Gerente de RRHH y pasa al del Jefe de Sistemas');
    }
  }

  // 4.c  Cesados e inactivos: sin acceso
  const bajaFiltro = { estado: { $in: ['CESADO', 'INACTIVO'] } };
  const deBaja = await Empleado.find(bajaFiltro).select('_id').lean();
  const cerradas = aplicar
    ? (await Usuario.updateMany({ empleado: { $in: deBaja.map((e) => e._id) }, activo: true },
      { $set: { activo: false, desactivadoEn: new Date() }, $inc: { versionToken: 1 } })).modifiedCount
    : await Usuario.countDocuments({ empleado: { $in: deBaja.map((e) => e._id) }, activo: true });
  anota('Cuentas', `${cerradas} cuentas de personal cesado o inactivo cerradas`);

  // 4.d  Una cuenta por persona: si hay varias, queda la del rol de su cargo
  let duplicadas = 0;
  const repetidos = await Usuario.aggregate([
    { $match: { activo: true, empleado: { $ne: null } } },
    { $group: { _id: '$empleado', cuentas: { $push: { id: '$_id', rol: '$rol' } }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const r of repetidos) {
    const emp = await Empleado.findById(r._id).populate('cargoActual', 'rolPorDefecto').lean();
    const buena = r.cuentas.find((c) => c.rol === emp?.cargoActual?.rolPorDefecto) || r.cuentas[0];
    for (const c of r.cuentas) {
      if (String(c.id) === String(buena.id)) continue;
      duplicadas++;
      if (aplicar) await Usuario.updateOne({ _id: c.id }, { $set: { activo: false, desactivadoEn: new Date() }, $inc: { versionToken: 1 } });
    }
  }
  anota('Cuentas', `${duplicadas} cuenta(s) duplicada(s) de una misma persona cerradas`);

  // 4.e  Todo el personal activo con su cuenta
  const activos = await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
    .populate('cargoActual', 'rolPorDefecto codigo').lean();
  const conCuenta = new Set((await Usuario.find({ activo: true }).select('empleado').lean()).map((u) => String(u.empleado)));
  let abiertas = 0;
  for (const e of activos) {
    if (conCuenta.has(String(e._id))) continue;
    const rol = e.cargoActual?.rolPorDefecto;
    if (!rol || !ROLES[rol] || rol === 'ADMIN') continue;
    // Si la persona tuvo una cuenta cerrada por un dato heredado, se reabre esa
    const previa = await Usuario.findOne({ empleado: e._id });
    abiertas++;
    if (!aplicar) continue;
    if (previa) {
      previa.activo = true; previa.rol = rol; previa.desactivadoEn = undefined;
      await previa.save();
    } else {
      const correo = e.correo && !usados.correo.has(e.correo.toLowerCase()) ? e.correo.toLowerCase() : nuevoCorreo(e);
      usados.correo.add(correo);
      await Usuario.create({
        correo, contrasena: demo ? CLAVE_DEMO : crypto.randomBytes(9).toString('base64url'),
        rol, empleado: e._id, activo: true, debeCambiarContrasena: !demo,
      });
    }
  }
  anota('Cuentas', `${abiertas} cuentas creadas para personal activo que no podía entrar`);

  // 4.f  Modo demostración: una contraseña común y sin cambio obligatorio
  if (demo && aplicar) {
    const r = await Usuario.updateMany({ activo: true }, {
      $set: { contrasena: hashDemo, debeCambiarContrasena: false, intentosFallidos: 0 },
      $unset: { bloqueadoHasta: 1 },
    });
    anota('Cuentas', `${r.modifiedCount} cuentas activas con la contraseña de demostración`);
  }

  // 4.g  El cargo tiene que ser de un puesto que existe en su centro, y la
  //      cuenta tiene el rol de su cargo. El script de enriquecimiento dejó a
  //      dos administrativos de botica con el cargo de Gerente de RRHH, y al
  //      abrirles cuenta según su cargo recibieron acceso nacional a todos los
  //      sueldos. Un cargo corporativo fuera de la sede, o uno de botica fuera
  //      de una botica, es un error de datos, no un puesto.
  const NIVEL_DE_CENTRO = { BOTICA: 'BOTICA', CEDI: 'CEDI', SEDE_CORPORATIVA: 'CORPORATIVO' };
  const CARGO_POR_DEFECTO = { BOTICA: 'CAJ', CEDI: 'OPK' };
  let recargados = 0;
  for (const e of await Empleado.find({ estado: { $ne: 'CESADO' }, localActual: { $ne: null } })
    .populate('cargoActual', 'codigo nivelOrganizacional rolPorDefecto').populate('localActual', 'tipo').lean()) {
    // (ver 2.0: el administrativo de una botica sin administrador lo es)
    const nivelCentro = NIVEL_DE_CENTRO[e.localActual?.tipo];
    if (!nivelCentro || !e.cargoActual || e.cargoActual.nivelOrganizacional === nivelCentro) continue;
    // Un administrativo en una botica sin administrador es su administrador
    const sinAdministrador = e.localActual.tipo === 'BOTICA' && e.tipoProfesional === 'ADMINISTRATIVO'
      && !(await Empleado.exists({ localActual: e.localActual._id, cargoActual: cargos.ADB._id, estado: { $in: VIGENTES } }));
    const nuevo = cargos[sinAdministrador ? 'ADB' : CARGO_POR_DEFECTO[e.localActual.tipo]];
    if (!nuevo) continue;
    recargados++;
    if (!aplicar) continue;
    await Empleado.updateOne({ _id: e._id }, {
      cargoActual: nuevo._id, tipoProfesional: sinAdministrador ? TIPO_PROFESIONAL.ADB : TIPO_PROFESIONAL[nuevo.codigo] || 'OPERARIO',
      $push: { historialCargos: { cargo: nuevo._id, local: e.localActual._id, fechaInicio: HOY0, motivo: 'Corrección de cargo: no correspondía al centro de trabajo' } },
    });
  }
  anota('Cuentas', `${recargados} empleado(s) con un cargo ajeno a su centro de trabajo corregido(s)`);

  let reasignadas = 0;
  for (const u of await Usuario.find({ activo: true }).populate({ path: 'empleado', select: 'cargoActual', populate: { path: 'cargoActual', select: 'rolPorDefecto' } })) {
    const debido = u.empleado?.cargoActual?.rolPorDefecto;
    if (!debido || !ROLES[debido] || u.rol === debido) continue;
    // El rol de administración no se deduce del cargo: lo concede otro administrador
    if (u.rol === 'ADMIN' || debido === 'ADMIN') continue;
    reasignadas++;
    if (!aplicar) continue;
    u.rol = debido;
    u.cerrarSesiones();       // el rol viaja en el token: sin esto conservaría el anterior
    await u.save();
  }
  anota('Cuentas', `${reasignadas} cuenta(s) con un rol distinto al de su cargo, reasignadas`);

  // El cargo con un rol que no existe queda fuera de uso (nadie lo tiene)
  if (aplicar) await Cargo.updateOne({ codigo: 'ASA', rolPorDefecto: { $nin: Object.keys(ROLES) } }, { activo: false });

  // ══════════════════════════════════════════════════════════════════════════
  // 5 · Planilla: el ciclo va un mes detrás del calendario
  // ══════════════════════════════════════════════════════════════════════════
  // Mismo criterio que poblar-planillas-descansos.js: el último mes terminado se
  // está calculando (espera la aprobación de RRHH), el anterior ya se pagó y lo
  // demás está cerrado. Agosto figuraba PAGADO con 158 boletas en CALCULADO.
  // Año y mes juntos: sólo con el mes, las planillas del año anterior quedaban
  // fuera (diciembre de 2025 figuraba «por aprobar») y en enero el cálculo fallaba
  const idxUltimo = HOY.getFullYear() * 12 + HOY.getMonth() - 1;   // último mes terminado
  const periodoDe = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  const PERIODO_EN_CURSO = periodoDe(idxUltimo);
  let normalizadas = 0;
  for (const p of await Planilla.find()) {
    const { anio, mes } = p;
    const idx = anio * 12 + mes - 1;
    const destino = idx < idxUltimo - 1 ? ['CERRADA', 'PAGADO'] : idx === idxUltimo - 1 ? ['PAGADA', 'PAGADO']
      : idx === idxUltimo ? ['CALCULADA', 'CALCULADO'] : ['BORRADOR', null];
    const [estadoPlanilla, estadoBoleta] = destino;
    if (p.estado !== estadoPlanilla) {
      normalizadas++;
      // Lo que aún no ocurrió no tiene fecha: una planilla por aprobar no lleva
      // fecha de aprobación ni de pago
      const sinFechas = estadoPlanilla === 'CALCULADA' ? { $unset: { aprobadaEn: 1, aprobadaPor: 1, pagadaEn: 1 } }
        : estadoPlanilla === 'BORRADOR' ? { $unset: { calculadaEn: 1, calculadaPor: 1, aprobadaEn: 1, aprobadaPor: 1, pagadaEn: 1 } } : {};
      if (aplicar) await Planilla.updateOne({ _id: p._id }, { $set: { estado: estadoPlanilla }, ...sinFechas });
    }
    if (!estadoBoleta) continue;
    // La planilla mensual se paga al cierre: el primer día del mes siguiente. Un
    // pago fechado el 28 dejaba los días 29 a 31 «trabajados después del pago»
    // y la revisión de integridad los pedía reintegrar.
    if (estadoBoleta === 'PAGADO') {
      const cierre = new Date(anio, mes, 1);
      const antes = { periodo: p.periodo, estado: 'PAGADO', pagadoEn: { $lt: cierre } };
      const n = await Boleta.countDocuments(antes);
      normalizadas += n;
      if (aplicar && n) await Boleta.updateMany(antes, { $set: { pagadoEn: new Date(anio, mes, 1, 12), aprobadoEn: new Date(anio, mes, 0, 18) } });
    }
    const desfasadas = await Boleta.countDocuments({ periodo: p.periodo, estado: { $ne: estadoBoleta } });
    if (!desfasadas) continue;
    normalizadas += desfasadas;
    if (!aplicar) continue;
    if (estadoBoleta === 'PAGADO') {
      const pagadoEn = new Date(anio, mes, 1, 12);
      await Boleta.updateMany({ periodo: p.periodo, estado: { $ne: 'PAGADO' } }, {
        $set: { estado: 'PAGADO', aprobadoPor: rrhh?._id, aprobadoEn: new Date(anio, mes, 0, 18), pagadoEn, medioDePago: 'TRANSFERENCIA' },
      });
    } else {
      await Boleta.updateMany({ periodo: p.periodo, estado: { $ne: 'CALCULADO' } }, {
        $set: { estado: 'CALCULADO', calculadoEn: new Date(anio, mes, 0) },
        $unset: { aprobadoPor: 1, aprobadoEn: 1, pagadoEn: 1, pagadoPor: 1, medioDePago: 1, referenciaPago: 1 },
      });
    }
  }
  anota('Planilla', `${normalizadas} estados de planilla y boleta alineados con el ciclo (${PERIODO_EN_CURSO} espera la aprobación de RRHH)`);

  // ══════════════════════════════════════════════════════════════════════════
  // 6 · Turnos y asistencia anclados a hoy, en TODAS las boticas
  // ══════════════════════════════════════════════════════════════════════════
  const domingo = new Date(HOY0.getTime() - HOY0.getDay() * DIA);
  const semanas = [-14, -7, 0, 7].map((d) => new Date(domingo.getTime() + d * DIA));

  // 6.0  Con --regenerar-turnos se rehace la ventana completa. Los turnos se
  //      generaron con una versión del motor que no programaba al personal
  //      cuyo puesto no exige el formato (el Administrador, la dermoconsultora,
  //      el motorizado): no tenían horario ni podían marcar. La asistencia de
  //      la ventana se va con ellos, porque colgaba de esos turnos.
  if (regenerar && aplicar) {
    const centros = (await Local.find({ tipo: { $in: ['BOTICA', 'CEDI'] } }).select('_id').lean()).map((l) => l._id);
    const viejos = (await Horario.find({ local: { $in: centros }, inicioSemana: { $gte: semanas[0] } }).select('_id').lean()).map((h) => h._id);
    const t = await Turno.deleteMany({ $or: [{ horario: { $in: viejos } }, { local: { $in: centros }, fecha: { $gte: semanas[0] } }] });
    await Horario.deleteMany({ _id: { $in: viejos } });
    const a = await Asistencia.deleteMany({ local: { $in: centros }, fecha: { $gte: semanas[0] } });
    anota('Turnos', `--regenerar-turnos: ${viejos.length} cronogramas, ${t.deletedCount} turnos y ${a.deletedCount} marcas se rehacen con el motor actual`);
  }

  // 6.a  Un caso real para el semáforo: una QF de Concepción está de vacaciones
  //      esta semana y la próxima, y nadie la reemplaza. Con la dotación
  //      completa el sistema no tendría ninguna alerta que enseñar; recortar
  //      gente a propósito sería inventar un problema que no existe. Una
  //      vacación sin cobertura es justo lo que pasa en una botica Express.
  const concepcion = await Local.findOne({ codigo: 'IKF-739' }).lean();
  if (concepcion && aplicar) {
    const qfs = await Empleado.find({ localActual: concepcion._id, tipoProfesional: 'QF' }).sort({ esDirectorTecnico: 1, dni: 1 }).lean();
    const qf = qfs.find((e) => !e.esDirectorTecnico) || qfs[0];
    const inicioVac = semanas[2];
    const finVac = new Date(semanas[3].getTime() + 6 * DIA);
    const yaEsta = qf && await Vacacion.exists({ empleado: qf._id, estado: { $in: ['APROBADO', 'EN_CURSO', 'COMPLETADO'] }, fechaInicio: inicioVac });
    if (qf && !yaEsta) {
      const jefeVSC = await Usuario.findOne({ correo: `zona.junin@${DOMINIO}` }).select('_id').lean();
      await Vacacion.create({
        empleado: qf._id, tipo: 'VACACIONES', fechaInicio: inicioVac, fechaFin: finVac, diasTotales: 14,
        estado: 'APROBADO', cadena: ['ZONAL'],
        aprobaciones: [{ paso: 'ZONAL', usuario: jefeVSC?._id, decision: 'APROBADO', comentario: 'Autorizado: se buscará QF de reemplazo en Huancayo', fecha: new Date(inicioVac.getTime() - 20 * DIA) }],
        aprobadoPor: jefeVSC?._id, aprobadoEn: new Date(inicioVac.getTime() - 20 * DIA),
        comentarios: 'Autorizado con cobertura designada: pendiente de detallar',
        motivo: 'Vacaciones programadas',
      });
      await Empleado.updateOne({ _id: qf._id }, { estado: 'VACACIONES' });
      // Lo que se generó con ella en la plantilla se rehace sin ella
      const viejos = await Horario.find({ local: concepcion._id, inicioSemana: { $in: [semanas[2], semanas[3]] } }).select('_id').lean();
      await Turno.deleteMany({ horario: { $in: viejos.map((h) => h._id) } });
      await Horario.deleteMany({ _id: { $in: viejos.map((h) => h._id) } });
      await Asistencia.deleteMany({ local: concepcion._id, fecha: { $gte: inicioVac } });
      anota('Escenario', `${qf.nombres} ${qf.apellidos} (QF, Inkafarma Concepción) de vacaciones sin reemplazo: su botica queda con turnos sin QF`);
    }
  }
  // Ausencias con fecha: vacaciones aprobadas y descansos médicos. El estado
  // del legajo sólo dice cómo está la persona hoy; para programar una semana
  // pasada o la próxima hace falta saber qué días faltó o faltará.
  const ausencias = new Map();
  const ausente = (id, a, b) => {
    const k = String(id);
    if (!ausencias.has(k)) ausencias.set(k, []);
    ausencias.get(k).push([inicioDia(new Date(a)), inicioDia(new Date(b))]);
  };
  for (const v of await Vacacion.find({ estado: { $in: ['APROBADO', 'EN_CURSO', 'COMPLETADO'] }, fechaFin: { $gte: semanas[0] } }).select('empleado fechaInicio fechaFin').lean()) {
    ausente(v.empleado, v.fechaInicio, v.fechaFin);
  }
  for (const d of await DescansoMedico.find({ estado: { $ne: 'RECHAZADO' }, fechaFin: { $gte: semanas[0] } }).select('empleado fechaInicio fechaFin').lean()) {
    ausente(d.empleado, d.fechaInicio, d.fechaFin);
  }
  const faltaEl = (id, dia) => (ausencias.get(String(id)) || []).some(([a, b]) => dia >= a && dia <= b);

  /**
   * Quién puede trabajar la semana que empieza en `inicio`, con sus días de
   * ausencia marcados como no disponibles para el motor. Quien hoy está de
   * vacaciones trabaja las semanas anteriores a ellas; quien está de licencia
   * sin fechas registradas no se programa.
   */
  function plantillaDe(staff, inicio) {
    const fuera = [];
    for (const e of staff) {
      if (e.estado === 'VACACIONES' && !faltaEl(e._id, HOY0)) continue;
      const libres = new Set(e.preferenciasTurno?.diasNoDisponibles || []);
      let dias = 0;
      for (let d = 0; d < 7; d++) {
        const f = new Date(inicio.getTime() + d * DIA);
        if (faltaEl(e._id, f)) { libres.add(f.getDay()); dias++; }
      }
      if (dias === 7) continue;
      fuera.push({ ...e, estado: 'ACTIVO', preferenciasTurno: { ...e.preferenciasTurno, diasNoDisponibles: [...libres] } });
    }
    return fuera;
  }

  const autor = await Usuario.findOne({ rol: 'GERENTE_RRHH', activo: true }).select('_id').lean();
  let cronogramas = 0, turnosCreados = 0, criticas = 0;
  for (const local of await Local.find({ tipo: { $in: ['BOTICA', 'CEDI'] }, activo: true })) {
    const staff = await Empleado.find({ localActual: local._id, estado: { $in: ['ACTIVO', 'VACACIONES'] } })
      .populate('cargoActual', 'nombre codigo rolPorDefecto').lean();
    if (!staff.length) continue;
    for (const inicio of semanas) {
      if (await Horario.exists({ local: local._id, inicioSemana: inicio })) continue;
      cronogramas++;
      const planned = staffing.generateWeek(local, plantillaDe(staff, inicio), inicio);
      const resumen = staffing.summarizeSchedule(planned);
      turnosCreados += planned.length;
      criticas += resumen.conteoCriticas || 0;
      if (!aplicar) continue;
      // Se publica lo que la regla de publicación dejaría publicar: con un
      // turno sin QF, el cronograma se queda en borrador, igual que en la API
      const publicable = inicio <= HOY0 && !(resumen.conteoCriticas > 0);
      const horario = await Horario.create({
        local: local._id, inicioSemana: inicio, finSemana: new Date(inicio.getTime() + 6 * DIA),
        formato: local.formato, estado: publicable ? 'PUBLICADO' : 'BORRADOR',
        creadoPor: autor?._id, publicadoPor: publicable ? autor?._id : undefined,
        publicadoEn: publicable ? new Date(inicio.getTime() - 2 * DIA) : undefined,
        validacion: resumen,
      });
      await Turno.insertMany(planned.map((s) => ({ ...s, horario: horario._id })));
    }
  }
  anota('Turnos', `${cronogramas} cronogramas nuevos (2 semanas atrás, esta y la próxima) · ${turnosCreados} turnos · ${criticas} turnos sin QF`);

  // 6.e  La presencia de QF de cada turno, recalculada en la base. Los turnos
  //      insertados en lote no pasaban por el hook de guardado y quedaban con
  //      tieneQF = false: el panel avisaba de turnos «sin QF» que sí lo tenían.
  if (aplicar) {
    const r = await Turno.collection.updateMany({}, [
      { $set: { conteoQF: { $size: { $filter: { input: { $ifNull: ['$asignaciones', []] }, cond: { $in: ['$$this.rol', ['QF', 'QF_ASISTENTE']] } } } } } },
      { $set: { tieneQF: { $gt: ['$conteoQF', 0] } } },
    ]);
    anota('Turnos', `${r.modifiedCount} turnos con la presencia de QF recalculada`);
  }

  // Asistencia de lo ya transcurrido, como la habría tomado el terminal
  const enHora = (dia, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(dia); d.setHours(h, m, 0, 0); return d; };
  /** La marca de una jornada ya empezada: puntual, tarde, ausente o corregida */
  function marcaSimulada({ empleado, local, fecha, horaInicio, horaFin }) {
    const prevista = enHora(fecha, horaInicio);
    const finPrevisto = enHora(fecha, horaFin);
    if (finPrevisto <= prevista) finPrevisto.setTime(finPrevisto.getTime() + DIA);
    if (prevista > HOY) return null;               // la jornada aún no empieza
    const r = azar();
    if (r < 0.035) return { empleado, local, fecha, estado: 'AUSENTE', origen: 'TERMINAL' };
    const desvio = r < 0.15 ? entre(6, 28) : entre(-12, 4);
    const entrada = new Date(prevista.getTime() + desvio * 60000);
    const salida = finPrevisto <= HOY ? new Date(finPrevisto.getTime() + entre(-8, 40) * 60000) : undefined;
    const tardanza = desvio > 5 ? desvio : 0;
    const correccion = azar() < 0.02;
    return {
      empleado, local, fecha,
      marcaEntrada: entrada, marcaSalida: salida,
      estado: tardanza ? 'TARDANZA' : 'PRESENTE',
      minutosTardanza: tardanza,
      horasTrabajadas: salida ? redondear((salida - entrada) / 3600000) : 0,
      horasExtra: salida ? Math.max(0, redondear((salida - finPrevisto) / 3600000)) : 0,
      origen: correccion ? 'CORRECCION' : 'TERMINAL',
      metodo: correccion ? undefined : uno(['HUELLA', 'HUELLA', 'HUELLA', 'ROSTRO', 'ROSTRO', 'DNI']),
      ...(correccion ? { correccion: { motivo: uno(['El lector no reconoció la huella', 'Corte de energía en el local', 'Terminal fuera de servicio']), en: entrada } } : {}),
    };
  }

  let marcas = 0, marcasSede = 0;
  if (aplicar) {
    const desde = semanas[0];
    const turnos = await Turno.find({ fecha: { $gte: desde, $lte: HOY0 } }).select('fecha horaInicio horaFin local asignaciones').lean();
    const existentes = new Set((await Asistencia.find({ fecha: { $gte: desde } }).select('empleado fecha').lean())
      .map((a) => `${a.empleado}|${a.fecha.getTime()}`));
    const lote = [];
    // El técnico del guion marca en vivo en el terminal: hoy no se le simula
    // la marca. Si el reinicio corría después de las 15:00 ya tenía entrada y
    // el terminal le registraba la salida en vez de la entrada (MNT-2026-013)
    const enVivo = new Set((await Usuario.find({ correo: `tecnico.huancayo@${DOMINIO}` }).select('empleado').lean())
      .map((u) => String(u.empleado)));
    for (const t of turnos) {
      for (const a of t.asignaciones) {
        const clave = `${a.empleado}|${new Date(t.fecha).getTime()}`;
        if (existentes.has(clave)) continue;
        if (enVivo.has(String(a.empleado)) && new Date(t.fecha) >= HOY0) continue;
        const m = marcaSimulada({ empleado: a.empleado, local: t.local, fecha: t.fecha, horaInicio: t.horaInicio, horaFin: t.horaFin });
        if (!m) continue;
        existentes.add(clave);
        lote.push(m);
      }
    }
    marcas = lote.length;

    // 6.b  La sede no trabaja por turnos: marca de lunes a viernes según su
    //      jornada, en el terminal de la sede. Quien dirige o trabaja en campo
    //      no marca (config/jornadas.js).
    const cuentas = await Usuario.find({ activo: true, rol: { $in: ROLES_CON_JORNADA } }).select('empleado rol').lean();
    const rolDe = new Map(cuentas.map((c) => [String(c.empleado), c.rol]));
    const sede = await Empleado.find({ _id: { $in: cuentas.map((c) => c.empleado) }, estado: 'ACTIVO', localActual: { $ne: null } })
      .select('_id localActual fechaIngreso').lean();
    for (let f = new Date(desde); f <= HOY0; f = new Date(f.getTime() + DIA)) {
      for (const e of sede) {
        const j = jornadaDe(rolDe.get(String(e._id)), f);
        if (!j || e.fechaIngreso > f || faltaEl(e._id, f)) continue;
        const clave = `${e._id}|${f.getTime()}`;
        if (existentes.has(clave)) continue;
        const m = marcaSimulada({ empleado: e._id, local: e.localActual, fecha: new Date(f), horaInicio: j.horaInicio, horaFin: j.horaFin });
        if (!m) continue;
        existentes.add(clave);
        lote.push(m);
        marcasSede++;
      }
    }
    if (lote.length) await Asistencia.insertMany(lote, { ordered: false });

    // 6.b2  Una marca simulada se registra cuando ocurrió, no cuando corrió
    //       este guion. Con la fecha de hoy, la verificación de integridad las
    //       leía como marcas cargadas después de pagar la planilla de su mes
    //       (94 personas con días de setiembre «sin liquidar»). Lo detectó la
    //       rutina preventiva del 13/11/2026 (MNT-2026-021). Una corrección
    //       real hecha tarde por la jefatura conserva su fecha: es justo el
    //       caso que esa verificación debe encontrar.
    const desfasadas = await Asistencia.collection.updateMany(
      {
        $or: [{ origen: 'TERMINAL' }, { origen: 'CORRECCION', $expr: { $lte: ['$correccion.en', { $add: ['$fecha', 2 * DIA] }] } }],
        $expr: { $gt: ['$creadoEn', { $add: [{ $ifNull: ['$marcaEntrada', '$fecha'] }, 6 * 3600000] }] },
      },
      [{ $set: { creadoEn: { $ifNull: ['$marcaEntrada', '$fecha'] } } }],
    );
    if (desfasadas.modifiedCount) anota('Asistencia', `${desfasadas.modifiedCount} marcas simuladas con su fecha de registro corregida`);
  }
  anota('Asistencia', `${marcas} marcas de turnos de las últimas dos semanas y de hoy, con su origen (terminal o corrección)`);
  anota('Asistencia', `${marcasSede} marcas de la sede según su jornada administrativa (lunes a viernes, 08:30 a 17:30)`);

  // 6.c  La marca del terminal se registra en el momento. Las históricas
  //      llevaban como fecha de creación el día en que corrió el generador, y
  //      al quedar agosto pagado parecían marcas posteriores al pago —días por
  //      reintegrar— cuando no lo eran. Las correcciones manuales conservan su
  //      fecha real: ésas sí pueden ser posteriores y sí hay que vigilarlas.
  if (aplicar) {
    const r = await Asistencia.collection.updateMany(
      {
        origen: { $ne: 'CORRECCION' },
        $expr: { $gt: ['$creadoEn', { $add: [{ $ifNull: ['$marcaSalida', { $ifNull: ['$marcaEntrada', '$fecha'] }] }, 6 * 3600000] }] },
      },
      [{ $set: { creadoEn: { $ifNull: ['$marcaEntrada', '$fecha'] }, origen: { $ifNull: ['$origen', 'TERMINAL'] } } }],
    );
    anota('Asistencia', `${r.modifiedCount} marcas históricas fechadas en el momento de la marca, como las registra el terminal`);
  }

  // 6.d  La planilla en curso, calculada con el motor. Sus boletas las había
  //      dejado un script sin días, sin aportes del empleador ni costo: la
  //      pantalla mostraba «Días —» y un costo empresa de cero. Se calcula como
  //      lo haría el Analista de Planillas, con la asistencia ya registrada.
  //      Con --regenerar-turnos se recalcula siempre: la asistencia cambió.
  let recalculadas = 0;
  if (aplicar) {
    const incompletas = await Boleta.countDocuments({ periodo: PERIODO_EN_CURSO, estado: 'CALCULADO', 'aportesEmpleador.total': { $exists: false } });
    // Calculadas con una RMV que ya no era la del período (antes de MNT-2026-014)
    const asignacionDelPeriodo = redondear(P.rmvDelPeriodo(PERIODO_EN_CURSO) * P.ASIGNACION_FAMILIAR.porcentajeRMV);
    const conOtraRmv = await Boleta.countDocuments({
      periodo: PERIODO_EN_CURSO, estado: 'CALCULADO',
      'ingresos.asignacionFamiliar': { $gt: 0, $ne: asignacionDelPeriodo },
    });
    const bajoLaRmv = await Boleta.countDocuments({
      periodo: PERIODO_EN_CURSO, estado: 'CALCULADO', sueldoBasico: { $lt: P.rmvDelPeriodo(PERIODO_EN_CURSO) },
    });
    if (incompletas || regenerar || ajustadosRmv || contratosRmv || conOtraRmv || bajoLaRmv) {
      const [a, m] = PERIODO_EN_CURSO.split('-').map(Number);
      const personal = await Empleado.find({ estado: { $ne: 'CESADO' }, fechaIngreso: { $lte: new Date(a, m, 0, 23, 59, 59) } })
        .populate('cargoActual', 'nombre rolPorDefecto');
      for (const emp of personal) {
        const existente = await Boleta.findOne({ empleado: emp._id, periodo: PERIODO_EN_CURSO });
        if (existente && ['APROBADO', 'PAGADO'].includes(existente.estado)) continue;
        const calculada = await payrollEngine.computePayroll(emp, PERIODO_EN_CURSO);
        const doc = existente || new Boleta({ empleado: emp._id, periodo: PERIODO_EN_CURSO });
        Object.assign(doc, calculada, { estado: 'CALCULADO', calculadoEn: new Date(a, m, 0, 20) });
        await doc.save();
        recalculadas++;
      }
      // Boletas de quien no estaba en planilla ese mes (ingresó después o ya había cesado)
      const fuera = await Boleta.deleteMany({ periodo: PERIODO_EN_CURSO, estado: 'CALCULADO', empleado: { $nin: personal.map((e) => e._id) } });
      if (fuera.deletedCount) anota('Planilla', `${fuera.deletedCount} boleta(s) de ${PERIODO_EN_CURSO} de personas que no estaban en planilla ese mes, retiradas`);
      const analista = await Usuario.findOne({ rol: 'ANALISTA_NOMINAS', activo: true }).select('_id').lean();
      await sincronizarPlanilla(PERIODO_EN_CURSO, analista);
    }
  }
  anota('Planilla', `${recalculadas} boletas de ${PERIODO_EN_CURSO} calculadas con el motor (días, horas extra, tardanzas, aportes)`);

  // 6.f  El estado de cada registro según la fecha de hoy.
  //      · Una vacación autorizada que ya terminó está gozada; la que cubre hoy,
  //        en curso. «Mis Vacaciones» mostraba como «Autorizado» un descanso
  //        que había terminado una semana antes.
  //      · Una solicitud cuyo inicio pasó sin que nadie la decidiera venció:
  //        la bandeja del Jefe de Zona mostraba como pendiente un descanso que
  //        ya debía haber empezado.
  //      · El cronograma de una semana ya transcurrida, sin brechas, se publicó
  //        en su momento; uno que quedó en borrador no tiene sentido.
  if (aplicar) {
    const gozadas = await Vacacion.updateMany({ estado: { $in: ['APROBADO', 'EN_CURSO'] }, fechaFin: { $lt: HOY0 } }, { $set: { estado: 'COMPLETADO' } });
    const enCurso = await Vacacion.updateMany({ estado: 'APROBADO', fechaInicio: { $lte: HOY0 }, fechaFin: { $gte: HOY0 } }, { $set: { estado: 'EN_CURSO' } });
    const vencidas = await Vacacion.updateMany({ estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] }, fechaInicio: { $lt: HOY0 } }, {
      $set: { estado: 'CANCELADO', comentarios: 'Venció sin decisión: llegó su fecha de inicio sin que se resolviera. El trabajador puede volver a solicitarla.' },
    });
    const semanas = await Horario.collection.updateMany(
      { estado: 'BORRADOR', finSemana: { $lt: HOY0 }, $or: [{ 'validacion.conteoCriticas': 0 }, { 'validacion.conteoCriticas': { $exists: false } }] },
      [{ $set: { estado: 'PUBLICADO', publicadoPor: autor?._id, publicadoEn: { $subtract: ['$inicioSemana', 2 * DIA] } } }],
    );
    // Dos descansos de una misma persona que se cruzan: los dejaron capas de
    // datos distintas (la API ya rechaza el cruce). Se conserva el registrado
    // primero; el otro se retira con el motivo, y la boleta del mes en curso de
    // esa persona se recalcula porque contaba los días dos veces.
    const vivos = await Vacacion.find({ estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL', 'APROBADO', 'EN_CURSO', 'COMPLETADO'] } })
      .select('empleado fechaInicio fechaFin creadoEn').sort({ empleado: 1, fechaInicio: 1 }).lean();
    const retirar = [];
    const afectados = new Set();
    for (let i = 1; i < vivos.length; i++) {
      const x = vivos[i - 1];
      const y = vivos[i];
      if (String(x.empleado) !== String(y.empleado) || y.fechaInicio > x.fechaFin) continue;
      const posterior = (y.creadoEn || 0) >= (x.creadoEn || 0) ? y : x;
      retirar.push(posterior._id);
      afectados.add(String(posterior.empleado));
      vivos[i] = posterior === y ? x : y;     // el que queda sigue comparándose con el siguiente
    }
    if (retirar.length) {
      await Vacacion.updateMany({ _id: { $in: retirar } }, {
        $set: { estado: 'CANCELADO', comentarios: 'Retirada: se cruzaba con otro descanso de la misma persona registrado antes.' },
      });
      for (const id of afectados) {
        const emp = await Empleado.findById(id).populate('cargoActual', 'nombre rolPorDefecto');
        const boleta = emp && await Boleta.findOne({ empleado: emp._id, periodo: PERIODO_EN_CURSO, estado: 'CALCULADO' });
        if (!boleta) continue;
        Object.assign(boleta, await payrollEngine.computePayroll(emp, PERIODO_EN_CURSO), { estado: 'CALCULADO' });
        await boleta.save();
      }
      await sincronizarPlanilla(PERIODO_EN_CURSO, await Usuario.findOne({ rol: 'ANALISTA_NOMINAS', activo: true }).select('_id').lean());
    }
    anota('Estados', `${retirar.length} descanso(s) superpuesto(s) retirado(s); boleta del mes recalculada a ${afectados.size} persona(s)`);
    anota('Estados', `${gozadas.modifiedCount} vacaciones gozadas · ${enCurso.modifiedCount} en curso · ${vencidas.modifiedCount} solicitudes vencidas sin decisión · ${semanas.modifiedCount} cronogramas pasados publicados`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6.g · Vacaciones de años anteriores
  // ══════════════════════════════════════════════════════════════════════════
  // La carga inicial no traía historial vacacional: con la regla del D.L. 713
  // bien aplicada (leaveRules.periodoPendiente), 302 de 411 personas figuraban
  // con vacaciones vencidas y saldos de hasta 270 días. Cada período ya vencido
  // se registra como gozado dentro de su año, y siempre antes de 2026: desde
  // enero de 2026 hay boletas pagadas, y una vacación en esos meses las
  // contradiría. Unas pocas personas conservan su último período vencido a
  // propósito —de preferencia quien tiene una solicitud en trámite—, para que
  // la alerta de triple remuneración tenga qué mostrar.
  {
    const INICIO_BOLETAS = new Date(2026, 0, 1);
    const CON_RIESGO = 6;
    const sumarAnos = (f, n) => { const x = new Date(f); x.setFullYear(x.getFullYear() + n); return x; };
    const semillaDe = (id) => parseInt(String(id).slice(-6), 16);
    const correosDemo = [...CUENTAS_DEMO, ...Object.values(CUENTAS_FIJAS)].map((c) => `${c}@${DOMINIO}`);
    const deCuentaDemo = new Set((await Usuario.find({ correo: { $in: correosDemo } }).select('empleado').lean())
      .map((u) => String(u.empleado)));
    const gozado = new Map((await Vacacion.aggregate([
      { $match: { tipo: 'VACACIONES', estado: { $in: ['APROBADO', 'EN_CURSO', 'COMPLETADO'] } } },
      { $group: { _id: '$empleado', dias: { $sum: '$diasTotales' } } },
    ])).map((x) => [String(x._id), x.dias]));
    const enTramite = new Set((await Vacacion.find({ tipo: 'VACACIONES', estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] } })
      .select('empleado').lean()).map((v) => String(v.empleado)));

    const deudas = [];
    for (const e of await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
      .select('fechaIngreso localActual').lean()) {
      if (!e.fechaIngreso || e.fechaIngreso > HOY0) continue;
      const cubiertos = Math.floor((gozado.get(String(e._id)) || 0) / 30);
      // El primer período que todavía puede gozarse a tiempo
      let vigente = 1;
      while (sumarAnos(e.fechaIngreso, vigente + 1) <= HOY0) vigente++;
      if (vigente - 1 > cubiertos) deudas.push({ e, desde: cubiertos + 1, hasta: vigente - 1 });
    }
    // Quienes conservan su último período vencido: estables entre pasadas
    // (primero quien ya lo tiene en trámite), uno por centro de trabajo
    const centros = new Set();
    const conservan = new Set();
    for (const d of [...deudas].sort((a, b) => (enTramite.has(String(b.e._id)) - enTramite.has(String(a.e._id)))
      || (semillaDe(a.e._id) - semillaDe(b.e._id)))) {
      if (conservan.size >= CON_RIESGO) break;
      const centro = String(d.e.localActual);
      if (deCuentaDemo.has(String(d.e._id)) || centros.has(centro)) continue;
      centros.add(centro);
      conservan.add(String(d.e._id));
    }

    let historicas = 0;
    for (const { e, desde, hasta } of deudas) {
      const ultimo = conservan.has(String(e._id)) ? hasta - 1 : hasta;
      for (let p = desde; p <= ultimo; p++) {
        const abre = sumarAnos(e.fechaIngreso, p);
        const cierra = new Date(Math.min(sumarAnos(e.fechaIngreso, p + 1), INICIO_BOLETAS));
        const holgura = Math.floor((cierra - abre) / DIA) - 30;
        if (holgura < 0) continue;
        const inicio = new Date(abre.getTime() + ((semillaDe(e._id) + p * 37) % (holgura + 1)) * DIA);
        if (aplicar) {
          await Vacacion.create({
            empleado: e._id, tipo: 'VACACIONES', estado: 'COMPLETADO',
            fechaInicio: inicio, fechaFin: new Date(inicio.getTime() + 29 * DIA), diasTotales: 30,
            motivo: `Vacaciones del período ${p} (${abre.getFullYear()}–${abre.getFullYear() + 1})`,
            comentarios: 'Registro histórico migrado de las hojas de cálculo de RRHH',
          });
        }
        historicas++;
      }
    }
    anota('Vacaciones', `${historicas} períodos vencidos registrados como gozados (antes de 2026, sin tocar boletas) · `
      + `${conservan.size} persona(s) conservan un período vencido: riesgo de triple remuneración`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7 · Solicitudes de descanso en cada paso de la cadena
  // ══════════════════════════════════════════════════════════════════════════
  // Que cada bandeja tenga algo: el administrador de una botica ve lo que le toca
  // avalar, el jefe de zona lo avalado que le toca autorizar, RRHH lo de la sede.
  let solicitudes = 0;
  if (aplicar) {
    const candidatos = await Empleado.find({ estado: 'ACTIVO', fechaIngreso: { $lte: new Date(HOY0.getTime() - 400 * DIA) } })
      .populate('localActual', 'tipo codigo zona').lean();
    const porLocal = {};
    for (const e of candidatos) {
      const k = String(e.localActual?._id || 'sede');
      (porLocal[k] ||= []).push(e);
    }
    let i = 0;
    for (const lista of Object.values(porLocal)) {
      const elegido = lista[(i++) % lista.length];
      if (!elegido || await Vacacion.exists({ empleado: elegido._id, estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] } })) continue;
      const ctx = await apr.contextoDe(elegido._id);
      if (!ctx?.rol) continue;
      const cadena = apr.cadenaDe(ctx);
      const inicio = new Date(HOY0.getTime() + entre(18, 60) * DIA);
      const dias = uno([7, 7, 10, 15]);
      const avanzada = cadena.length > 1 && azar() < 0.35;
      const avalador = avanzada ? await Usuario.findOne({ rol: { $in: apr.PASOS.LOCAL.roles }, activo: true, empleado: { $in: (await Empleado.find({ localActual: ctx.localId, _id: { $ne: elegido._id } }).select('_id').lean()).map((x) => x._id) } }).lean() : null;
      await Vacacion.create({
        empleado: elegido._id, tipo: 'VACACIONES',
        fechaInicio: inicio, fechaFin: new Date(inicio.getTime() + (dias - 1) * DIA), diasTotales: dias,
        estado: avalador ? 'APROBADO_LOCAL' : 'PENDIENTE', cadena,
        aprobaciones: avalador ? [{ paso: 'LOCAL', usuario: avalador._id, decision: 'APROBADO', comentario: 'Cobertura confirmada con el equipo', fecha: new Date() }] : [],
        motivo: uno(['Viaje familiar', 'Descanso programado', 'Asuntos personales', 'Fiestas patronales en mi tierra']),
        solicitadoPor: (await Usuario.findOne({ empleado: elegido._id }).select('_id').lean())?._id,
      });
      solicitudes++;
    }
    // Las anteriores a la cadena la reciben calculada
    for (const v of await Vacacion.find({ estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] }, $or: [{ cadena: { $exists: false } }, { cadena: { $size: 0 } }] })) {
      const ctx = await apr.contextoDe(v.empleado);
      if (ctx) { v.cadena = apr.cadenaDe(ctx); await v.save(); }
    }
  }
  anota('Vacaciones', `${solicitudes} solicitudes repartidas por los pasos de la cadena de aprobación`);

  // ══════════════════════════════════════════════════════════════════════════
  // 7.b · Capacitación: la que la ley exige a todo el personal
  // ══════════════════════════════════════════════════════════════════════════
  // Había 53 registros para 382 personas. Lo mínimo que exige la ley:
  //   · Ley 29783, art. 49 g): capacitación en seguridad y salud al ingresar.
  //   · Ley 29783, art. 35 b): no menos de cuatro capacitaciones de SST al año.
  //   · Personal de farmacia: Buenas Prácticas de Dispensación; de almacén,
  //     de Almacenamiento; el QF, además, la actualización normativa DIGEMID.
  //     Son las dos que mide el cumplimiento de la Dirección Técnica, y
  //     vencen al año.
  const ANIO = HOY.getFullYear();
  const SST = [
    ['SST I · Identificación de peligros y evaluación de riesgos (IPERC)', new Date(ANIO, 2, 14)],
    ['SST II · Respuesta ante emergencias y sismos', new Date(ANIO, 5, 13)],
    ['SST III · Ergonomía y manipulación manual de cargas', new Date(ANIO, 8, 12)],
    ['SST IV · Primeros auxilios y uso de extintores', new Date(ANIO, 11, 12)],
  ];
  const RECUPERACION = new Date(ANIO, HOY.getMonth(), Math.min(28, HOY.getDate() + 14));
  const FARMACIA = ['QF', 'QF_ASISTENTE', 'TECNICO', 'TRAINEE'];
  const ALMACEN = ['AUX_ALMACEN', 'OPERARIO_CEDI', 'COORD_RUTAS', 'JEFE_CEDI'];
  const nota = () => entre(74, 99);
  let cursos = 0;
  {
    const personal = await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
      .select('_id fechaIngreso esPracticante').lean();
    const rolDe = new Map((await Usuario.find({ activo: true }).select('empleado rol').lean()).map((u) => [String(u.empleado), u.rol]));
    const tiene = new Map();
    for (const c of await Capacitacion.find({}).select('empleado nombre tipo estado').lean()) {
      const k = String(c.empleado);
      if (!tiene.has(k)) tiene.set(k, { nombres: new Set(), tipos: new Set() });
      tiene.get(k).nombres.add(c.nombre.replace(/ \(recuperación\)$/, ''));
      if (c.estado !== 'CANCELADA') tiene.get(k).tipos.add(c.tipo);
    }
    const lote = [];
    const curso = (empleado, datos) => {
      const completada = datos.estado === 'COMPLETADA';
      lote.push({
        empleado, ...datos,
        ...(completada ? {
          fechaCompletado: datos.fechaCompletado || datos.fechaProgramada, puntaje: nota(),
          numeroCertificado: `CERT-${ANIO}-${String(lote.length + 1).padStart(5, '0')}-${String(empleado).slice(-4).toUpperCase()}`,
        } : {}),
      });
    };
    for (const e of personal) {
      const ya = tiene.get(String(e._id)) || { nombres: new Set(), tipos: new Set() };
      const rol = rolDe.get(String(e._id));
      const ingreso = inicioDia(new Date(e.fechaIngreso));

      if (!ya.tipos.has('INDUCCION')) {
        const reciente = HOY0 - ingreso < 3 * DIA;
        curso(e._id, {
          nombre: 'Inducción corporativa y seguridad en el puesto', tipo: 'INDUCCION',
          proveedor: 'Escuela Corporativa InRetail', fechaProgramada: ingreso, horasDuracion: 16,
          estado: reciente ? 'EN_CURSO' : 'COMPLETADA', fechaCompletado: new Date(ingreso.getTime() + 2 * DIA),
          notas: 'Ley 29783, art. 49 g): capacitación en SST al momento de la contratación',
        });
      }
      for (const [nombre, fecha] of SST) {
        if (ya.nombres.has(nombre) || ingreso > fecha) continue;
        const pasada = fecha < HOY0;
        const falto = pasada && azar() < 0.03;
        curso(e._id, {
          nombre: falto ? `${nombre} (recuperación)` : nombre, tipo: 'SEGURIDAD',
          proveedor: 'Comité de Seguridad y Salud en el Trabajo', horasDuracion: 4,
          fechaProgramada: falto ? RECUPERACION : fecha,
          estado: pasada && !falto ? 'COMPLETADA' : 'PROGRAMADA',
          notas: falto ? 'No asistió a la sesión programada: reprogramada' : 'Ley 29783, art. 35 b): cuatro capacitaciones de SST al año',
        });
      }
      const farmacia = FARMACIA.includes(rol);
      if ((farmacia || ALMACEN.includes(rol)) && !ya.tipos.has('BPA')) {
        // Un 8 % la tiene vencida o por vencer: el reporte de cumplimiento
        // tiene que mostrar a quién hay que reprogramar
        const hace = azar() < 0.08 ? entre(340, 420) : entre(20, 300);
        const fecha = new Date(Math.max(ingreso.getTime() + 7 * DIA, HOY0.getTime() - hace * DIA));
        const completada = fecha < HOY0;
        curso(e._id, {
          nombre: farmacia ? 'Buenas Prácticas de Dispensación' : 'Buenas Prácticas de Almacenamiento', tipo: 'BPA',
          proveedor: farmacia ? 'Universidad Peruana Cayetano Heredia' : 'InRetail Academy',
          fechaProgramada: fecha, horasDuracion: 8, estado: completada ? 'COMPLETADA' : 'PROGRAMADA',
          venceEn: completada ? new Date(fecha.getTime() + 365 * DIA) : undefined,
        });
      }
      if (['QF', 'QF_ASISTENTE'].includes(rol) && !ya.tipos.has('DIGEMID')) {
        const hace = azar() < 0.08 ? entre(340, 420) : entre(20, 300);
        const fecha = new Date(Math.max(ingreso.getTime() + 7 * DIA, HOY0.getTime() - hace * DIA));
        const completada = fecha < HOY0;
        curso(e._id, {
          nombre: 'Actualización normativa DIGEMID ' + fecha.getFullYear(), tipo: 'DIGEMID',
          proveedor: 'Colegio Químico Farmacéutico del Perú', fechaProgramada: fecha, horasDuracion: 12,
          estado: completada ? 'COMPLETADA' : 'PROGRAMADA',
          venceEn: completada ? new Date(fecha.getTime() + 365 * DIA) : undefined,
        });
      }
      if (['ADMIN_BOTICA', 'JEFE_CEDI'].includes(rol) && !ya.tipos.has('LIDERAZGO')) {
        curso(e._id, {
          nombre: 'Liderazgo de equipos en punto de venta', tipo: 'LIDERAZGO',
          proveedor: 'Escuela Corporativa InRetail', fechaProgramada: new Date(ANIO, 10, 7), horasDuracion: 12,
          estado: 'PROGRAMADA',
        });
      }
    }
    cursos = lote.length;
    if (aplicar && lote.length) await Capacitacion.insertMany(lote, { ordered: false });
  }
  anota('Capacitación', `${cursos} registros: inducción, cuatro sesiones de SST al año, BPA/BPD y DIGEMID según el puesto`);

  // ══════════════════════════════════════════════════════════════════════════
  // 7.c · Evaluación de desempeño: el segundo trimestre cerrado, el tercero en curso
  // ══════════════════════════════════════════════════════════════════════════
  // Había 34 evaluaciones para cuatrocientas personas: «Mis evaluaciones»
  // salía vacía para casi todos y el Jefe de CEDI no tenía a quién evaluar.
  // El Q2 queda completo y firmado. El Q3 cerró el 30 de setiembre: parte está
  // en borrador del evaluador y parte enviada, esperando la firma.
  // Evalúa la jefatura directa: el Administrador a su botica (el QF director
  // técnico donde no hay Administrador), el Jefe de Zona a los
  // administradores, el Jefe de CEDI a su centro y la Gerencia de RRHH a la
  // sede y a las jefaturas zonales. Visa la jefatura del evaluador.
  const KPIS = {
    FARMACIA: [['Recetas dispensadas sin observación', 98, '%', 35], ['Buenas Prácticas de Dispensación (auditoría)', 100, '%', 30], ['Puntualidad', 100, '%', 15], ['Satisfacción del cliente (NPS)', 70, 'pts', 20]],
    CAJA: [['Cuadre de caja sin diferencias', 100, '%', 40], ['Puntualidad', 100, '%', 20], ['Satisfacción del cliente (NPS)', 70, 'pts', 25], ['Venta de productos sugeridos', 100, '%', 15]],
    JEFATURA: [['Cumplimiento de la venta', 100, '%', 35], ['Turnos cubiertos según formato', 100, '%', 25], ['Auditoría de calidad', 90, 'pts', 25], ['Retención del equipo', 90, '%', 15]],
    CEDI: [['Pedidos despachados a tiempo', 98, '%', 35], ['Exactitud del picking', 99.5, '%', 35], ['Puntualidad', 100, '%', 15], ['Cumplimiento de normas de SST', 100, '%', 15]],
    GENERAL: [['Cumplimiento de objetivos del puesto', 100, '%', 50], ['Puntualidad', 100, '%', 20], ['Calidad del trabajo', 5, 'pts', 30]],
  };
  const GRUPO = { QF: 'FARMACIA', QF_ASISTENTE: 'FARMACIA', TECNICO: 'FARMACIA', TRAINEE: 'FARMACIA', CAJERO: 'CAJA', DERMOCONSULTOR: 'CAJA',
    ADMIN_BOTICA: 'JEFATURA', JEFE_CEDI: 'JEFATURA', OPERARIO_CEDI: 'CEDI', COORD_RUTAS: 'CEDI', AUX_ALMACEN: 'CEDI' };
  const FORTALEZAS = ['Trato cordial con los pacientes', 'Dominio del sistema de ventas', 'Apoya al equipo en horas punta', 'Ordenado con el inventario', 'Cumple los protocolos de dispensación', 'Iniciativa para resolver problemas', 'Puntual y comprometido'];
  const MEJORAS = ['Reducir diferencias en el cuadre de caja', 'Reforzar la venta sugerida', 'Mejorar la puntualidad en el turno tarde', 'Completar la capacitación pendiente', 'Registrar a tiempo las incidencias', 'Delegar más en el equipo'];
  let evaluacionesNuevas = 0;
  if (aplicar) {
    const anio = HOY.getFullYear();
    const PERIODOS = [
      { nombre: `${anio}-Q2`, fechaInicio: new Date(anio, 3, 1), fechaFin: new Date(anio, 5, 30), enCurso: false },
      { nombre: `${anio}-Q3`, fechaInicio: new Date(anio, 6, 1), fechaFin: new Date(anio, 8, 30), enCurso: true },
    ];
    const cuentaDe = new Map((await Usuario.find({ activo: true }).select('empleado rol').lean()).map((u) => [String(u.empleado), u]));
    const gerente = await Empleado.findOne({ cargoActual: cargos.GRH?._id, estado: 'ACTIVO' }).select('_id').lean();
    const direccion = (await Usuario.findOne({ correo: `admin@${DOMINIO}` }).select('empleado').lean())?.empleado;
    const zonas = new Map((await Zona.find().select('responsable').lean()).map((z) => [String(z._id), z.responsable]));
    const centros = new Map((await Local.find().select('tipo zona directorTecnico').lean()).map((l) => [String(l._id), l]));
    const jefeDe = new Map();      // local -> administrador / jefe de CEDI
    for (const e of await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] }, cargoActual: { $in: [cargos.ADB?._id, cargos.JCD?._id].filter(Boolean) } }).sort({ fechaIngreso: 1 }).select('_id localActual').lean()) {
      if (!jefeDe.has(String(e.localActual))) jefeDe.set(String(e.localActual), e._id);
    }
    /** Jefatura directa; null si no hay a quién atribuirla */
    function evaluadorDe(e, rol) {
      const local = centros.get(String(e.localActual));
      if (rol === 'GERENTE_RRHH') return direccion;
      if (['JEFE_ZONA', 'ADMIN'].includes(rol) || !local || local.tipo === 'SEDE_CORPORATIVA') return gerente?._id;
      if (rol === 'ADMIN_BOTICA') return zonas.get(String(local.zona)) || gerente?._id;
      if (rol === 'JEFE_CEDI') return gerente?._id;
      const jefe = jefeDe.get(String(e.localActual));
      if (jefe && String(jefe) !== String(e._id)) return jefe;
      if (local.directorTecnico && String(local.directorTecnico) !== String(e._id)) return local.directorTecnico;
      return zonas.get(String(local.zona)) || null;
    }
    const yaTiene = new Set((await Evaluacion.find({}).select('empleado periodo.nombre').lean()).map((v) => `${v.empleado}|${v.periodo?.nombre}`));
    const personal = await Empleado.find({ estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } }).sort({ dni: 1 }).select('_id localActual zona fechaIngreso').lean();
    // Las cuentas de demostración de piso tienen su evaluación del Q3 esperando firma
    const pendienteFirma = new Set((await Usuario.find({ correo: { $in: ['tecnico', 'cajero', 'qf.asistente', 'operario.cedi', 'trainee'].map((c) => `${c}@${DOMINIO}`) } }).select('empleado').lean()).map((u) => String(u.empleado)));
    for (const periodo of PERIODOS) {
      for (const e of personal) {
        if (yaTiene.has(`${e._id}|${periodo.nombre}`)) continue;
        // Se evalúa a quien trabajó al menos dos meses del trimestre
        if (new Date(e.fechaIngreso) > new Date(periodo.fechaFin.getTime() - 60 * DIA)) continue;
        const cuenta = cuentaDe.get(String(e._id));
        const rol = cuenta?.rol;
        if (!rol || rol === 'ADMIN') continue;
        const evaluador = evaluadorDe(e, rol);
        if (!evaluador || String(evaluador) === String(e._id)) continue;
        // En el Q3, una parte aún no se registra: es la tarea pendiente de cada
        // jefatura. Quién queda pendiente sale de la persona y no del azar, para
        // que una segunda pasada no registre lo que la primera dejó pendiente
        const r = periodo.enCurso ? (parseInt(String(e._id).slice(-6), 16) % 1000) / 1000 : azar();
        let estado;
        if (!periodo.enCurso) estado = r < 0.9 ? 'FIRMADO' : 'REVISADO';
        else if (pendienteFirma.has(String(e._id))) estado = 'ENVIADO';
        else if (r < 0.35) continue;
        else estado = r < 0.6 ? 'BORRADOR' : r < 0.9 ? 'ENVIADO' : 'REVISADO';
        const cierre = periodo.fechaFin;
        const enviadoEn = estado === 'BORRADOR' ? undefined : new Date(Math.min(HOY - DIA, cierre.getTime() + entre(1, 18) * DIA));
        const revisadoEn = ['REVISADO', 'FIRMADO'].includes(estado) ? new Date(Math.min(HOY - 3600000, enviadoEn.getTime() + entre(1, 6) * DIA)) : undefined;
        const firmadoEn = estado === 'FIRMADO' ? new Date(revisadoEn.getTime() + entre(1, 8) * DIA) : undefined;
        const nivel = azar();             // desempeño de la persona en el trimestre
        const kpis = KPIS[GRUPO[rol] || 'GENERAL'].map(([nombre, meta, unidad, peso]) => {
          const factor = nivel < 0.1 ? 0.7 + azar() * 0.15 : nivel < 0.75 ? 0.88 + azar() * 0.12 : 0.97 + azar() * 0.08;
          return { nombre, meta, unidad, peso, real: redondear(Math.min(meta * factor, unidad === '%' ? 100 : meta * 1.2)) };
        });
        const evaluadorUsuario = cuentaDe.get(String(evaluador))?._id;
        await Evaluacion.create({
          empleado: e._id, evaluador, periodo: { nombre: periodo.nombre, fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
          kpis, estado,
          fortalezas: uno(FORTALEZAS), areasDeMejora: uno(MEJORAS),
          enviadoEn, enviadoPor: enviadoEn ? evaluadorUsuario : undefined,
          revisadoEn, revisadoPor: revisadoEn ? (rrhh?._id) : undefined,
          firmadoPorEmpleado: estado === 'FIRMADO', firmadoEn,
          empleadoConforme: estado === 'FIRMADO' ? azar() > 0.06 : true,
          comentarioEmpleado: estado === 'FIRMADO' && azar() < 0.15 ? 'Conforme. Solicito capacitación en el punto de mejora.' : undefined,
        });
        evaluacionesNuevas++;
      }
    }
  }
  anota('Evaluación', `${evaluacionesNuevas} evaluaciones: el Q2 completo y firmado, el Q3 entre borradores y envíos esperando firma`);

  // 7.d  El CEDI pide el reemplazo de su operario cesado: el Jefe de CEDI
  //      tenía la pantalla de requerimientos vacía
  if (aplicar) {
    const cedi = await Local.findOne({ tipo: 'CEDI', activo: true }).lean();
    const jefeCedi = await Usuario.findOne({ rol: 'JEFE_CEDI', activo: true }).select('_id').lean();
    if (cedi && jefeCedi && cargos.OPK && !(await Requerimiento.exists({ local: cedi._id }))) {
      const cesado = await Empleado.findOne({ localActual: cedi._id, cargoActual: cargos.OPK._id, estado: 'CESADO' }).select('_id nombres apellidos').lean();
      await Requerimiento.create({
        cargo: cargos.OPK._id, local: cedi._id, zona: cedi.zona, cantidad: 1, turno: 'ROTATIVO',
        motivo: cesado ? 'REEMPLAZO' : 'TEMPORADA_ALTA', reemplazaA: cesado?._id,
        justificacion: cesado
          ? `Reemplazo de ${cesado.nombres} ${cesado.apellidos} (cesado). La línea de picking del turno tarde opera con un operario menos.`
          : 'Campaña de fin de año: el volumen de pedidos sube 30 % desde noviembre.',
        urgencia: 'ALTA', requeridoPara: new Date(HOY0.getTime() + 21 * DIA),
        solicitadoPor: jefeCedi._id, estado: 'SOLICITADO',
      });
      anota('Selección', 'El CEDI solicita el reemplazo de su operario cesado (requerimiento en espera de aprobación)');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8 · Terminales de marcación
  // ══════════════════════════════════════════════════════════════════════════
  // En demostración la clave se deriva del secreto del servidor: es la misma en
  // cada ejecución (la lista no caduca) y no se adivina sin ese secreto.
  const filasTerminal = [];
  for (const local of await Local.find({ activo: true }).select('+terminal.claveHash')) {
    const clave = crypto.createHmac('sha256', process.env.JWT_SECRET || 'pharmatalent')
      .update(`terminal:${local.codigo}`).digest('base64url').slice(0, 16);
    filasTerminal.push([local.codigo, local.nombre, clave]);
    if (aplicar && (!local.terminal?.activo || local.terminal.claveHash !== hashClave(clave))) {
      await Local.updateOne({ _id: local._id }, { terminal: { claveHash: hashClave(clave), activo: true, altaEn: new Date() } });
    }
  }
  anota('Terminales', `${filasTerminal.length} centros de trabajo con su terminal de marcación registrado`);

  // ══════════════════════════════════════════════════════════════════════════
  // 9 · Listados para la exposición (fuera de git: ver .gitignore)
  // ══════════════════════════════════════════════════════════════════════════
  // Una base de pruebas no reescribe los listados de la exposición
  if (aplicar && !/pruebas/.test(mongoose.connection.name)) {
    const csv = (filas) => filas.map((f) => f.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const cuentas = await Usuario.find({ activo: true }).populate({
      path: 'empleado', select: 'nombres apellidos localActual zona cargoActual',
      populate: [{ path: 'localActual', select: 'nombre' }, { path: 'zona', select: 'nombre' }, { path: 'cargoActual', select: 'nombre' }],
    }).lean();
    const filas = cuentas.map((u) => [
      u.correo, demo ? CLAVE_DEMO : '(temporal: ver credenciales-iniciales.csv)',
      ROLES[u.rol]?.etiqueta || u.rol, u.empleado ? `${u.empleado.apellidos}, ${u.empleado.nombres}` : '',
      u.empleado?.cargoActual?.nombre || '', u.empleado?.localActual?.nombre || '', u.empleado?.zona?.nombre || '',
    ]).sort((a, b) => (a[6] + a[5] + a[2]).localeCompare(b[6] + b[5] + b[2]));
    fs.writeFileSync(path.join(__dirname, '..', 'credenciales-demo.csv'),
      '﻿' + csv([['Correo', 'Contraseña', 'Rol', 'Persona', 'Cargo', 'Centro de trabajo', 'Zona'], ...filas]), 'utf8');
    fs.writeFileSync(path.join(__dirname, '..', 'terminales-demo.csv'),
      '﻿' + csv([['Código del local', 'Local', 'Clave del terminal'], ...filasTerminal]), 'utf8');
    anota('Listados', `credenciales-demo.csv (${filas.length} cuentas) y terminales-demo.csv`);
  }

  console.log('');
  for (const [s, d] of informe) console.log(`  ${s.padEnd(12)} ${d}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
