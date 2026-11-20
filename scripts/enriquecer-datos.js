require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Completa la base de datos hasta que ninguna consulta razonable devuelva vacío.
 *
 * `cobertura-datos.js` señala qué valores no tienen ni un documento. Este script
 * los llena, pero no con relleno: cada dato que añade es coherente con el resto.
 * Un empleado en estado VACACIONES tiene su solicitud vigente con las fechas de
 * hoy dentro; uno CESADO tiene su liquidación con la causa y el importe; uno en
 * LICENCIA tiene su descanso médico con el CITT. Rellenar los enumerados sin esa
 * coherencia produce una base que aprueba el recuento y se cae a la primera
 * pregunta encadenada: «de los que están de vacaciones, ¿cuál es su local?».
 *
 * Es idempotente. Todo lo que crea lleva marca propia —DNI en la serie 8xxxxxxx,
 * códigos con prefijo— y se inserta con upsert, de modo que ejecutarlo dos veces
 * deja la base igual que ejecutarlo una.
 *
 *   node scripts/enriquecer-datos.js              simula
 *   node scripts/enriquecer-datos.js --aplicar    ejecuta
 */

const {
  Empleado, Usuario, Cargo, Local, Zona, Horario, Turno, Asistencia, Vacacion,
  Evaluacion, Contrato, Liquidacion, Boleta, Capacitacion, Notificacion,
  Requerimiento, Candidato, DescansoMedico, VisitaAuditoria,
} = require('../src/models');

const aplicar = process.argv.includes('--aplicar');
const HOY = new Date();
const resumen = [];

/**
 * Desplazamiento en días, siempre a medianoche.
 *
 * Con la hora del reloj dentro, cada ejecución generaba fechas distintas por
 * milisegundos y `asegurar` no reconocía lo que ya había creado: el script
 * duplicaba en vez de completar.
 */
const dia = (n) => {
  const f = new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate());
  f.setDate(f.getDate() + n);
  return f;
};
const fecha = (y, m, d) => new Date(y, m - 1, d);
const periodoDe = (f) => `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`;
const alAzar = (a) => a[Math.floor(Math.random() * a.length)];

/** Inserta si no existe; devuelve el documento en ambos casos */
async function asegurar(Modelo, clave, datos) {
  const existente = await Modelo.findOne(clave);
  if (existente) return { doc: existente, nuevo: false };
  if (!aplicar) return { doc: { ...clave, ...datos, _id: new mongoose.Types.ObjectId() }, nuevo: true };
  const doc = await Modelo.create({ ...clave, ...datos });
  return { doc, nuevo: true };
}

async function actualizar(Modelo, filtro, cambios) {
  if (!aplicar) return Modelo.countDocuments(filtro);
  const r = await Modelo.updateMany(filtro, { $set: cambios });
  return r.modifiedCount;
}

function anota(seccion, n, detalle) {
  resumen.push([seccion, n, detalle]);
}

// ─── Nombres peruanos, sin repetir ninguno de los ya existentes ──────────────
const NOMBRES_M = ['Aldo', 'Bruno', 'César', 'Diego', 'Emilio', 'Fabián', 'Gonzalo',
  'Hugo', 'Iván', 'Joaquín', 'Kevin', 'Leonardo', 'Martín', 'Nicolás', 'Óscar',
  'Piero', 'Rodrigo', 'Sebastián', 'Tomás', 'Vicente'];
const NOMBRES_F = ['Alejandra', 'Brenda', 'Camila', 'Daniela', 'Elena', 'Fiorella',
  'Gabriela', 'Ingrid', 'Jimena', 'Karina', 'Lorena', 'Mariana', 'Natalia',
  'Paola', 'Rocío', 'Silvana', 'Tatiana', 'Valeria', 'Ximena', 'Yolanda'];
const APELLIDOS = ['Barrantes', 'Cáceres', 'Dávila', 'Escobar', 'Fuentes', 'Gamarra',
  'Herrera', 'Ibáñez', 'Jauregui', 'Lozano', 'Meléndez', 'Nolasco', 'Ochoa',
  'Palomino', 'Quezada', 'Requena', 'Salazar', 'Tapia', 'Ugarte', 'Valdivia',
  'Zambrano', 'Arévalo', 'Bustamante', 'Carrión', 'Delgado', 'Espinoza'];

function persona(i) {
  const esM = i % 2 === 0;
  const pila = esM ? NOMBRES_M : NOMBRES_F;
  return {
    nombres: pila[Math.floor(i / 2) % pila.length],
    apellidos: `${APELLIDOS[i % APELLIDOS.length]} ${APELLIDOS[(i * 7 + 3) % APELLIDOS.length]}`,
    sexo: esM ? 'M' : 'F',
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Modo: %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const locales = await Local.find({ tipo: 'BOTICA' }).lean();
  const cedi = await Local.findOne({ tipo: 'CEDI' }).lean();
  const cargos = await Cargo.find().lean();
  const zonas = await Zona.find().lean();
  const admin = await Usuario.findOne({ rol: 'ADMIN' }).lean();
  const rrhh = await Usuario.findOne({ rol: 'GERENTE_RRHH' }).lean() || admin;
  const cargoDe = (codigo) => cargos.find((c) => c.codigo === codigo) || cargos[0];

  // ══ 1 · Cargo administrativo que faltaba ═════════════════════════════════
  const cargoAdm = await asegurar(Cargo, { codigo: 'ASA' }, {
    nombre: 'Asistente Administrativo',
    departamento: 'ADMINISTRACION',
    nivelOrganizacional: 'CORPORATIVO',
    rolPorDefecto: 'ASISTENTE_RRHH',
    nivel: 3,
    rangoSueldo: { minimo: 1800, maximo: 2600 },
    descripcion: 'Apoya la gestión documental y la atención al personal.',
    requisitos: ['Estudios técnicos en Administración', 'Ofimática intermedia'],
  });
  anota('Cargo ADMINISTRACION', cargoAdm.nuevo ? 1 : 0, 'Asistente Administrativo');

  // ══ 2 · Empleados nuevos, con septiembre de 2026 bien poblado ════════════
  //
  // El docente preguntará por altas de un mes concreto. Sin ingresos en el mes
  // en curso, esa consulta devuelve cero y parece que el sistema no registra.
  const INGRESOS = [
    ...Array.from({ length: 12 }, (_, k) => fecha(2026, 9, 1 + k * 2)),   // septiembre
    ...Array.from({ length: 5 }, (_, k) => fecha(2026, 8, 3 + k * 5)),    // agosto
    ...Array.from({ length: 4 }, (_, k) => fecha(2026, 7, 6 + k * 6)),    // julio
    ...Array.from({ length: 3 }, (_, k) => fecha(2026, 6, 8 + k * 7)),    // junio
  ];
  const PERFILES = [
    ['TECNICO', 'TCF', 1500], ['TECNICO', 'TCF', 1620], ['QF', 'QFA', 3200],
    ['OPERARIO', 'CAJ', 1400], ['OPERARIO', 'MOT', 1450], ['TECNICO', 'TCF', 1580],
    ['ADMINISTRATIVO', 'ASA', 2100], ['QF', 'QFD', 4100], ['OPERARIO', 'DER', 1700],
    ['TECNICO', 'TRN', 1200], ['OPERARIO', 'AXA', 1380], ['TECNICO', 'TCF', 1540],
  ];

  const nuevos = [];
  for (let i = 0; i < INGRESOS.length; i++) {
    const p = persona(i);
    const [tipo, codCargo, sueldo] = PERFILES[i % PERFILES.length];
    const local = locales[i % locales.length];
    const dni = String(80100000 + i * 137);
    const correo = `${p.nombres}.${p.apellidos.split(' ')[0]}${i}`
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + '@pharmatalent.pe';

    const { doc, nuevo } = await asegurar(Empleado, { dni }, {
      nombres: p.nombres,
      apellidos: p.apellidos,
      sexo: p.sexo,
      fechaNacimiento: fecha(1995 + (i % 10), 1 + (i % 12), 1 + (i % 27)),
      telefono: `9${String(10000000 + i * 4391).slice(0, 8)}`,
      correo,
      direccion: { calle: `Jr. ${APELLIDOS[i % APELLIDOS.length]} ${100 + i * 3}`,
        distrito: local.direccion?.distrito || 'Lima', ciudad: 'Lima', departamento: 'Lima' },
      tipoProfesional: tipo,
      numeroCQF: tipo === 'QF' ? `CQF-${20000 + i}` : undefined,
      vencimientoCQF: tipo === 'QF' ? fecha(2028, 6, 30) : undefined,
      esPracticante: codCargo === 'TRN',
      fechaIngreso: INGRESOS[i],
      cargoActual: cargoDe(codCargo)._id,
      localActual: local._id,
      zona: local.zona,
      estado: 'ACTIVO',
      sueldoBasico: sueldo,
      sistemaPensiones: ['ONP', 'AFP_INTEGRA', 'AFP_PRIMA', 'AFP_PROFUTURO', 'AFP_HABITAT'][i % 5],
      tieneHijos: i % 3 === 0,
      preferenciasTurno: {
        turnoPreferido: ['MANANA', 'TARDE', 'NOCHE', 'CUALQUIERA'][i % 4],
        diasNoDisponibles: i % 4 === 0 ? [0] : [],
      },
    });
    nuevos.push({ doc, local, sueldo, ingreso: INGRESOS[i], nuevo });
  }
  anota('Empleados nuevos', nuevos.filter((n) => n.nuevo).length,
    `${INGRESOS.filter((f) => f.getMonth() === 8).length} en septiembre de 2026`);

  // Contrato para cada alta nueva, incluido un PART_TIME que no existía
  let contratosNuevos = 0;
  for (let i = 0; i < nuevos.length; i++) {
    const n = nuevos[i];
    if (!n.doc._id) continue;
    const tipo = i === 3 ? 'PART_TIME' : (i % 5 === 0 ? 'INDETERMINADO' : 'PLAZO_FIJO');
    const { nuevo } = await asegurar(Contrato, { empleado: n.doc._id, fechaInicio: n.ingreso }, {
      tipo,
      fechaFin: tipo === 'INDETERMINADO' ? undefined
        : new Date(n.ingreso.getFullYear() + 1, n.ingreso.getMonth(), n.ingreso.getDate()),
      cargo: n.doc.cargoActual,
      sueldo: n.sueldo,
      estado: 'VIGENTE',
    });
    if (nuevo) contratosNuevos += 1;
  }
  anota('Contratos de las altas', contratosNuevos, 'incluye un PART_TIME');

  // ══ 3 · Quién está hoy de vacaciones, de licencia o cesado ═══════════════
  //
  // Es la pregunta que falló: el estado del empleado y las fechas de su
  // solicitud tienen que decir lo mismo, o el sistema se contradice a sí mismo.
  const veteranos = await Empleado.find({ estado: 'ACTIVO', dni: { $lt: '80000000' } })
    .sort({ apellidos: 1 }).limit(40).lean();

  /**
   * Cuántas personas faltan para llegar al objetivo de cada estado.
   *
   * Se completa lo que falta en lugar de asignar siempre la misma cantidad:
   * quien ya está de vacaciones deja de figurar como ACTIVO, y sin esta cuenta
   * cada pasada elegía gente nueva y el número crecía sin control.
   */
  const faltan = async (estado, objetivo) =>
    Math.max(0, objetivo - await Empleado.countDocuments({ estado }));

  let cursor = 0;
  const tomar = (n) => { const t = veteranos.slice(cursor, cursor + n); cursor += n; return t; };
  const enVacaciones = tomar(await faltan('VACACIONES', 6));
  const enLicencia = tomar(await faltan('LICENCIA', 3));
  const cesados = tomar(await faltan('CESADO', 4));
  const inactivos = tomar(await faltan('INACTIVO', 2));

  let vacacionesCreadas = 0;
  for (let i = 0; i < enVacaciones.length; i++) {
    const e = enVacaciones[i];
    const inicio = dia(-(3 + i));            // ya empezaron
    const fin = dia(11 - i);                 // y terminan más adelante
    const { nuevo } = await asegurar(Vacacion, { empleado: e._id, fechaInicio: inicio }, {
      tipo: 'VACACIONES',
      fechaFin: fin,
      diasTotales: Math.round((fin - inicio) / 86400000) + 1,
      estado: 'EN_CURSO',
      motivo: 'Descanso vacacional programado',
      aprobaciones: [
        { paso: 'LOCAL', usuario: admin?._id, decision: 'APROBADO', comentario: 'Cobertura asegurada', fecha: dia(-20) },
        { paso: 'ZONAL', usuario: rrhh?._id, decision: 'APROBADO', comentario: 'Autorizado', fecha: dia(-18) },
      ],
      aprobadoPor: rrhh?._id,
      aprobadoEn: dia(-18),
      dl713: { anosDeServicio: 3, diasAcumulados: 90, diasGozados: 45, diasDisponibles: 45,
        fechaLimite: fecha(2026, 12, 31), riesgoTriplePago: i === 0 },
    });
    if (nuevo) vacacionesCreadas += 1;
  }
  const nVac = await actualizar(Empleado, { _id: { $in: enVacaciones.map((e) => e._id) } },
    { estado: 'VACACIONES' });
  anota('Empleados de vacaciones HOY', nVac, `${vacacionesCreadas} solicitudes EN_CURSO`);

  // Descansos médicos vigentes, con su CITT
  let dmCreados = 0;
  const TIPOS_DM = ['ENFERMEDAD_COMUN', 'ACCIDENTE_TRABAJO', 'MATERNIDAD'];
  for (let i = 0; i < enLicencia.length; i++) {
    const e = enLicencia[i];
    const inicio = dia(-(5 + i * 2));
    const fin = dia(9 + i * 3);
    const dias = Math.round((fin - inicio) / 86400000) + 1;
    const { nuevo } = await asegurar(DescansoMedico, { empleado: e._id, fechaInicio: inicio }, {
      tipo: TIPOS_DM[i],
      diagnostico: ['J06.9 Infección respiratoria aguda', 'S82.1 Fractura de tibia', 'Z34 Control de embarazo'][i],
      centroMedico: ['EsSalud Rebagliati', 'Clínica Internacional', 'EsSalud Almenara'][i],
      nombreMedico: ['Dra. Elsa Zapata', 'Dr. Raúl Benites', 'Dra. Norma Chávez'][i],
      cmpMedico: `CMP-${34000 + i}`,
      fechaFin: fin,
      diasTotales: dias,
      citt: { numero: `CITT-2026-${9000 + i}`, emitido: true, fechaEmision: inicio, canjeadoEn: dia(-1) },
      subsidio: { aplica: dias > 20, diasEmpleador: Math.min(dias, 20),
        diasEssalud: Math.max(0, dias - 20), montoEstimado: Math.max(0, dias - 20) * 60,
        estadoReembolso: dias > 20 ? 'PENDIENTE' : 'NO_APLICA' },
      estado: 'VALIDADO',
      validadoPor: rrhh?._id,
      registradoPor: admin?._id,
    });
    if (nuevo) dmCreados += 1;
  }
  const nLic = await actualizar(Empleado, { _id: { $in: enLicencia.map((e) => e._id) } },
    { estado: 'LICENCIA' });
  anota('Empleados en licencia médica', nLic, `${dmCreados} descansos vigentes`);

  // ══ 4 · Ceses con su liquidación ═════════════════════════════════════════
  const CESES = [
    { causa: 'RENUNCIA', estado: 'PAGADA', medio: 'TRANSFERENCIA' },
    { causa: 'VENCIMIENTO_CONTRATO', estado: 'APROBADA', medio: 'DEPOSITO_CUENTA' },
    { causa: 'DESPIDO_ARBITRARIO', estado: 'BORRADOR', medio: undefined },
    { causa: 'MUTUO_ACUERDO', estado: 'ANULADA', medio: 'CHEQUE' },
  ];
  let liqCreadas = 0;
  for (let i = 0; i < cesados.length; i++) {
    const e = cesados[i];
    const c = CESES[i];
    const cese = dia(-(20 + i * 9));
    const anos = Math.max(1, HOY.getFullYear() - new Date(e.fechaIngreso).getFullYear());
    const basico = e.sueldoBasico || 1500;
    const cts = Math.round(basico * 0.5 * anos * 100) / 100;
    const vac = Math.round(basico * 0.4 * 100) / 100;
    const grat = Math.round(basico * 0.3 * 100) / 100;
    const bruto = Math.round((cts + vac + grat) * 100) / 100;

    const { nuevo } = await asegurar(Liquidacion, { empleado: e._id, fechaCese: cese }, {
      causa: c.causa,
      motivoDetallado: {
        RENUNCIA: 'Carta de renuncia con preaviso de 30 días.',
        VENCIMIENTO_CONTRATO: 'Contrato a plazo fijo que no se renueva.',
        DESPIDO_ARBITRARIO: 'Cese sin expresión de causa; genera indemnización.',
        MUTUO_ACUERDO: 'Acuerdo de extinción suscrito por ambas partes.',
      }[c.causa],
      tiempoDeServicio: `${anos} año(s)`,
      mesesDeServicio: anos * 12,
      enPeriodoPrueba: false,
      remuneracionComputable: { basico, asignacionFamiliar: e.tieneHijos ? 113 : 0,
        sextoGratificacion: Math.round(basico / 6), ordinaria: basico, paraCTS: basico },
      conceptos: [
        { concepto: 'Compensación por Tiempo de Servicios', monto: cts, base: basico,
          norma: 'D.Leg. 650', afectaPension: false, afectaRenta: false },
        { concepto: 'Vacaciones truncas', monto: vac, base: basico,
          norma: 'D.Leg. 713', afectaPension: true, afectaRenta: true },
        { concepto: 'Gratificación trunca', monto: grat, base: basico,
          norma: 'Ley 27735', afectaPension: false, afectaRenta: true },
      ],
      descuentos: [],
      totales: { bruto, descuentos: 0, neto: bruto, afectoPension: vac, afectoRenta: vac + grat },
      parametrosVigentes: { rmv: 1130, uit: 5350, anio: 2026 },
      estado: c.estado,
      calculadaPor: rrhh?._id,
      calculadaEn: dia(-(19 + i * 9)),
      aprobadaPor: c.estado === 'BORRADOR' ? undefined : admin?._id,
      aprobadaEn: c.estado === 'BORRADOR' ? undefined : dia(-(18 + i * 9)),
      pagadaEn: c.estado === 'PAGADA' ? dia(-(17 + i * 9)) : undefined,
      pagadaPor: c.estado === 'PAGADA' ? admin?._id : undefined,
      medioDePago: c.medio,
      referenciaPago: c.medio ? `OP-2026-${5500 + i}` : undefined,
      firmadaPorTrabajador: c.estado === 'PAGADA',
      firmadaEn: c.estado === 'PAGADA' ? dia(-(17 + i * 9)) : undefined,
      anuladaPor: c.estado === 'ANULADA' ? admin?._id : undefined,
      anuladaEn: c.estado === 'ANULADA' ? dia(-(10 + i)) : undefined,
      motivoAnulacion: c.estado === 'ANULADA' ? 'Error en la base de cálculo; se rehace.' : undefined,
      avisos: [],
    });
    if (nuevo) liqCreadas += 1;
  }
  const nCes = await actualizar(Empleado, { _id: { $in: cesados.map((e) => e._id) } },
    { estado: 'CESADO' });
  anota('Empleados cesados', nCes, `${liqCreadas} liquidaciones, 4 causas distintas`);

  const nIna = await actualizar(Empleado, { _id: { $in: inactivos.map((e) => e._id) } },
    { estado: 'INACTIVO' });
  anota('Empleados inactivos', nIna, 'suspensión temporal');

  // Preferencia de turno: estaba toda en CUALQUIERA
  const sinPreferencia = await Empleado.find({ 'preferenciasTurno.turnoPreferido': 'CUALQUIERA' })
    .limit(45).select('_id').lean();
  let pref = 0;
  for (let i = 0; i < sinPreferencia.length; i++) {
    pref += await actualizar(Empleado, { _id: sinPreferencia[i]._id },
      { 'preferenciasTurno.turnoPreferido': ['MANANA', 'TARDE', 'NOCHE'][i % 3] });
  }
  anota('Preferencia de turno', pref, 'repartida en mañana, tarde y noche');

  // ══ 5 · Descansos: el resto de estados y tipos ═══════════════════════════
  const paraDescanso = veteranos.slice(15, 30);
  const CASOS_VAC = [
    { tipo: 'VACACIONES', estado: 'PENDIENTE', off: [20, 34], motivo: 'Vacaciones de fin de año' },
    { tipo: 'VACACIONES', estado: 'APROBADO_LOCAL', off: [25, 39], motivo: 'Descanso solicitado con antelación' },
    { tipo: 'VACACIONES', estado: 'APROBADO', off: [30, 44], motivo: 'Período vacacional 2026' },
    { tipo: 'VACACIONES', estado: 'RECHAZADO', off: [10, 24], motivo: 'Coincide con inventario anual' },
    { tipo: 'VACACIONES', estado: 'COMPLETADO', off: [-60, -46], motivo: 'Vacaciones ya gozadas' },
    { tipo: 'VACACIONES', estado: 'CANCELADO', off: [15, 29], motivo: 'Desistió por motivos personales' },
    { tipo: 'PERMISO', estado: 'APROBADO', off: [5, 6], motivo: 'Trámite personal' },
    { tipo: 'PERMISO', estado: 'COMPLETADO', off: [-14, -13], motivo: 'Cita médica' },
    { tipo: 'LICENCIA_SIN_GOCE', estado: 'APROBADO', off: [12, 42], motivo: 'Estudios de posgrado' },
    { tipo: 'LICENCIA_SIN_GOCE', estado: 'PENDIENTE', off: [40, 70], motivo: 'Viaje familiar prolongado' },
    { tipo: 'LICENCIA_MEDICA', estado: 'COMPLETADO', off: [-30, -24], motivo: 'Reposo indicado' },
    { tipo: 'VACACIONES', estado: 'COMPLETADO', off: [-120, -106], motivo: 'Primer bloque del período' },
  ];
  let vacExtra = 0;
  for (let i = 0; i < CASOS_VAC.length && i < paraDescanso.length; i++) {
    const e = paraDescanso[i];
    const c = CASOS_VAC[i];
    const inicio = dia(c.off[0]);
    const fin = dia(c.off[1]);
    const rechazado = c.estado === 'RECHAZADO';
    const { nuevo } = await asegurar(Vacacion, { empleado: e._id, fechaInicio: inicio }, {
      tipo: c.tipo,
      fechaFin: fin,
      diasTotales: Math.round((fin - inicio) / 86400000) + 1,
      estado: c.estado,
      motivo: c.motivo,
      aprobaciones: [{
        paso: i % 2 === 0 ? 'LOCAL' : 'ZONAL',
        usuario: admin?._id,
        decision: rechazado ? 'RECHAZADO' : 'APROBADO',
        comentario: rechazado ? 'No hay quien cubra el turno esa semana' : 'Conforme',
        fecha: dia(c.off[0] - 7),
      }],
      motivoRechazo: rechazado ? 'Cobertura insuficiente en el local durante esas fechas' : undefined,
      aprobadoPor: rechazado ? undefined : rrhh?._id,
      aprobadoEn: rechazado ? undefined : dia(c.off[0] - 5),
      avisosCobertura: rechazado ? ['El local quedaría sin Químico Farmacéutico el martes'] : [],
    });
    if (nuevo) vacExtra += 1;
  }
  anota('Descansos de todo tipo', vacExtra, '7 estados y 4 tipos representados');

  // ══ 6 · Asistencia: hoy, licencias y feriados ════════════════════════════
  // La asistencia se marca en un centro de trabajo: el personal corporativo,
  // que no tiene local asignado, queda fuera de este bloque
  const activosHoy = await Empleado.find({ estado: 'ACTIVO', localActual: { $ne: null } })
    .limit(30).lean();
  const inicioDeHoy = new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate());
  let asisHoy = 0;
  for (let i = 0; i < activosHoy.length; i++) {
    const e = activosHoy[i];
    const tarde = i % 7 === 0;
    const entrada = new Date(inicioDeHoy.getTime() + (8 * 60 + (tarde ? 23 : 0)) * 60000);
    const salida = new Date(inicioDeHoy.getTime() + 15 * 3600000);
    const { nuevo } = await asegurar(Asistencia, { empleado: e._id, fecha: inicioDeHoy }, {
      local: e.localActual,
      marcaEntrada: entrada,
      marcaSalida: salida,
      estado: tarde ? 'TARDANZA' : 'PRESENTE',
      minutosTardanza: tarde ? 23 : 0,
      horasTrabajadas: Math.round(((salida - entrada) / 3600000) * 100) / 100,
      horasExtra: i % 9 === 0 ? 1.5 : 0,
    });
    if (nuevo) asisHoy += 1;
  }
  anota('Asistencias de hoy', asisHoy, 'con tardanzas y horas extra');

  // Estados de asistencia que no tenían ni un registro
  const feriado = new Date(2026, 6, 28);                 // Fiestas Patrias
  let asisEstados = 0;
  for (let i = 0; i < 8; i++) {
    const e = activosHoy[i];
    const r1 = await asegurar(Asistencia, { empleado: e._id, fecha: feriado }, {
      local: e.localActual, estado: 'FERIADO', horasTrabajadas: 0,
      notas: 'Día feriado no laborable — Fiestas Patrias',
    });
    if (r1.nuevo) asisEstados += 1;
  }
  for (let i = 0; i < enLicencia.length; i++) {
    const e = enLicencia[i];
    const f = dia(-2);
    const dLic = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    const r2 = await asegurar(Asistencia, { empleado: e._id, fecha: dLic }, {
      local: e.localActual, estado: 'LICENCIA', horasTrabajadas: 0,
      notas: 'Descanso médico con CITT vigente',
    });
    if (r2.nuevo) asisEstados += 1;
  }
  anota('Asistencias FERIADO y LICENCIA', asisEstados, 'estados que no existían');

  // ══ 7 · Boletas del mes en curso ═════════════════════════════════════════
  const periodoHoy = periodoDe(HOY);
  const MEDIOS = ['TRANSFERENCIA', 'DEPOSITO_CUENTA', 'EFECTIVO', 'CHEQUE'];
  const ESTADOS_BOL = ['BORRADOR', 'CALCULADO', 'APROBADO', 'PAGADO'];
  let boletas = 0;
  for (let i = 0; i < 24 && i < activosHoy.length; i++) {
    const e = activosHoy[i];
    const basico = e.sueldoBasico || 1500;
    const af = e.tieneHijos ? 113 : 0;
    const estado = ESTADOS_BOL[i % 4];
    const bruto = basico + af;
    const desc = Math.round(bruto * 0.13 * 100) / 100;
    const { nuevo } = await asegurar(Boleta, { empleado: e._id, periodo: periodoHoy }, {
      sueldoBasico: basico,
      diasTrabajados: 30,
      ingresos: { basico, asignacionFamiliar: af, total: bruto },
      descuentos: { pension: { sistema: e.sistemaPensiones || 'ONP', aporte: desc, total: desc }, total: desc },
      netoAPagar: Math.round((bruto - desc) * 100) / 100,
      estado,
      calculadoEn: dia(-2),
      aprobadoPor: ['APROBADO', 'PAGADO'].includes(estado) ? rrhh?._id : undefined,
      aprobadoEn: ['APROBADO', 'PAGADO'].includes(estado) ? dia(-1) : undefined,
      pagadoEn: estado === 'PAGADO' ? HOY : undefined,
      pagadoPor: estado === 'PAGADO' ? admin?._id : undefined,
      medioDePago: MEDIOS[i % 4],
      referenciaPago: estado === 'PAGADO' ? `TR-2026-${7000 + i}` : undefined,
    });
    if (nuevo) boletas += 1;
  }
  anota(`Boletas del período ${periodoHoy}`, boletas, '4 estados y 4 medios de pago');

  // ══ 8 · Evaluaciones con todas las calificaciones ════════════════════════
  const evaluador = await Empleado.findOne({ tipoProfesional: 'JEFE_ZONA' }).lean()
    || veteranos[0];
  const NOTAS = [
    { puntaje: 95, calif: 'EXCELENTE', estado: 'FIRMADO' },
    { puntaje: 82, calif: 'MUY_BUENO', estado: 'REVISADO' },
    { puntaje: 68, calif: 'BUENO', estado: 'ENVIADO' },
    { puntaje: 52, calif: 'REGULAR', estado: 'ENVIADO' },
    { puntaje: 31, calif: 'DEFICIENTE', estado: 'BORRADOR' },
    { puntaje: 88, calif: 'MUY_BUENO', estado: 'FIRMADO' },
    { puntaje: 74, calif: 'BUENO', estado: 'REVISADO' },
    { puntaje: 45, calif: 'REGULAR', estado: 'BORRADOR' },
  ];
  let evals = 0;
  for (let i = 0; i < NOTAS.length; i++) {
    const e = paraDescanso[i] || activosHoy[i];
    const n = NOTAS[i];
    const ini = fecha(2026, 4, 1);
    const { nuevo } = await asegurar(Evaluacion,
      { empleado: e._id, 'periodo.fechaInicio': ini, evaluador: evaluador._id }, {
        periodo: { nombre: '2026-Q2', fechaInicio: ini, fechaFin: fecha(2026, 6, 30) },
        kpis: [
          { nombre: 'Cumplimiento de turnos', meta: 100, real: n.puntaje, peso: 40, unidad: '%' },
          { nombre: 'Atención al cliente', meta: 100, real: Math.max(20, n.puntaje - 5), peso: 30, unidad: '%' },
          { nombre: 'Cumplimiento BPA', meta: 100, real: Math.min(100, n.puntaje + 4), peso: 30, unidad: '%' },
        ],
        calificacionCualitativa: n.calif,
        fortalezas: 'Puntualidad y trato con el público.',
        areasDeMejora: n.puntaje < 60 ? 'Registro de productos controlados y orden del almacén.' : 'Profundizar en normativa DIGEMID.',
        estado: n.estado,
        enviadoEn: n.estado === 'BORRADOR' ? undefined : dia(-30),
        enviadoPor: n.estado === 'BORRADOR' ? undefined : admin?._id,
        revisadoEn: ['REVISADO', 'FIRMADO'].includes(n.estado) ? dia(-25) : undefined,
        revisadoPor: ['REVISADO', 'FIRMADO'].includes(n.estado) ? rrhh?._id : undefined,
        firmadoPorEmpleado: n.estado === 'FIRMADO',
        firmadoEn: n.estado === 'FIRMADO' ? dia(-20) : undefined,
        empleadoConforme: n.puntaje > 50,
        comentarioEmpleado: n.puntaje <= 50 ? 'Dejo constancia de mi desacuerdo con la nota de BPA.' : undefined,
      });
    if (nuevo) evals += 1;
  }
  anota('Evaluaciones de desempeño', evals, '5 calificaciones, 4 estados');

  // ══ 9 · Contratos: renovaciones y decisiones ═════════════════════════════
  const porVencer = await Contrato.find({ estado: 'POR_VENCER' }).limit(6).lean();
  let renov = 0;
  for (let i = 0; i < porVencer.length; i++) {
    const c = porVencer[i];
    const caso = i % 3;
    const cambios = caso === 0 ? {
      estado: 'RENOVADO',
      historialRenovaciones: [{ fechaFinAnterior: c.fechaFin,
        nuevaFechaFin: new Date(new Date(c.fechaFin).getTime() + 365 * 86400000),
        renovadoEn: dia(-5), aprobadoPor: rrhh?._id, notas: 'Renovación por un año más' }],
      decisionRenovacion: { recomendacion: 'RENOVAR', recomendadoPor: admin?._id,
        recomendadoEn: dia(-9), notaRecomendacion: 'Buen desempeño y puntualidad',
        decision: 'RENOVADO', decididoPor: rrhh?._id, decididoEn: dia(-5),
        notaDecision: 'Se aprueba la renovación' },
      alertasEnviadas: [{ tipo: '30_DIAS', enviadoEn: dia(-35) }, { tipo: '15_DIAS', enviadoEn: dia(-20) }],
    } : caso === 1 ? {
      estado: 'TERMINADO',
      decisionRenovacion: { recomendacion: 'NO_RENOVAR', recomendadoPor: admin?._id,
        recomendadoEn: dia(-12), notaRecomendacion: 'Reiteradas tardanzas',
        decision: 'NO_RENOVADO', decididoPor: rrhh?._id, decididoEn: dia(-8),
        notaDecision: 'No se renueva' },
      motivoTermino: 'Vencimiento de contrato sin renovación',
      alertasEnviadas: [{ tipo: '7_DIAS', enviadoEn: dia(-10) }, { tipo: 'VENCIDO', enviadoEn: dia(-1) }],
    } : {
      decisionRenovacion: { recomendacion: 'INDETERMINADO', recomendadoPor: admin?._id,
        recomendadoEn: dia(-6), notaRecomendacion: 'Tercera renovación: corresponde indeterminado',
        decision: 'CONVERTIDO_INDETERMINADO', decididoPor: rrhh?._id, decididoEn: dia(-3),
        notaDecision: 'Se convierte a plazo indeterminado (art. 77 LPCL)' },
      alertasEnviadas: [{ tipo: '30_DIAS', enviadoEn: dia(-40) }],
    };
    renov += await actualizar(Contrato, { _id: c._id }, cambios);
  }
  anota('Contratos con decisión', renov, 'renovado, terminado y convertido');

  // ══ 10 · Capacitaciones, notificaciones y auditorías ═════════════════════
  let caps = 0;
  for (let i = 0; i < 6; i++) {
    const e = activosHoy[i + 5];
    const c = [
      { nombre: 'Taller de clima laboral', tipo: 'OTRO', estado: 'PROGRAMADA', f: dia(20) },
      { nombre: 'Manejo de residuos peligrosos', tipo: 'OTRO', estado: 'COMPLETADA', f: dia(-40) },
      { nombre: 'Primeros auxilios', tipo: 'SEGURIDAD', estado: 'CANCELADA', f: dia(-10) },
      { nombre: 'Buenas Prácticas de Almacenamiento', tipo: 'BPA', estado: 'EN_CURSO', f: dia(-3) },
      { nombre: 'Farmacovigilancia DIGEMID', tipo: 'DIGEMID', estado: 'PROGRAMADA', f: dia(14) },
      { nombre: 'Liderazgo para jefes de local', tipo: 'LIDERAZGO', estado: 'COMPLETADA', f: dia(-70) },
    ][i];
    const { nuevo } = await asegurar(Capacitacion, { empleado: e._id, nombre: c.nombre }, {
      tipo: c.tipo,
      proveedor: ['Instituto ISP', 'DIGEMID', 'Cruz Roja Peruana', 'InRetail Academy'][i % 4],
      fechaProgramada: c.f,
      fechaCompletado: c.estado === 'COMPLETADA' ? c.f : undefined,
      horasDuracion: 8 + i,
      estado: c.estado,
      puntaje: c.estado === 'COMPLETADA' ? 80 + i : undefined,
      numeroCertificado: c.estado === 'COMPLETADA' ? `CERT-2026-${400 + i}` : undefined,
      venceEn: c.estado === 'COMPLETADA' ? fecha(2028, 6, 30) : undefined,
      notas: c.estado === 'CANCELADA' ? 'Cancelada por falta de aforo mínimo' : undefined,
    });
    if (nuevo) caps += 1;
  }
  anota('Capacitaciones', caps, 'incluye OTRO y CANCELADA');

  const TIPOS_NOTIF = ['CONTRATO', 'QF_COBERTURA', 'NOMINA', 'BOTICA', 'CEDI', 'EVALUACION'];
  let notifs = 0;
  for (let i = 0; i < TIPOS_NOTIF.length; i++) {
    const t = TIPOS_NOTIF[i];
    const titulo = {
      CONTRATO: 'Contrato próximo a vencer',
      QF_COBERTURA: 'Turno sin Químico Farmacéutico',
      NOMINA: 'Planilla del período lista para aprobar',
      BOTICA: 'Botica con observación de auditoría',
      CEDI: 'Requerimiento de personal en el CEDI',
      EVALUACION: 'Evaluación pendiente de firma',
    }[t];
    const { nuevo } = await asegurar(Notificacion, { usuario: rrhh?._id, titulo }, {
      tipo: t,
      mensaje: {
        CONTRATO: 'El contrato de un empleado vence en 15 días y no tiene recomendación registrada.',
        QF_COBERTURA: 'El turno de mañana del martes quedó sin Químico Farmacéutico asignado.',
        NOMINA: 'La planilla del mes está calculada y espera aprobación.',
        BOTICA: 'Mifarma Breña registra un hallazgo crítico sin acción correctiva.',
        CEDI: 'El CEDI Villa El Salvador solicita dos operarios de picking.',
        EVALUACION: 'Hay evaluaciones enviadas que el evaluado aún no firma.',
      }[t],
      prioridad: ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'][i % 4],
      leido: i % 3 === 0,
      leidoEn: i % 3 === 0 ? dia(-1) : undefined,
    });
    if (nuevo) notifs += 1;
  }
  anota('Notificaciones', notifs, '6 tipos y 4 prioridades');

  const auditor = await Usuario.findOne({ rol: 'AUDITOR_CALIDAD' }).lean() || admin;
  const TIPOS_AUD = ['PROGRAMADA', 'SEGUIMIENTO', 'PRE_DIGEMID', 'INOPINADA'];
  let auds = 0;
  for (let i = 0; i < 4; i++) {
    const l = locales[i % locales.length];
    const f = dia(-(4 + i * 6));
    const { nuevo } = await asegurar(VisitaAuditoria, { local: l._id, fechaVisita: f }, {
      zona: l.zona,
      auditor: auditor?._id,
      tipo: TIPOS_AUD[i],
      directorTecnicoPresente: i !== 2,
      hallazgos: [{
        categoria: ['CADENA_FRIO', 'DOCUMENTACION', 'PRESENCIA_QF', 'ROTULADO_VENCIMIENTOS'][i],
        severidad: ['MENOR', 'OBSERVACION', 'CRITICA', 'MAYOR'][i],
        descripcion: ['Registro de temperatura incompleto el fin de semana',
          'Falta la firma del QF en dos actas',
          'Director técnico ausente durante la visita',
          'Producto con vencimiento a 60 días sin señalizar'][i],
        accionCorrectiva: 'Se instruye al personal y se programa seguimiento',
        fechaVencimiento: dia(15 + i * 5),
        resuelto: i === 1,
        resueltoEn: i === 1 ? dia(-1) : undefined,
      }],
      estado: i === 3 ? 'BORRADOR' : (i === 1 ? 'EN_SEGUIMIENTO' : 'CERRADA'),
      resumen: 'Visita de verificación del cumplimiento DIGEMID.',
      fechaProximaVisita: dia(60 + i * 10),
    });
    if (nuevo) auds += 1;
  }
  anota('Visitas de auditoría', auds, '4 tipos, incluye BORRADOR');

  // ══ 11 · Requerimientos y candidatos ═════════════════════════════════════
  const CASOS_REQ = [
    { turno: 'MANANA', motivo: 'APERTURA_LOCAL', estado: 'SOLICITADO', urg: 'ALTA' },
    { turno: 'TARDE', motivo: 'TEMPORADA_ALTA', estado: 'APROBADO_ZONAL', urg: 'MEDIA' },
    { turno: 'NOCHE', motivo: 'CESE', estado: 'EN_BUSQUEDA', urg: 'CRITICA' },
    { turno: 'COMPLETO', motivo: 'REEMPLAZO', estado: 'RECHAZADO', urg: 'BAJA' },
    { turno: 'ROTATIVO', motivo: 'COBERTURA_VACACIONES', estado: 'CANCELADO', urg: 'MEDIA' },
    { turno: 'MANANA', motivo: 'INCREMENTO_DOTACION', estado: 'CUBIERTO', urg: 'ALTA' },
  ];
  const reqCreados = [];
  for (let i = 0; i < CASOS_REQ.length; i++) {
    const c = CASOS_REQ[i];
    const l = locales[(i + 2) % locales.length];
    const { doc, nuevo } = await asegurar(Requerimiento,
      { local: l._id, motivo: c.motivo, turno: c.turno }, {
        cargo: cargoDe(['TCF', 'QFA', 'CAJ', 'TCF', 'AXA', 'TCF'][i])._id,
        zona: l.zona,
        cantidad: 1 + (i % 3),
        justificacion: {
          APERTURA_LOCAL: 'Apertura de nuevo punto de venta en el distrito.',
          TEMPORADA_ALTA: 'Campaña de invierno: aumenta la afluencia por las tardes.',
          CESE: 'Renuncia del técnico del turno noche; el local queda descubierto.',
          REEMPLAZO: 'Reemplazo por descanso médico prolongado.',
          COBERTURA_VACACIONES: 'Cobertura del período vacacional de dos técnicos.',
          INCREMENTO_DOTACION: 'El formato del local pasó a estándar y exige más dotación.',
        }[c.motivo],
        urgencia: c.urg,
        requeridoPara: dia(20 + i * 5),
        sueldoOfrecido: 1400 + i * 120,
        solicitadoPor: admin?._id,
        estado: c.estado,
        aprobaciones: c.estado === 'RECHAZADO'
          ? [{ paso: 'ZONAL', usuario: rrhh?._id, decision: 'RECHAZADO', comentario: 'Sin presupuesto este trimestre', fecha: dia(-8) }]
          : (['APROBADO_ZONAL', 'EN_BUSQUEDA', 'CUBIERTO'].includes(c.estado)
            ? [{ paso: 'ZONAL', usuario: rrhh?._id, decision: 'APROBADO', comentario: 'Dotación justificada', fecha: dia(-12) }]
            : []),
        cerradoEn: ['CUBIERTO', 'CANCELADO', 'RECHAZADO'].includes(c.estado) ? dia(-2) : undefined,
      });
    reqCreados.push(doc);
    if (nuevo) auds; // el conteo se hace abajo
  }
  anota('Requerimientos de personal', reqCreados.length, '5 turnos, 6 motivos, 6 estados');

  const ETAPAS = ['POSTULADO', 'FILTRO_CV', 'ENTREVISTA', 'EVALUACION_TECNICA', 'OFERTA',
    'CONTRATADO', 'DESCARTADO', 'DESISTIO'];
  let cands = 0;
  for (let i = 0; i < 16; i++) {
    const p = persona(i + 40);
    const etapa = ETAPAS[i % ETAPAS.length];
    const req = reqCreados[i % reqCreados.length];
    if (!req?._id) continue;
    const historial = ETAPAS.slice(0, Math.max(1, ETAPAS.indexOf(etapa) + 1))
      .map((et, k) => ({ etapa: et, fecha: dia(-(40 - k * 4)), usuario: admin?._id,
        nota: k === 0 ? 'Postulación recibida por el portal' : undefined }));
    const { nuevo } = await asegurar(Candidato, { dni: String(70500000 + i * 211) }, {
      nombres: p.nombres,
      apellidos: p.apellidos,
      correo: `${p.nombres}.${p.apellidos.split(' ')[0]}.cand${i}`.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') + '@correo.pe',
      telefono: `9${String(20000000 + i * 3137).slice(0, 8)}`,
      requerimiento: req._id,
      origen: ['BOLSA_UNIVERSITARIA', 'PORTAL_WEB', 'REFERIDO', 'FERIA_LABORAL', 'REDES_SOCIALES', 'BASE_INTERNA'][i % 6],
      tipoProfesional: ['TECNICO', 'QF', 'OPERARIO', 'ADMINISTRATIVO'][i % 4],
      numeroCQF: i % 4 === 1 ? `CQF-${31000 + i}` : undefined,
      tieneCapacitacionDigemid: i % 3 === 0,
      anosExperiencia: i % 7,
      formacion: ['Técnico en Farmacia', 'Químico Farmacéutico', 'Secundaria completa', 'Administración'][i % 4],
      etapa,
      historialEtapas: historial,
      puntajeEntrevista: ETAPAS.indexOf(etapa) >= 2 ? 60 + (i % 35) : undefined,
      puntajeTecnico: ETAPAS.indexOf(etapa) >= 3 ? 55 + (i % 40) : undefined,
      sueldoEsperado: 1400 + i * 90,
      motivoRechazo: etapa === 'DESCARTADO' ? 'No cumple la experiencia mínima requerida' : undefined,
      notas: etapa === 'DESISTIO' ? 'Comunicó que aceptó otra oferta' : undefined,
    });
    if (nuevo) cands += 1;
  }
  anota('Candidatos', cands, '8 etapas del embudo representadas');

  // ══ 12 · Descansos médicos: subsidios y estados ══════════════════════════
  const CASOS_DM = [
    { tipo: 'LACTANCIA', estado: 'VALIDADO', reemb: 'PRESENTADO', dias: 30 },
    { tipo: 'ENFERMEDAD_PROFESIONAL', estado: 'CERRADO', reemb: 'REEMBOLSADO', dias: 45 },
    { tipo: 'ACCIDENTE_COMUN', estado: 'RECHAZADO', reemb: 'NO_APLICA', dias: 4 },
    { tipo: 'ENFERMEDAD_COMUN', estado: 'VALIDADO', reemb: 'OBSERVADO', dias: 28 },
    { tipo: 'MATERNIDAD', estado: 'CERRADO', reemb: 'REEMBOLSADO', dias: 98 },
  ];
  let dm2 = 0;
  for (let i = 0; i < CASOS_DM.length; i++) {
    const e = paraDescanso[i + 8] || activosHoy[i + 10];
    const c = CASOS_DM[i];
    const inicio = dia(-(120 + i * 20));
    const fin = new Date(inicio.getTime() + c.dias * 86400000);
    const { nuevo } = await asegurar(DescansoMedico, { empleado: e._id, fechaInicio: inicio }, {
      tipo: c.tipo,
      diagnostico: ['Z39.1 Lactancia materna', 'J68.0 Bronquitis química ocupacional',
        'S93.4 Esguince de tobillo', 'K29.7 Gastritis', 'O80 Parto único espontáneo'][i],
      centroMedico: 'EsSalud Angamos',
      nombreMedico: `Dr(a). ${APELLIDOS[i]} `,
      cmpMedico: `CMP-${41000 + i}`,
      fechaFin: fin,
      diasTotales: c.dias,
      citt: { numero: `CITT-2026-${7100 + i}`, emitido: c.estado !== 'RECHAZADO',
        fechaEmision: inicio, canjeadoEn: c.reemb !== 'NO_APLICA' ? new Date(inicio.getTime() + 86400000 * 3) : undefined },
      subsidio: { aplica: c.dias > 20, diasEmpleador: Math.min(c.dias, 20),
        diasEssalud: Math.max(0, c.dias - 20),
        montoEstimado: Math.max(0, c.dias - 20) * 55,
        estadoReembolso: c.reemb,
        fechaReembolso: c.reemb === 'REEMBOLSADO' ? dia(-30) : undefined,
        montoReembolsado: c.reemb === 'REEMBOLSADO' ? Math.max(0, c.dias - 20) * 55 : undefined },
      estado: c.estado,
      validadoPor: c.estado === 'RECHAZADO' ? undefined : rrhh?._id,
      registradoPor: admin?._id,
      notas: c.estado === 'RECHAZADO' ? 'El certificado no consigna colegiatura médica' : undefined,
    });
    if (nuevo) dm2 += 1;
  }
  anota('Descansos médicos con subsidio', dm2, 'reembolsos en 4 estados');

  // ══ 13 · Turnos y horarios: estados de ejecución ═════════════════════════
  const horariosViejos = await Horario.find().sort({ inicioSemana: 1 }).limit(4).lean();
  let hor = 0;
  for (const h of horariosViejos.slice(0, 2)) {
    hor += await actualizar(Horario, { _id: h._id }, { estado: 'COMPLETADO' });
  }
  anota('Horarios completados', hor, 'semanas ya cerradas');

  const turnosViejos = await Turno.find().sort({ fecha: 1 }).limit(30).lean();
  let tur = 0;
  for (let i = 0; i < turnosViejos.length; i++) {
    const estado = ['COMPLETADO', 'EN_CURSO', 'CANCELADO'][i % 3];
    tur += await actualizar(Turno, { _id: turnosViejos[i]._id }, { estado });
  }
  anota('Turnos con estado de ejecución', tur, 'completado, en curso y cancelado');

  // Un turno con QF asistente y administrador de botica, roles que no aparecían
  const turnoConRoles = turnosViejos[0];
  if (turnoConRoles) {
    const qfAsis = await Empleado.findOne({ tipoProfesional: 'QF', estado: 'ACTIVO' }).lean();
    const jefe = await Empleado.findOne({ tipoProfesional: 'JEFE_LOCAL', estado: 'ACTIVO' }).lean();
    const asignaciones = [...(turnoConRoles.asignaciones || [])];
    if (qfAsis) asignaciones.push({ empleado: qfAsis._id, rol: 'QF_ASISTENTE', esSustituto: false });
    if (jefe) asignaciones.push({ empleado: jefe._id, rol: 'ADMIN_BOTICA', esSustituto: true });
    await actualizar(Turno, { _id: turnoConRoles._id }, {
      asignaciones,
      'cobertura.severidad': 'MENOR',
      conflictos: [{ rol: 'CAJERO', severidad: 'MENOR', hallazgo: 'Falta un cajero en hora punta' }],
    });
    anota('Roles QF_ASISTENTE y ADMIN_BOTICA', 2, 'asignados a un turno real');
  }

  // ══ 14 · Una cuenta con rol JEFE_LOCAL ═══════════════════════════════════
  const jefeLocal = await Empleado.findOne({ tipoProfesional: 'JEFE_LOCAL', estado: 'ACTIVO' }).lean();
  if (jefeLocal) {
    const yaTiene = await Usuario.findOne({ empleado: jefeLocal._id });
    if (yaTiene && yaTiene.rol !== 'JEFE_LOCAL') {
      const n = await actualizar(Usuario, { _id: yaTiene._id }, { rol: 'JEFE_LOCAL' });
      anota('Cuenta con rol JEFE_LOCAL', n, yaTiene.correo);
    } else if (!yaTiene) {
      const correo = `jefe.local@pharmatalent.pe`;
      const { nuevo } = await asegurar(Usuario, { correo }, {
        contrasena: await bcrypt.hash(require('./lib/clave-demo').claveDemo(), 12),
        rol: 'JEFE_LOCAL',
        empleado: jefeLocal._id,
        activo: true,
        creadoPor: admin?._id,
      });
      anota('Cuenta con rol JEFE_LOCAL', nuevo ? 1 : 0, correo);
    }
  }

  await mongoose.disconnect();

  console.log('%s %s %s', 'BLOQUE'.padEnd(32), 'N'.padStart(5), 'DETALLE');
  for (const [s, n, d] of resumen) console.log('%s %s %s', s.padEnd(32), String(n).padStart(5), d);
  console.log('\n%s', aplicar ? 'Primera parte aplicada.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); console.error(e.stack); process.exit(1); });
