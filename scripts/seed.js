require('dotenv').config();
// La zona horaria se impone antes de crear cualquier fecha
require('../src/config/zonaHoraria').fijarZonaHoraria();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  Usuario, Empleado, Cargo, Local, Zona, Contrato, Asistencia, Vacacion,
  Evaluacion, Horario, Turno, Boleta, Capacitacion, Notificacion,
  Requerimiento, Candidato, DescansoMedico, VisitaAuditoria,
} = require('../src/models');

const d = (s) => new Date(s);
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB\n');

  const collections = [
    Usuario, Empleado, Cargo, Local, Zona, Contrato, Asistencia, Vacacion,
    Evaluacion, Horario, Turno, Boleta, Capacitacion, Notificacion,
    Requerimiento, Candidato, DescansoMedico, VisitaAuditoria,
  ];
  for (const Model of collections) await Model.deleteMany({});
  console.log('Colecciones limpiadas');

  // ══════════════════════════════════════════════════════════════════════════
  // CATÁLOGO DE PUESTOS — cuatro niveles organizacionales
  // ══════════════════════════════════════════════════════════════════════════
  const positions = await Cargo.insertMany([
    // ── Sede Corporativa ──
    { nombre:'Gerente de Recursos Humanos', codigo:'GRH', departamento:'GERENCIA', nivelOrganizacional:'CORPORATIVO', rolPorDefecto:'GERENTE_RRHH', nivel:9, rangoSueldo:{minimo:12000,maximo:18000}, requisitos:['MBA o maestría en RRHH','10+ años de experiencia en retail'] },
    { nombre:'Analista de Planillas', codigo:'APL', departamento:'RRHH', nivelOrganizacional:'CORPORATIVO', rolPorDefecto:'ANALISTA_NOMINAS', nivel:6, rangoSueldo:{minimo:3200,maximo:5000}, requisitos:['Legislación laboral peruana','Excel avanzado','Manejo de PLAME'] },
    { nombre:'Analista de Selección', codigo:'ASE', departamento:'RRHH', nivelOrganizacional:'CORPORATIVO', rolPorDefecto:'ANALISTA_SELECCION', nivel:6, rangoSueldo:{minimo:3000,maximo:4800}, requisitos:['Psicología o Administración','Reclutamiento masivo'] },
    { nombre:'Analista de Capacitación', codigo:'ACA', departamento:'RRHH', nivelOrganizacional:'CORPORATIVO', rolPorDefecto:'ANALISTA_CAPACITACION', nivel:6, rangoSueldo:{minimo:3000,maximo:4800}, requisitos:['Gestión de plataformas e-learning','Conocimiento de BPA y DIGEMID'] },
    { nombre:'Gestor de Bienestar Social', codigo:'GBS', departamento:'RRHH', nivelOrganizacional:'CORPORATIVO', rolPorDefecto:'GESTOR_BIENESTAR', nivel:6, rangoSueldo:{minimo:3000,maximo:4500}, requisitos:['Trabajo Social','Gestión de subsidios EsSalud y CITT'] },

    // ── Supervisión Zonal ──
    { nombre:'Supervisor de Zona', codigo:'SZO', departamento:'OPERACIONES', nivelOrganizacional:'ZONAL', rolPorDefecto:'JEFE_ZONA', nivel:8, rangoSueldo:{minimo:6000,maximo:9500}, requisitos:['Experiencia gerencial 3+ años','Gestión de 15-20 puntos de venta'] },
    { nombre:'Auditor de Calidad', codigo:'AUC', departamento:'CALIDAD', nivelOrganizacional:'ZONAL', rolPorDefecto:'AUDITOR_CALIDAD', nivel:7, rangoSueldo:{minimo:4500,maximo:6500}, requiereQF:true, requisitos:['QF colegiado','Normativa DIGEMID y BPA','Disponibilidad para viajar'] },

    // ── Centro de Distribución ──
    { nombre:'Jefe de Centro de Distribución', codigo:'JCD', departamento:'LOGISTICA', nivelOrganizacional:'CEDI', rolPorDefecto:'JEFE_CEDI', nivel:7, rangoSueldo:{minimo:6000,maximo:9000}, requisitos:['Ingeniería Industrial','Gestión de almacenes farmacéuticos'] },
    { nombre:'Coordinador de Rutas y Despacho', codigo:'CRD', departamento:'LOGISTICA', nivelOrganizacional:'CEDI', rolPorDefecto:'COORD_RUTAS', nivel:5, rangoSueldo:{minimo:3000,maximo:4500}, requisitos:['Planificación de rutas','Gestión de flota'] },
    { nombre:'Operario de Picking', codigo:'OPK', departamento:'LOGISTICA', nivelOrganizacional:'CEDI', rolPorDefecto:'OPERARIO_CEDI', nivel:2, rangoSueldo:{minimo:1300,maximo:1800}, requisitos:['Secundaria completa','Manejo de scanner y WMS'] },
    { nombre:'Operador de Montacargas', codigo:'OMC', departamento:'LOGISTICA', nivelOrganizacional:'CEDI', rolPorDefecto:'OPERARIO_CEDI', nivel:3, rangoSueldo:{minimo:1600,maximo:2200}, requisitos:['Licencia de operador de montacargas vigente'] },

    // ── Botica ──
    { nombre:'Químico Farmacéutico (Director Técnico)', codigo:'QFD', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'QF', nivel:5, rangoSueldo:{minimo:3500,maximo:5500}, requiereQF:true, requisitos:['Título de Químico Farmacéutico','Colegiatura CQF vigente','Habilitación DIGEMID'] },
    { nombre:'Químico Farmacéutico Asistente', codigo:'QFA', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'QF_ASISTENTE', nivel:4, rangoSueldo:{minimo:2800,maximo:3800}, requiereQF:true, requisitos:['Título de QF','Colegiatura CQF vigente'] },
    { nombre:'Administrador de Botica', codigo:'ADB', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'ADMIN_BOTICA', nivel:6, rangoSueldo:{minimo:2800,maximo:4200}, requisitos:['Administración o afines','Gestión comercial y de inventarios'] },
    { nombre:'Técnico en Farmacia', codigo:'TCF', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'TECNICO', nivel:3, rangoSueldo:{minimo:1400,maximo:2200}, requisitos:['Título técnico en Farmacia','Experiencia mínima 6 meses'] },
    { nombre:'Técnico en Entrenamiento', codigo:'TRN', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'TRAINEE', nivel:1, rangoSueldo:{minimo:1130,maximo:1400}, requisitos:['Estudiante o egresado de Farmacia'] },
    { nombre:'Cajero', codigo:'CAJ', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'CAJERO', nivel:2, rangoSueldo:{minimo:1200,maximo:1600}, requisitos:['Secundaria completa','Manejo de caja y medios de pago'] },
    { nombre:'Dermoconsultora', codigo:'DER', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'DERMOCONSULTOR', nivel:3, rangoSueldo:{minimo:1500,maximo:2200}, requisitos:['Cosmetología o afines','Asesoría en dermocosmética'] },
    { nombre:'Auxiliar de Almacén', codigo:'AXA', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'AUX_ALMACEN', nivel:2, rangoSueldo:{minimo:1300,maximo:1700}, requisitos:['Secundaria completa','Control de guías de remisión'] },
    { nombre:'Prevencionista', codigo:'PRV', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'PREVENCIONISTA', nivel:2, rangoSueldo:{minimo:1300,maximo:1700}, requisitos:['Experiencia en prevención de pérdidas'] },
    { nombre:'Motorizado', codigo:'MOT', departamento:'OPERACIONES', nivelOrganizacional:'BOTICA', rolPorDefecto:'MOTORIZADO', nivel:2, rangoSueldo:{minimo:1400,maximo:1900}, requisitos:['Licencia A-I vigente','Moto propia (bonificación)'] },
  ]);
  const P = Object.fromEntries(positions.map((p) => [p.codigo, p._id]));
  console.log(`${positions.length} puestos creados (4 niveles organizacionales)`);

  // ══════════════════════════════════════════════════════════════════════════
  // ZONAS — Lima + provincias
  // ══════════════════════════════════════════════════════════════════════════
  const zones = await Zona.insertMany([
    { nombre:'Lima Norte', codigo:'LNORTE', descripcion:'Los Olivos, Comas, Independencia, SMP, Carabayllo, Puente Piedra' },
    { nombre:'Lima Centro', codigo:'LCENTRO', descripcion:'Cercado, Breña, Jesús María, Lince, Magdalena, Pueblo Libre, San Miguel' },
    { nombre:'Lima Sur', codigo:'LSUR', descripcion:'Chorrillos, Villa El Salvador, San Juan de Miraflores, VMT' },
    { nombre:'Lima Moderna', codigo:'LMODERNA', descripcion:'Miraflores, San Isidro, San Borja, Surco, La Molina, Barranco' },
    { nombre:'Región Centro', codigo:'RCENTRO', descripcion:'Junín, Huancavelica, Pasco — sede zonal en Huancayo' },
    { nombre:'Región Norte', codigo:'RNORTE', descripcion:'La Libertad, Lambayeque, Piura — sede zonal en Trujillo' },
    { nombre:'Región Sur', codigo:'RSUR', descripcion:'Arequipa, Cusco, Puno — sede zonal en Arequipa' },
  ]);
  const Z = Object.fromEntries(zones.map((z) => [z.codigo, z._id]));
  console.log(`${zones.length} zonas creadas (Lima + 3 regiones de provincia)`);

  // ══════════════════════════════════════════════════════════════════════════
  // CENTROS DE TRABAJO — boticas, CEDI y sede corporativa
  // ══════════════════════════════════════════════════════════════════════════
  const H24 = { tipos:['MANANA','TARDE','NOCHE'], horario:{ MANANA:{inicio:'07:00',fin:'15:00'}, TARDE:{inicio:'15:00',fin:'23:00'} } };

  const locationData = [
    // ── Lima Moderna ──
    { nombre:'Inkafarma Miraflores Larco', codigo:'IKF-312', marca:'INKAFARMA', formato:'FLAGSHIP', distrito:'Miraflores', calle:'Av. Larco 890', zona:'LMODERNA', codigoDigemid:'EF-15-0312',
      staff:{ qfPorTurno:1, tecnicosPorTurno:3, cajerosPorTurno:1, dermoPorTurno:1, almacenPorTurno:1, seguridadPorTurno:1, repartidoresPorTurno:2 } },
    { nombre:'Inkafarma La Molina', codigo:'IKF-089', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'La Molina', calle:'Av. Javier Prado Este 4520', zona:'LMODERNA', codigoDigemid:'EF-15-0089',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, dermoPorTurno:1, seguridadPorTurno:1 } },
    { nombre:'Mifarma San Borja', codigo:'MIF-441', marca:'MIFARMA', formato:'ESTANDAR', distrito:'San Borja', calle:'Av. Aviación 2670', zona:'LMODERNA', codigoDigemid:'EF-15-0441',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, dermoPorTurno:1 } },

    // ── Lima Centro ──
    { nombre:'Inkafarma San Miguel', codigo:'IKF-247', marca:'INKAFARMA', formato:'H24', distrito:'San Miguel', calle:'Av. La Marina 2355', zona:'LCENTRO', codigoDigemid:'EF-15-0247', turnos:H24,
      hours:{ apertura:'00:00', cierre:'23:59' },
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, seguridadPorTurno:1, repartidoresPorTurno:1 } },
    { nombre:'Inkafarma Jesús María', codigo:'IKF-178', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'Jesús María', calle:'Av. Brasil 1580', zona:'LCENTRO', codigoDigemid:'EF-15-0178',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1 } },
    { nombre:'Mifarma Breña', codigo:'MIF-098', marca:'MIFARMA', formato:'EXPRESS', distrito:'Breña', calle:'Av. Arica 1230', zona:'LCENTRO', codigoDigemid:'EF-15-0098',
      staff:{ qfPorTurno:1, tecnicosPorTurno:1 } },

    // ── Lima Norte ──
    { nombre:'Mifarma Los Olivos', codigo:'MIF-156', marca:'MIFARMA', formato:'ESTANDAR', distrito:'Los Olivos', calle:'Av. Universitaria 4523', zona:'LNORTE', codigoDigemid:'EF-15-0156',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, seguridadPorTurno:1 } },
    { nombre:'Inkafarma Comas', codigo:'IKF-521', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'Comas', calle:'Av. Túpac Amaru 3890', zona:'LNORTE', codigoDigemid:'EF-15-0521',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1 } },

    // ── Lima Sur ──
    { nombre:'Mifarma Chorrillos', codigo:'MIF-203', marca:'MIFARMA', formato:'ESTANDAR', distrito:'Chorrillos', calle:'Av. Defensores del Morro 1250', zona:'LSUR', codigoDigemid:'EF-15-0203',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, repartidoresPorTurno:1 } },
    { nombre:'Inkafarma Villa El Salvador', codigo:'IKF-604', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'Villa El Salvador', calle:'Av. Revolución 780', zona:'LSUR', codigoDigemid:'EF-15-0604',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, seguridadPorTurno:1 } },

    // ── Región Centro (Huancayo) ──
    { nombre:'Inkafarma Huancayo Real', codigo:'IKF-733', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'Huancayo', ciudad:'Huancayo', departamento:'Junín', calle:'Calle Real 545', zona:'RCENTRO', codigoDigemid:'EF-12-0733',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1, repartidoresPorTurno:1 } },
    { nombre:'Mifarma Huancayo Giráldez', codigo:'MIF-318', marca:'MIFARMA', formato:'EXPRESS', distrito:'Huancayo', ciudad:'Huancayo', departamento:'Junín', calle:'Jr. Giráldez 280', zona:'RCENTRO', codigoDigemid:'EF-12-0318',
      staff:{ qfPorTurno:1, tecnicosPorTurno:1 } },

    // ── Región Norte / Sur ──
    { nombre:'Inkafarma Trujillo Centro', codigo:'IKF-810', marca:'INKAFARMA', formato:'ESTANDAR', distrito:'Trujillo', ciudad:'Trujillo', departamento:'La Libertad', calle:'Jr. Pizarro 620', zona:'RNORTE', codigoDigemid:'EF-13-0810',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1 } },
    { nombre:'Mifarma Arequipa Cercado', codigo:'MIF-905', marca:'MIFARMA', formato:'ESTANDAR', distrito:'Arequipa', ciudad:'Arequipa', departamento:'Arequipa', calle:'Av. Ejército 1010', zona:'RSUR', codigoDigemid:'EF-04-0905',
      staff:{ qfPorTurno:1, tecnicosPorTurno:2, cajerosPorTurno:1 } },

    // ── Logística y corporativo ──
    { nombre:'CEDI Villa El Salvador', codigo:'CEDI-01', marca:'CORPORATIVO', tipo:'CEDI', formato:'CEDI', distrito:'Villa El Salvador', calle:'Parque Industrial Mz. F Lote 12', zona:'LSUR',
      hours:{ apertura:'06:00', cierre:'22:00' }, staff:{ qfPorTurno:1, tecnicosPorTurno:1 } },
    { nombre:'Sede Corporativa San Isidro', codigo:'SEDE-01', marca:'CORPORATIVO', tipo:'SEDE_CORPORATIVA', formato:'ESTANDAR', distrito:'San Isidro', calle:'Av. Rivera Navarrete 501', zona:'LMODERNA',
      hours:{ apertura:'08:30', cierre:'18:00' }, staff:{ qfPorTurno:1, tecnicosPorTurno:1 } },
  ];

  const locations = [];
  for (const l of locationData) {
    locations.push(await Local.create({
      nombre: l.nombre, codigo: l.codigo, marca: l.marca,
      tipo: l.tipo || 'BOTICA', formato: l.formato,
      direccion: { calle: l.calle, distrito: l.distrito, ciudad: l.ciudad || 'Lima', departamento: l.departamento || 'Lima' },
      zona: Z[l.zona],
      horarioAtencion: l.hours || { apertura:'08:00', cierre:'22:00' },
      turnos: l.turnos || undefined,
      dotacionRequerida: l.staff,
      codigoDigemid: l.codigoDigemid,
      activo: true,
    }));
  }
  const L = Object.fromEntries(locations.map((l) => [l.codigo, l._id]));
  console.log(`${locations.length} centros de trabajo creados (14 boticas + 1 CEDI + 1 sede)`);

  // ══════════════════════════════════════════════════════════════════════════
  // EMPLEADOS
  // ══════════════════════════════════════════════════════════════════════════
  // [dni, nombres, apellidos, gen, tipo, puesto, local, zona, sueldo, ingreso, extras]
  const E = (dni, nombres, apellidos, sexo, tipoProfesional, pos, loc, zona, sueldoBasico, fechaIngreso, extra = {}) => ({
    dni, nombres, apellidos, sexo, tipoProfesional,
    posCode: pos, locCode: loc, zoneCode: zona, sueldoBasico, fechaIngreso, ...extra,
  });

  const employeeData = [
    // ══ SEDE CORPORATIVA ══
    E('45123678','Patricia','Rojas Mendoza','F','GERENCIA','GRH','SEDE-01',null,15000,'2018-03-15',{ correo:'patricia.rojas@inretail.pe', telefono:'999888001' }),
    E('48234567','Gabriela','Sánchez López','F','ADMINISTRATIVO','APL','SEDE-01',null,4200,'2021-04-01',{ correo:'gabriela.sanchez@inretail.pe', telefono:'999888031' }),
    E('48456789','Isabel','Ramos Villegas','F','ADMINISTRATIVO','APL','SEDE-01',null,4400,'2020-08-01',{ correo:'isabel.ramos@inretail.pe', telefono:'999888033' }),
    E('48123456','Claudia','Rojas Herrera','F','ADMINISTRATIVO','ASE','SEDE-01',null,3900,'2022-02-01',{ correo:'claudia.rojas@inretail.pe', telefono:'999888030' }),
    E('48567890','Renzo','Bustamante Ríos','M','ADMINISTRATIVO','ACA','SEDE-01',null,3800,'2022-07-15',{ correo:'renzo.bustamante@inretail.pe', telefono:'999888034' }),
    E('48345678','Sandra','Medina Vargas','F','ADMINISTRATIVO','GBS','SEDE-01',null,3600,'2023-01-15',{ correo:'sandra.medina@inretail.pe', telefono:'999888032' }),

    // ══ SUPERVISIÓN ZONAL ══
    E('42567891','Jorge','Ramírez Paredes','M','JEFE_ZONA','SZO',null,'LNORTE',7800,'2017-06-01',{ correo:'jorge.ramirez@inretail.pe', telefono:'999888002' }),
    E('43891234','Andrés','Chávez Espinoza','M','JEFE_ZONA','SZO',null,'LSUR',8200,'2016-01-10',{ correo:'andres.chavez@inretail.pe', telefono:'999888003' }),
    E('42334455','Silvia','Ponce Delgado','F','JEFE_ZONA','SZO',null,'LMODERNA',8500,'2017-09-01',{ correo:'silvia.ponce@inretail.pe', telefono:'999888040' }),
    E('42998877','Manuel','Quiñones Alva','M','JEFE_ZONA','SZO',null,'LCENTRO',7600,'2019-02-01',{ correo:'manuel.quinones@inretail.pe', telefono:'999888041' }),
    E('41556677','Elena','Ticona Mamani','F','JEFE_ZONA','SZO',null,'RCENTRO',7200,'2018-11-01',{ correo:'elena.ticona@inretail.pe', telefono:'964888042', ciudad:'Huancayo', departamento:'Junín' }),
    E('43112233','Óscar','Benites Rubio','M','ADMINISTRATIVO','AUC','SEDE-01',null,5800,'2019-05-15',{ correo:'oscar.benites@inretail.pe', telefono:'999888043', numeroCQF:'CQF-18902', vencimientoCQF:'2028-12-31' }),

    // ══ CEDI ══
    E('44778899','Ricardo','Salinas Muñoz','M','ADMINISTRATIVO','JCD','CEDI-01','LSUR',7500,'2019-03-01',{ correo:'ricardo.salinas@inretail.pe', telefono:'999888050' }),
    E('45667788','Nathaly','Guerrero Ríos','F','ADMINISTRATIVO','CRD','CEDI-01','LSUR',3900,'2021-09-15',{ correo:'nathaly.guerrero@inretail.pe', telefono:'999888051' }),
    E('47001122','Wilmer','Ccahuana Soto','M','OPERARIO','OPK','CEDI-01','LSUR',1550,'2023-02-01',{ telefono:'999888052' }),
    E('47002233','Jhon','Ramos Aguilar','M','OPERARIO','OPK','CEDI-01','LSUR',1500,'2024-04-15',{ telefono:'999888053' }),
    E('47003344','Yeny','Huarcaya Lima','F','OPERARIO','OPK','CEDI-01','LSUR',1480,'2024-09-01',{ telefono:'999888054' }),
    E('46009988','Julio','Ventura Palomino','M','OPERARIO','OMC','CEDI-01','LSUR',1950,'2022-06-01',{ telefono:'999888055' }),

    // ══ ADMINISTRADORES DE BOTICA ══
    E('44123567','Luis','Rodríguez Huamán','M','JEFE_LOCAL','ADB','IKF-312','LMODERNA',4000,'2020-02-01',{ correo:'luis.rodriguez@inretail.pe', telefono:'999888004' }),
    E('44567890','Mónica','Castillo Torres','F','JEFE_LOCAL','ADB','IKF-089','LMODERNA',3900,'2019-08-15',{ correo:'monica.castillo@inretail.pe', telefono:'999888005' }),
    E('44891234','Miguel','Gutiérrez Díaz','M','JEFE_LOCAL','ADB','MIF-156','LNORTE',3500,'2021-03-01',{ correo:'miguel.gutierrez@inretail.pe', telefono:'999888006' }),
    E('45234567','Paola','Quispe Mendoza','F','JEFE_LOCAL','ADB','IKF-247','LCENTRO',3700,'2021-06-15',{ correo:'paola.quispe@inretail.pe', telefono:'999888007' }),
    E('45445566','Fiorella','Camacho Núñez','F','JEFE_LOCAL','ADB','MIF-203','LSUR',3400,'2022-01-10',{ correo:'fiorella.camacho@inretail.pe', telefono:'999888008' }),
    E('45556677','Édgar','Rojas Inga','M','JEFE_LOCAL','ADB','IKF-733','RCENTRO',3200,'2021-11-01',{ correo:'edgar.rojas@inretail.pe', telefono:'964888009', ciudad:'Huancayo', departamento:'Junín' }),

    // ══ QUÍMICOS FARMACÉUTICOS — Directores Técnicos ══
    E('46123456','Carlos','García Quispe','M','QF','QFD','IKF-247','LCENTRO',4800,'2021-08-01',{ correo:'carlos.garcia@inretail.pe', telefono:'999888010', numeroCQF:'CQF-24589', vencimientoCQF:'2027-12-31', esDirectorTecnico:true }),
    E('46345678','Roberto','Espinoza Salazar','M','QF','QFD','IKF-312','LMODERNA',5200,'2019-11-01',{ correo:'roberto.espinoza@inretail.pe', telefono:'999888012', numeroCQF:'CQF-19876', vencimientoCQF:'2027-09-30', esDirectorTecnico:true }),
    E('46456789','Valentina','Herrera Delgado','F','QF','QFD','IKF-089','LMODERNA',4500,'2021-05-01',{ correo:'valentina.herrera@inretail.pe', telefono:'999888013', numeroCQF:'CQF-28743', vencimientoCQF:'2028-03-31', esDirectorTecnico:true }),
    E('46567890','César','Huamán Rojas','M','QF','QFD','MIF-156','LNORTE',4000,'2023-07-01',{ correo:'cesar.huaman@inretail.pe', telefono:'999888014', numeroCQF:'CQF-35120', vencimientoCQF:'2028-12-31', esDirectorTecnico:true }),
    E('46678901','Fernando','Villegas Ramos','M','QF','QFD','MIF-203','LSUR',4700,'2020-09-01',{ correo:'fernando.villegas@inretail.pe', telefono:'999888015', numeroCQF:'CQF-22456', vencimientoCQF:'2027-06-30', esDirectorTecnico:true }),
    E('46789012','Raúl','Martínez Sánchez','M','QF','QFD','MIF-441','LMODERNA',4300,'2022-08-15',{ correo:'raul.martinez@inretail.pe', telefono:'999888016', numeroCQF:'CQF-29871', vencimientoCQF:'2028-09-30', esDirectorTecnico:true }),
    E('46890123','Alberto','García Paredes','M','QF','QFD','IKF-604','LSUR',4400,'2020-11-01',{ correo:'alberto.garcia@inretail.pe', telefono:'999888017', numeroCQF:'CQF-33210', vencimientoCQF:'2028-06-30', esDirectorTecnico:true }),
    E('46901234','Lucía','Ayala Ríos','F','QF','QFD','IKF-178','LCENTRO',4200,'2022-02-01',{ correo:'lucia.ayala@inretail.pe', telefono:'999888018', numeroCQF:'CQF-30045', vencimientoCQF:'2026-11-30', esDirectorTecnico:true }),
    E('46112233','Katherine','Vílchez Arana','F','QF','QFD','IKF-521','LNORTE',4100,'2023-01-15',{ correo:'katherine.vilchez@inretail.pe', telefono:'999888019', numeroCQF:'CQF-36780', vencimientoCQF:'2029-01-31', esDirectorTecnico:true }),
    E('46223344','Nadia','Poma Quispe','F','QF','QFD','MIF-098','LCENTRO',3800,'2024-03-01',{ correo:'nadia.poma@inretail.pe', telefono:'999888060', numeroCQF:'CQF-38901', vencimientoCQF:'2029-06-30', esDirectorTecnico:true }),

    // ── QF de provincia: Huancayo (Región Centro) ──
    E('20334455','Sofía','Baldeón Lazo','F','QF','QFD','IKF-733','RCENTRO',3900,'2022-05-02',{ correo:'sofia.baldeon@inretail.pe', telefono:'964888061', numeroCQF:'CQF-31998', vencimientoCQF:'2028-08-31', esDirectorTecnico:true, ciudad:'Huancayo', departamento:'Junín' }),
    E('20445566','Iván','Meza Canchari','M','QF','QFD','MIF-318','RCENTRO',3700,'2023-09-01',{ correo:'ivan.meza@inretail.pe', telefono:'964888062', numeroCQF:'CQF-37455', vencimientoCQF:'2029-03-31', esDirectorTecnico:true, ciudad:'Huancayo', departamento:'Junín' }),
    E('18223344','Gonzalo','Rivera Cárdenas','M','QF','QFD','IKF-810','RNORTE',4000,'2021-07-01',{ correo:'gonzalo.rivera@inretail.pe', telefono:'944888063', numeroCQF:'CQF-27310', vencimientoCQF:'2028-02-28', esDirectorTecnico:true, ciudad:'Trujillo', departamento:'La Libertad' }),
    E('29556677','Milagros','Cáceres Zeballos','F','QF','QFD','MIF-905','RSUR',4100,'2020-10-01',{ correo:'milagros.caceres@inretail.pe', telefono:'954888064', numeroCQF:'CQF-25188', vencimientoCQF:'2027-10-31', esDirectorTecnico:true, ciudad:'Arequipa', departamento:'Arequipa' }),

    // ══ QF ASISTENTES (cobertura de horario extendido) ══
    E('46234567','María Elena','Chávez Torres','F','QF','QFA','IKF-247','LCENTRO',3400,'2022-04-15',{ correo:'mariaelena.chavez@inretail.pe', telefono:'999888011', numeroCQF:'CQF-31245', vencimientoCQF:'2028-06-30' }),
    E('46334455','Bruno','Salcedo Ita','M','QF','QFA','IKF-312','LMODERNA',3300,'2023-06-01',{ correo:'bruno.salcedo@inretail.pe', telefono:'999888065', numeroCQF:'CQF-34567', vencimientoCQF:'2028-11-30' }),
    E('20556677','Andrea','Ñahui Sedano','F','QF','QFA','IKF-733','RCENTRO',3000,'2024-02-15',{ correo:'andrea.nahui@inretail.pe', telefono:'964888066', numeroCQF:'CQF-39120', vencimientoCQF:'2029-08-31', ciudad:'Huancayo', departamento:'Junín' }),

    // ══ TÉCNICOS EN FARMACIA ══
    E('47123456','Ana Sofía','Vargas Castillo','F','TECNICO','TCF','IKF-312','LMODERNA',1900,'2024-03-01',{ telefono:'999888020' }),
    E('47234567','Diego','Flores Martínez','M','TECNICO','TCF','IKF-247','LCENTRO',1800,'2024-06-15',{ telefono:'999888021' }),
    E('47345678','Laura','Paredes García','F','TECNICO','TCF','IKF-247','LCENTRO',2100,'2022-09-01',{ telefono:'999888022' }),
    E('47456789','Pedro','Salazar Ramírez','M','TECNICO','TCF','MIF-156','LNORTE',1700,'2024-01-15',{ telefono:'999888023' }),
    E('47567890','Diana','López Flores','F','TECNICO','TCF','IKF-312','LMODERNA',1600,'2025-06-01',{ telefono:'999888024' }),
    E('47678901','Hugo','Torres Castillo','M','TECNICO','TCF','MIF-156','LNORTE',2000,'2023-04-01',{ telefono:'999888025' }),
    E('47789012','Rosa','Delgado Medina','F','TECNICO','TCF','IKF-178','LCENTRO',1950,'2023-07-15',{ telefono:'999888026' }),
    E('47890123','Alejandra','Rodríguez Chávez','F','TECNICO','TCF','IKF-089','LMODERNA',1800,'2024-08-01',{ telefono:'999888027' }),
    E('47901234','Kevin','Espinoza Vega','M','TECNICO','TCF','MIF-441','LMODERNA',1750,'2024-05-01',{ telefono:'999888070' }),
    E('47112233','Melissa','Anchante Cruz','F','TECNICO','TCF','MIF-203','LSUR',1850,'2023-10-01',{ telefono:'999888071' }),
    E('47223344','Brayan','Chuquimango Vela','M','TECNICO','TCF','IKF-604','LSUR',1650,'2024-11-01',{ telefono:'999888072' }),
    E('47334455','Cinthia','Orihuela Lazo','F','TECNICO','TCF','IKF-521','LNORTE',1700,'2024-07-15',{ telefono:'999888073' }),
    E('20667788','Yesenia','Camborda Ríos','F','TECNICO','TCF','IKF-733','RCENTRO',1600,'2023-03-01',{ telefono:'964888074', ciudad:'Huancayo', departamento:'Junín' }),
    E('20778899','Marco','Sánchez Veliz','M','TECNICO','TCF','IKF-733','RCENTRO',1550,'2024-08-15',{ telefono:'964888075', ciudad:'Huancayo', departamento:'Junín' }),
    E('20889900','Rocío','Aliaga Bendezú','F','TECNICO','TCF','MIF-318','RCENTRO',1500,'2025-01-15',{ telefono:'964888076', ciudad:'Huancayo', departamento:'Junín' }),
    E('18334455','Piero','Vergara Castro','M','TECNICO','TCF','IKF-810','RNORTE',1600,'2023-12-01',{ telefono:'944888077', ciudad:'Trujillo', departamento:'La Libertad' }),
    E('29667788','Carmen','Zúñiga Portugal','F','TECNICO','TCF','MIF-905','RSUR',1650,'2023-05-15',{ telefono:'954888078', ciudad:'Arequipa', departamento:'Arequipa' }),

    // ══ TRAINEES ══
    E('75112233','Nicolás','Ayvar Quispe','M','TECNICO','TRN','IKF-312','LMODERNA',1200,'2026-07-01',{ telefono:'999888080', esPracticante:true, fechaFinPracticas:'2026-09-29' }),
    E('75223344','Fabiola','Retamozo Cárdenas','F','TECNICO','TRN','IKF-247','LCENTRO',1200,'2026-08-01',{ telefono:'999888081', esPracticante:true, fechaFinPracticas:'2026-10-30' }),
    E('75334455','Jean Pierre','Ávila Soto','M','TECNICO','TRN','IKF-733','RCENTRO',1130,'2026-08-15',{ telefono:'964888082', esPracticante:true, fechaFinPracticas:'2026-11-13', ciudad:'Huancayo', departamento:'Junín' }),

    // ══ CAJEROS ══
    E('72112233','Milagros','Rivas Tello','F','OPERARIO','CAJ','IKF-312','LMODERNA',1450,'2023-08-01',{ telefono:'999888090' }),
    E('72223344','Álvaro','Ninahuanca Rojas','M','OPERARIO','CAJ','IKF-247','LCENTRO',1400,'2024-02-15',{ telefono:'999888091' }),
    E('72334455','Estefany','Lozano Pérez','F','OPERARIO','CAJ','MIF-156','LNORTE',1380,'2024-06-01',{ telefono:'999888092' }),
    E('72445566','Jazmín','Palomino Cusi','F','OPERARIO','CAJ','IKF-733','RCENTRO',1300,'2024-04-01',{ telefono:'964888093', ciudad:'Huancayo', departamento:'Junín' }),

    // ══ DERMOCONSULTORAS ══
    E('73112233','Camila','Bravo Miranda','F','OPERARIO','DER','IKF-312','LMODERNA',2000,'2022-11-01',{ telefono:'999888100' }),
    E('73223344','Andrea','Castro Leiva','F','OPERARIO','DER','IKF-089','LMODERNA',1850,'2023-09-15',{ telefono:'999888101' }),
    E('73334455','Lucero','Farfán Ojeda','F','OPERARIO','DER','MIF-441','LMODERNA',1800,'2024-01-08',{ telefono:'999888102' }),

    // ══ AUXILIARES DE ALMACÉN ══
    E('74112233','Christian','Mendoza Ríos','M','OPERARIO','AXA','IKF-312','LMODERNA',1600,'2023-05-01',{ telefono:'999888110' }),
    E('74223344','Deysi','Huamaní Quispe','F','OPERARIO','AXA','IKF-247','LCENTRO',1550,'2024-03-15',{ telefono:'999888111' }),

    // ══ PREVENCIONISTAS ══
    E('76112233','Walter','Cárdenas Loayza','M','OPERARIO','PRV','IKF-312','LMODERNA',1600,'2022-04-01',{ telefono:'999888120' }),
    E('76223344','Rubén','Ipanaqué Sandoval','M','OPERARIO','PRV','MIF-156','LNORTE',1500,'2023-11-01',{ telefono:'999888121' }),
    E('76334455','Elías','Quintana Mory','M','OPERARIO','PRV','IKF-247','LCENTRO',1550,'2023-02-15',{ telefono:'999888122' }),
    E('76445566','Néstor','Zavaleta Príncipe','M','OPERARIO','PRV','IKF-604','LSUR',1480,'2024-05-01',{ telefono:'999888123' }),

    // ══ MOTORIZADOS ══
    E('77112233','Anthony','Sifuentes Ramos','M','OPERARIO','MOT','IKF-312','LMODERNA',1750,'2023-07-01',{ telefono:'999888130' }),
    E('77223344','Jorge Luis','Pariona Huamán','M','OPERARIO','MOT','IKF-312','LMODERNA',1700,'2024-02-01',{ telefono:'999888131' }),
    E('77334455','Frank','Mautino Osorio','M','OPERARIO','MOT','MIF-203','LSUR',1650,'2024-09-01',{ telefono:'999888132' }),
    E('77445566','Luis Ángel','Chocce Berrocal','M','OPERARIO','MOT','IKF-733','RCENTRO',1500,'2024-10-15',{ telefono:'964888133', ciudad:'Huancayo', departamento:'Junín' }),
  ];

  const employees = [];
  for (const e of employeeData) {
    employees.push(await Empleado.create({
      dni: e.dni, nombres: e.nombres, apellidos: e.apellidos, sexo: e.sexo,
      telefono: e.telefono, correo: e.correo,
      tipoProfesional: e.tipoProfesional,
      numeroCQF: e.numeroCQF, vencimientoCQF: e.vencimientoCQF ? d(e.vencimientoCQF) : undefined,
      esDirectorTecnico: e.esDirectorTecnico || false,
      esPracticante: e.esPracticante || false,
      fechaFinPracticas: e.fechaFinPracticas ? d(e.fechaFinPracticas) : undefined,
      fechaIngreso: d(e.fechaIngreso),
      cargoActual: P[e.posCode],
      localActual: e.locCode ? L[e.locCode] : undefined,
      zona: e.zoneCode ? Z[e.zoneCode] : undefined,
      sueldoBasico: e.sueldoBasico,
      estado: 'ACTIVO',
      // Afiliacion previsional: en el mercado peruano predomina la AFP
      sistemaPensiones: pick(['AFP_INTEGRA','AFP_PRIMA','AFP_PROFUTURO','AFP_HABITAT','AFP_INTEGRA','ONP']),
      tieneHijos: Math.random() < 0.45,
      direccion: { distrito: e.ciudad || 'Lima', ciudad: e.ciudad || 'Lima', departamento: e.departamento || 'Lima' },
    }));
  }
  // Índice por DNI para referencias posteriores
  const byDni = Object.fromEntries(employees.map((e) => [e.dni, e]));
  console.log(`${employees.length} empleados creados`);

  // ── Responsables de zona, local y dirección técnica ──
  const zoneManagers = { LNORTE:'42567891', LSUR:'43891234', LMODERNA:'42334455', LCENTRO:'42998877', RCENTRO:'41556677' };
  for (const [codigo, dni] of Object.entries(zoneManagers)) {
    await Zona.findByIdAndUpdate(Z[codigo], { responsable: byDni[dni]._id });
  }

  const boticaManagers = { 'IKF-312':'44123567', 'IKF-089':'44567890', 'MIF-156':'44891234', 'IKF-247':'45234567', 'MIF-203':'45445566', 'IKF-733':'45556677', 'CEDI-01':'44778899' };
  for (const [codigo, dni] of Object.entries(boticaManagers)) {
    await Local.findByIdAndUpdate(L[codigo], { responsable: byDni[dni]._id });
  }

  // Director Técnico de cada botica (responsable sanitario ante DIGEMID)
  for (const emp of employees.filter((e) => e.esDirectorTecnico && e.localActual)) {
    await Local.findByIdAndUpdate(emp.localActual, { directorTecnico: emp._id });
  }
  console.log('Responsables zonales, administradores de botica y directores técnicos asignados');

  // ══════════════════════════════════════════════════════════════════════════
  // REFUERZO DE DOTACIÓN
  // Completa cada botica hasta el mínimo que exige su formato para cubrir los
  // siete días sin vulnerar la jornada de 48 horas ni el descanso semanal.
  // ══════════════════════════════════════════════════════════════════════════
  const { weeklyStaffNeed } = require('../src/config/formats');
  const { shiftRoleOf } = require('../src/services/staffing');

  const NOMBRES_M = ['Aldo','Bruno','Cristian','Dante','Elmer','Fabián','Gerson','Héctor','Iván','Joel','Kevin','Lenin','Martín','Nilton','Omar','Percy','Raúl','Saúl','Tomás','Víctor','Wilder','Yuri'];
  const NOMBRES_F = ['Ana','Betsy','Carla','Dalia','Elsa','Flor','Gina','Hilda','Ivonne','Jhoana','Karen','Lidia','Marisol','Noelia','Olga','Pamela','Rocío','Sara','Tania','Úrsula','Vanessa','Yulissa'];
  const APELLIDOS = ['Alvarado','Bautista','Cabrera','Dávila','Escobar','Fernández','Gamarra','Hinostroza','Ibáñez','Jiménez','Lévano','Maldonado','Navarro','Oyola','Pizarro','Quiroz','Rivas','Sarmiento','Tapia','Ugarte','Valdez','Zapata','Bermúdez','Carrión','Del Solar','Enríquez'];

  // Puesto, tipo profesional y rango salarial de cada refuerzo
  const REINFORCE_SPEC = {
    QF:             { pos:'QFA', tipo:'QF',       sueldo:[2900,3600], cqf:true },
    TECNICO:        { pos:'TCF', tipo:'TECNICO',  sueldo:[1500,2100] },
    CAJERO:         { pos:'CAJ', tipo:'OPERARIO', sueldo:[1250,1550] },
    DERMOCONSULTOR: { pos:'DER', tipo:'OPERARIO', sueldo:[1600,2100] },
    AUX_ALMACEN:    { pos:'AXA', tipo:'OPERARIO', sueldo:[1350,1650] },
    PREVENCIONISTA: { pos:'PRV', tipo:'OPERARIO', sueldo:[1350,1650] },
    MOTORIZADO:     { pos:'MOT', tipo:'OPERARIO', sueldo:[1450,1850] },
    OPERARIO_CEDI:  { pos:'OPK', tipo:'OPERARIO', sueldo:[1400,1800] },
    COORD_RUTAS:    { pos:'CRD', tipo:'ADMINISTRATIVO', sueldo:[3000,4200] },
  };

  const usedDni = new Set(employees.map((e) => e.dni));
  const nextDni = () => {
    let dni;
    do { dni = String(rnd(60000000, 79999999)); } while (usedDni.has(dni));
    usedDni.add(dni);
    return dni;
  };

  // Boticas que se completan; Mifarma Breña queda deliberadamente sub-dotada
  // para que el sistema exponga la brecha real que ya detectó la auditoría.
  const REINFORCED = ['IKF-312', 'IKF-247', 'IKF-089', 'MIF-156', 'IKF-733', 'MIF-203', 'MIF-318', 'CEDI-01'];
  let reinforced = 0;

  for (const codigo of REINFORCED) {
    const local = await Local.findById(L[codigo]);
    const need = weeklyStaffNeed(local);

    const current = await Empleado.find({ localActual: local._id, estado: 'ACTIVO' })
      .populate('cargoActual', 'rolPorDefecto');
    const have = {};
    for (const e of current) {
      const r = shiftRoleOf(e);
      // El QF Asistente también cubre la exigencia de Químico Farmacéutico
      const key = r === 'QF_ASISTENTE' ? 'QF' : r;
      have[key] = (have[key] || 0) + 1;
    }

    for (const [rol, { minStaff }] of Object.entries(need)) {
      const spec = REINFORCE_SPEC[rol];
      if (!spec) continue;
      const missing = minStaff - (have[rol] || 0);

      for (let i = 0; i < missing; i++) {
        const female = Math.random() < 0.55;
        const nombres = pick(female ? NOMBRES_F : NOMBRES_M);
        const apellidos = `${pick(APELLIDOS)} ${pick(APELLIDOS)}`;
        const hireYear = rnd(2021, 2025);

        const emp = await Empleado.create({
          dni: nextDni(),
          nombres, apellidos,
          sexo: female ? 'F' : 'M',
          telefono: `9${rnd(10000000, 99999999)}`,
          tipoProfesional: spec.tipo,
          numeroCQF: spec.cqf ? `CQF-${rnd(30000, 45000)}` : undefined,
          vencimientoCQF: spec.cqf ? d(`${rnd(2027, 2029)}-${String(rnd(1, 12)).padStart(2, '0')}-28`) : undefined,
          fechaIngreso: d(`${hireYear}-${String(rnd(1, 12)).padStart(2, '0')}-01`),
          cargoActual: P[spec.pos],
          localActual: local._id,
          zona: local.zona,
          sueldoBasico: rnd(spec.sueldo[0], spec.sueldo[1]),
          estado: 'ACTIVO',
          sistemaPensiones: pick(['AFP_INTEGRA','AFP_PRIMA','AFP_PROFUTURO','AFP_HABITAT','ONP']),
          tieneHijos: Math.random() < 0.45,
          direccion: {
            distrito: local.direccion.distrito,
            ciudad: local.direccion.ciudad,
            departamento: local.direccion.departamento,
          },
        });
        employees.push(emp);
        byDni[emp.dni] = emp;
        reinforced++;
      }
    }
  }
  console.log(`${reinforced} empleados de refuerzo creados para cubrir la dotación de cada formato`);
  console.log(`   dotación total: ${employees.length} empleados`);

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRATOS
  // ══════════════════════════════════════════════════════════════════════════
  const contracts = [];
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const fechaInicio = new Date(emp.fechaIngreso);

    if (['GERENCIA', 'JEFE_ZONA'].includes(emp.tipoProfesional) || emp.sueldoBasico >= 4000) {
      contracts.push({ empleado: emp._id, tipo:'INDETERMINADO', fechaInicio, sueldo: emp.sueldoBasico, cargo: emp.cargoActual, estado:'VIGENTE' });
    } else if (emp.esPracticante) {
      const fechaFin = emp.fechaFinPracticas || new Date(fechaInicio.getTime() + 90 * 86400000);
      contracts.push({ empleado: emp._id, tipo:'PRACTICAS', fechaInicio, fechaFin, sueldo: emp.sueldoBasico, cargo: emp.cargoActual, estado: fechaFin < new Date() ? 'VENCIDO' : 'VIGENTE' });
    } else {
      // Los contratos a plazo fijo se renuevan cada año: el vencimiento vigente
      // cae en los próximos doce meses. Una minoría queda por vencer o vencida,
      // que es la cartera real que Recursos Humanos debe resolver.
      const sorteo = Math.random();
      const diasAlVencimiento = sorteo < 0.06 ? rnd(-25, -1)      // rezago por resolver
        : sorteo < 0.18 ? rnd(1, 30)                              // decisión inminente
          : rnd(45, 350);                                          // con holgura
      const fechaFin = new Date(Date.now() + diasAlVencimiento * 86400000);

      // Renovaciones previas, coherentes con la antigüedad
      const aniosServicio = (Date.now() - fechaInicio.getTime()) / (365.25 * 86400000);
      const renovaciones = [];
      for (let n = Math.floor(aniosServicio); n >= 1; n--) {
        const anterior = new Date(fechaFin);
        anterior.setFullYear(anterior.getFullYear() - n);
        const nuevo = new Date(anterior);
        nuevo.setFullYear(nuevo.getFullYear() + 1);
        renovaciones.push({ fechaFinAnterior: anterior, nuevaFechaFin: nuevo, renovadoEn: anterior, notas: 'Renovación anual' });
      }

      const estado = diasAlVencimiento < 0 ? 'VENCIDO' : diasAlVencimiento <= 30 ? 'POR_VENCER' : 'VIGENTE';
      contracts.push({
        empleado: emp._id, tipo:'PLAZO_FIJO', fechaInicio, fechaFin,
        sueldo: emp.sueldoBasico, cargo: emp.cargoActual, estado,
        historialRenovaciones: renovaciones,
      });
    }
  }
  await Contrato.insertMany(contracts);
  console.log(`${contracts.length} contratos creados`);

  // ══════════════════════════════════════════════════════════════════════════
  // USUARIOS — uno por cada rol del catálogo organizacional
  // ══════════════════════════════════════════════════════════════════════════
  const pwd = await bcrypt.hash(require('./lib/clave-demo').claveDemo(), 12);
  const U = (correo, rol, dni) => ({ correo, contrasena: pwd, rol, empleado: byDni[dni]._id });

  const users = await Usuario.insertMany([
    // Corporativo
    U('admin@pharmatalent.pe',                'ADMIN',                 '45123678'),
    U('gerente.rrhh@pharmatalent.pe',         'GERENTE_RRHH',          '45123678'),
    U('planillas@pharmatalent.pe',            'ANALISTA_NOMINAS',      '48234567'),
    U('seleccion@pharmatalent.pe',            'ANALISTA_SELECCION',    '48123456'),
    U('capacitacion@pharmatalent.pe',         'ANALISTA_CAPACITACION', '48567890'),
    U('bienestar@pharmatalent.pe',            'GESTOR_BIENESTAR',      '48345678'),
    // Zonal
    U('zona.norte@pharmatalent.pe',           'JEFE_ZONA',             '42567891'),
    U('zona.moderna@pharmatalent.pe',         'JEFE_ZONA',             '42334455'),
    U('zona.huancayo@pharmatalent.pe',        'JEFE_ZONA',             '41556677'),
    U('auditor@pharmatalent.pe',              'AUDITOR_CALIDAD',       '43112233'),
    // CEDI
    U('jefe.cedi@pharmatalent.pe',            'JEFE_CEDI',             '44778899'),
    U('rutas@pharmatalent.pe',                'COORD_RUTAS',           '45667788'),
    U('operario.cedi@pharmatalent.pe',        'OPERARIO_CEDI',         '47001122'),
    // Botica — Lima
    U('admin.miraflores@pharmatalent.pe',     'ADMIN_BOTICA',          '44123567'),
    U('admin.sanmiguel@pharmatalent.pe',      'ADMIN_BOTICA',          '45234567'),
    U('qf.sanmiguel@pharmatalent.pe',         'QF',                    '46123456'),
    U('qf.miraflores@pharmatalent.pe',        'QF',                    '46345678'),
    U('qf.asistente@pharmatalent.pe',         'QF_ASISTENTE',          '46234567'),
    U('tecnico@pharmatalent.pe',              'TECNICO',               '47123456'),
    U('trainee@pharmatalent.pe',              'TRAINEE',               '75112233'),
    U('cajero@pharmatalent.pe',               'CAJERO',                '72112233'),
    U('dermoconsultora@pharmatalent.pe',      'DERMOCONSULTOR',        '73112233'),
    U('almacen@pharmatalent.pe',              'AUX_ALMACEN',           '74112233'),
    U('prevencionista@pharmatalent.pe',       'PREVENCIONISTA',        '76112233'),
    U('motorizado@pharmatalent.pe',           'MOTORIZADO',            '77112233'),
    // Botica — Huancayo (Región Centro)
    U('admin.huancayo@pharmatalent.pe',       'ADMIN_BOTICA',          '45556677'),
    U('qf.huancayo@pharmatalent.pe',          'QF',                    '20334455'),
    U('tecnico.huancayo@pharmatalent.pe',     'TECNICO',               '20667788'),
  ]);
  console.log(`${users.length} usuarios creados (todos los roles del catálogo)`);
  const userByEmail = Object.fromEntries(users.map((u) => [u.correo, u]));

  // ══════════════════════════════════════════════════════════════════════════
  // CRONOGRAMAS DE TURNOS — dotación según el formato de cada local
  // ══════════════════════════════════════════════════════════════════════════
  const staffing = require('../src/services/staffing');
  const { formatOf } = require('../src/config/formats');

  // Semana en curso (domingo a sábado)
  const inicioSemana = new Date();
  inicioSemana.setDate(inicioSemana.getDate() - inicioSemana.getDay());
  inicioSemana.setHours(0, 0, 0, 0);

  const scheduledCodes = ['IKF-312', 'IKF-247', 'IKF-089', 'MIF-156', 'MIF-098', 'IKF-733', 'MIF-318', 'MIF-203', 'CEDI-01'];
  let shiftTotal = 0, criticalTotal = 0;

  for (const codigo of scheduledCodes) {
    const local = await Local.findById(L[codigo]);
    const staff = await Empleado.find({ localActual: local._id, estado: 'ACTIVO' })
      .populate('cargoActual', 'nombre codigo rolPorDefecto');
    if (!staff.length) continue;

    for (const offset of [-7, 0, 7]) {      // semana pasada, actual y siguiente
      const inicio = new Date(inicioSemana);
      inicio.setDate(inicio.getDate() + offset);
      const fin = new Date(inicio);
      fin.setDate(fin.getDate() + 6);

      const horario = await Horario.create({
        local: local._id,
        inicioSemana: inicio, finSemana: fin,
        formato: local.formato,
        estado: offset <= 0 ? 'PUBLICADO' : 'BORRADOR',
        creadoPor: userByEmail['admin.miraflores@pharmatalent.pe']._id,
        publicadoPor: offset <= 0 ? userByEmail['zona.moderna@pharmatalent.pe']._id : undefined,
        publicadoEn: offset <= 0 ? new Date() : undefined,
      });

      const planned = staffing.generateWeek(local, staff, inicio);
      await Turno.insertMany(planned.map((s) => ({ ...s, horario: horario._id })));

      horario.validacion = staffing.summarizeSchedule(planned);
      await horario.save();

      shiftTotal += planned.length;
      criticalTotal += horario.validacion.conteoCriticas;
    }
  }
  console.log(`${scheduledCodes.length * 3} cronogramas creados · ${shiftTotal} turnos · ${criticalTotal} sin cobertura de QF`);

  // ══════════════════════════════════════════════════════════════════════════
  // ASISTENCIA — derivada de los turnos efectivamente asignados
  // Sólo se marcan días pasados: la jornada de hoy queda abierta para que el
  // empleado registre su entrada desde el sistema.
  // ══════════════════════════════════════════════════════════════════════════
  const hoyCero = new Date(); hoyCero.setHours(0, 0, 0, 0);
  const turnosPasados = await Turno.find({ fecha: { $lt: hoyCero } }).select('fecha tipoTurno horaInicio horaFin local asignaciones');

  const attendance = [];
  for (const turno of turnosPasados) {
    const [hIni, mIni] = turno.horaInicio.split(':').map(Number);
    const [hFin, mFin] = turno.horaFin.split(':').map(Number);

    for (const asignacion of turno.asignaciones) {
      // Ausencias y licencias ocasionales
      if (Math.random() < 0.05) {
        attendance.push({
          empleado: asignacion.empleado, local: turno.local, fecha: turno.fecha,
          estado: pick(['AUSENTE', 'PERMISO', 'VACACIONES']),
        });
        continue;
      }

      // La entrada se compara con el inicio real de SU turno
      const prevista = new Date(turno.fecha); prevista.setHours(hIni, mIni, 0, 0);
      // La mayoría llega a tiempo; la tardanza es la excepción, no la norma
      const desvio = Math.random() < 0.18 ? rnd(8, 35) : rnd(-14, 4);
      const marcaEntrada = new Date(prevista.getTime() + desvio * 60000);
      const salidaPrevista = new Date(turno.fecha); salidaPrevista.setHours(hFin, mFin, 0, 0);
      if (salidaPrevista <= prevista) salidaPrevista.setDate(salidaPrevista.getDate() + 1);
      const marcaSalida = new Date(salidaPrevista.getTime() + rnd(-10, 45) * 60000);

      const minutosTardanza = Math.max(0, Math.round((marcaEntrada - prevista) / 60000));
      const horasExtra = Math.max(0, Math.round(((marcaSalida - salidaPrevista) / 3600000) * 100) / 100);

      attendance.push({
        empleado: asignacion.empleado, local: turno.local, fecha: turno.fecha,
        marcaEntrada, marcaSalida,
        estado: minutosTardanza > 5 ? 'TARDANZA' : 'PRESENTE',
        minutosTardanza: minutosTardanza > 5 ? minutosTardanza : 0,
        horasExtra,
        horasTrabajadas: Math.round(((marcaSalida - marcaEntrada) / 3600000) * 100) / 100,
      });
    }
  }
  await Asistencia.insertMany(attendance);
  console.log(`${attendance.length} registros de asistencia derivados de ${turnosPasados.length} turnos pasados`);

  // Resumen de cobertura por formato
  for (const codigo of ['IKF-312', 'IKF-247', 'MIF-098', 'IKF-733']) {
    const loc = await Local.findById(L[codigo]);
    const sch = await Horario.findOne({ local: loc._id }).sort({ inicioSemana: 1 });
    console.log(`   ${loc.nombre.padEnd(28)} ${String(loc.formato).padEnd(9)} cobertura ${sch?.validacion?.porcentajeCobertura ?? 0}%`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VACACIONES
  // ══════════════════════════════════════════════════════════════════════════
  const vacations = await Vacacion.insertMany([
    { empleado: byDni['46345678']._id, tipo:'VACACIONES', fechaInicio:d('2026-10-05'), fechaFin:d('2026-10-19'), diasTotales:15, estado:'PENDIENTE', motivo:'Vacaciones anuales' },
    { empleado: byDni['47123456']._id, tipo:'VACACIONES', fechaInicio:d('2026-09-15'), fechaFin:d('2026-09-28'), diasTotales:14, estado:'APROBADO', motivo:'Descanso familiar' },
    { empleado: byDni['47345678']._id, tipo:'LICENCIA_MEDICA', fechaInicio:d('2026-08-25'), fechaFin:d('2026-08-29'), diasTotales:5, estado:'APROBADO', motivo:'Intervención dental' },
    { empleado: byDni['46567890']._id, tipo:'VACACIONES', fechaInicio:d('2026-11-01'), fechaFin:d('2026-11-15'), diasTotales:15, estado:'PENDIENTE', motivo:'Viaje familiar' },
    { empleado: byDni['20334455']._id, tipo:'VACACIONES', fechaInicio:d('2026-09-10'), fechaFin:d('2026-09-24'), diasTotales:15, estado:'PENDIENTE', motivo:'Vacaciones anuales — requiere cobertura de QF en Huancayo' },
    { empleado: byDni['72112233']._id, tipo:'PERMISO',    fechaInicio:d('2026-09-03'), fechaFin:d('2026-09-03'), diasTotales:1,  estado:'APROBADO', motivo:'Trámite personal' },
    { empleado: byDni['77112233']._id, tipo:'VACACIONES', fechaInicio:d('2026-12-20'), fechaFin:d('2026-12-31'), diasTotales:12, estado:'PENDIENTE', motivo:'Fin de año' },
  ]);
  console.log(`${vacations.length} solicitudes de vacaciones creadas`);

  // ══════════════════════════════════════════════════════════════════════════
  // EVALUACIONES DE DESEMPEÑO
  // ══════════════════════════════════════════════════════════════════════════
  const evaluables = employees.filter((e) => ['QF','TECNICO'].includes(e.tipoProfesional)).slice(0, 16);
  const evaluations = evaluables.map((emp) => ({
    empleado: emp._id,
    evaluador: byDni['44123567']._id,
    periodo: { nombre:'2026-Q2', fechaInicio:d('2026-04-01'), fechaFin:d('2026-06-30') },
    kpis: [
      { nombre:'Puntualidad', descripcion:'Porcentaje de días sin tardanza', meta:95, real:rnd(78,99), peso:25, unidad:'%' },
      { nombre:'Atención al paciente', descripcion:'Encuesta de satisfacción', meta:90, real:rnd(74,98), peso:30, unidad:'%' },
      { nombre:'Cumplimiento normativo', descripcion:'Adherencia a protocolos DIGEMID', meta:100, real:rnd(84,100), peso:25, unidad:'%' },
      { nombre:'Trabajo en equipo', descripcion:'Evaluación por pares', meta:85, real:rnd(70,97), peso:20, unidad:'%' },
    ],
    fortalezas:'Buen desempeño general y disposición al trabajo en equipo',
    areasDeMejora:'Reforzar puntualidad y registro de temperatura en cadena de frío',
    estado:'REVISADO',
  }));
  await Evaluacion.insertMany(evaluations);
  console.log(`${evaluations.length} evaluaciones creadas`);

  // ══════════════════════════════════════════════════════════════════════════
  // CAPACITACIONES — BPA, DIGEMID e inducción
  // ══════════════════════════════════════════════════════════════════════════
  const trainings = [];
  for (const emp of employees.filter((e) => e.tipoProfesional === 'QF')) {
    trainings.push({
      empleado: emp._id, nombre:'Actualización normativa DIGEMID 2026', tipo:'DIGEMID',
      proveedor:'Colegio Químico Farmacéutico del Perú',
      fechaProgramada: d('2026-03-15'), fechaCompletado: d('2026-03-15'),
      horasDuracion: 16, puntaje: rnd(80, 100), estado:'COMPLETADA',
      numeroCertificado: `CERT-DGM-${rnd(1000, 9999)}`,
      venceEn: d('2027-03-15'),
    });
  }
  for (const emp of employees.filter((e) => e.tipoProfesional === 'TECNICO').slice(0, 12)) {
    trainings.push({
      empleado: emp._id, nombre:'Buenas Prácticas de Dispensación', tipo:'BPA',
      proveedor:'Universidad Peruana Cayetano Heredia',
      fechaProgramada: d('2026-05-10'), fechaCompletado: d('2026-05-10'),
      horasDuracion: 8, puntaje: rnd(70, 98), estado:'COMPLETADA',
    });
  }
  for (const emp of employees.filter((e) => e.esPracticante)) {
    trainings.push({
      empleado: emp._id, nombre:'Inducción Farmacias Peruanas', tipo:'INDUCCION',
      proveedor:'Escuela Corporativa InRetail',
      fechaProgramada: d('2026-08-20'), horasDuracion: 24, estado:'EN_CURSO',
    });
  }
  trainings.push(
    { empleado: byDni['76112233']._id, nombre:'Prevención de pérdidas y manejo de conflictos', tipo:'SEGURIDAD', proveedor:'Escuela Corporativa InRetail', fechaProgramada:d('2026-09-05'), horasDuracion:6, estado:'PROGRAMADA' },
    { empleado: byDni['44123567']._id, nombre:'Liderazgo de equipos en punto de venta', tipo:'LIDERAZGO', proveedor:'Escuela Corporativa InRetail', fechaProgramada:d('2026-09-12'), horasDuracion:12, estado:'PROGRAMADA' },
    { empleado: byDni['45556677']._id, nombre:'Liderazgo de equipos en punto de venta', tipo:'LIDERAZGO', proveedor:'Escuela Corporativa InRetail', fechaProgramada:d('2026-09-12'), horasDuracion:12, estado:'PROGRAMADA' },
  );
  await Capacitacion.insertMany(trainings);
  console.log(`${trainings.length} capacitaciones creadas`);

  // ══════════════════════════════════════════════════════════════════════════
  // REQUERIMIENTOS DE PERSONAL — flujo jerárquico en distintos estados
  // ══════════════════════════════════════════════════════════════════════════
  const reqData = [
    { pos:'TCF', loc:'IKF-733', zona:'RCENTRO', qty:1, motivo:'COBERTURA_VACACIONES', urgencia:'ALTA',
      justificacion:'La QF Sofía Baldeón sale de vacaciones el 10/09. Se requiere refuerzo técnico para sostener la atención.',
      by:'admin.huancayo@pharmatalent.pe', estado:'SOLICITADO', requeridoPara:'2026-09-08' },
    { pos:'QFD', loc:'MIF-098', zona:'LCENTRO', qty:1, motivo:'REEMPLAZO', urgencia:'CRITICA',
      justificacion:'Se requiere QF Director Técnico adicional para cubrir el turno tarde. Sin cobertura el local no puede operar por norma DIGEMID.',
      by:'admin.sanmiguel@pharmatalent.pe', estado:'APROBADO_ZONAL', requeridoPara:'2026-09-15', sueldo:4200 },
    { pos:'TCF', loc:'IKF-312', zona:'LMODERNA', qty:2, motivo:'INCREMENTO_DOTACION', urgencia:'MEDIA',
      justificacion:'Incremento sostenido de tickets en turno tarde durante el último trimestre.',
      by:'admin.miraflores@pharmatalent.pe', estado:'EN_BUSQUEDA', requeridoPara:'2026-10-01', sueldo:1800 },
    { pos:'MOT', loc:'IKF-733', zona:'RCENTRO', qty:1, motivo:'INCREMENTO_DOTACION', urgencia:'MEDIA',
      justificacion:'Crecimiento del delivery en Huancayo tras la campaña regional.',
      by:'admin.huancayo@pharmatalent.pe', estado:'EN_BUSQUEDA', requeridoPara:'2026-10-10', sueldo:1500 },
    { pos:'CAJ', loc:'MIF-203', zona:'LSUR', qty:1, motivo:'REEMPLAZO', urgencia:'BAJA',
      justificacion:'Renuncia del cajero del turno mañana.',
      by:'admin.miraflores@pharmatalent.pe', estado:'CUBIERTO', requeridoPara:'2026-08-01' },
  ];

  const requisitions = [];
  for (const r of reqData) {
    const openedDaysAgo = r.status === 'CUBIERTO' ? 38 : r.status === 'EN_BUSQUEDA' ? 21 : r.status === 'APROBADO_ZONAL' ? 12 : 4;
    const openedAt = new Date(Date.now() - openedDaysAgo * 86400000);
    const item = new Requerimiento({
      cargo: P[r.pos], local: L[r.loc], zona: Z[r.zona], cantidad: r.qty,
      motivo: r.motivo, justificacion: r.justificacion, urgencia: r.urgencia,
      requeridoPara: d(r.requeridoPara), sueldoOfrecido: r.sueldo,
      solicitadoPor: userByEmail[r.by]._id,
      estado: r.status,
    });
    if (['APROBADO_ZONAL','EN_BUSQUEDA','CUBIERTO'].includes(r.status)) {
      item.aprobaciones.push({ paso:'ZONAL', usuario: userByEmail['zona.moderna@pharmatalent.pe']._id, decision:'APROBADO', comentario:'Presupuesto validado', fecha: new Date(openedAt.getTime() + 3 * 86400000) });
    }
    if (['EN_BUSQUEDA','CUBIERTO'].includes(r.status)) {
      item.aprobaciones.push({ paso:'SELECCION', usuario: userByEmail['seleccion@pharmatalent.pe']._id, decision:'APROBADO', comentario:'Búsqueda iniciada', fecha: new Date(openedAt.getTime() + 5 * 86400000) });
      item.reclutadorAsignado = userByEmail['seleccion@pharmatalent.pe']._id;
    }
    if (r.status === 'CUBIERTO') item.cerradoEn = new Date(openedAt.getTime() + 26 * 86400000);
    await item.save();
    // Retrodata la creación para que los indicadores de tiempo sean realistas.
    // Se usa el driver nativo: Mongoose marca `creadoEn` como inmutable.
    await Requerimiento.collection.updateOne({ _id: item._id }, { $set: { creadoEn: openedAt } });
    requisitions.push(item);
  }
  console.log(`${requisitions.length} requerimientos de personal creados`);

  // ══════════════════════════════════════════════════════════════════════════
  // CANDIDATOS — embudo de reclutamiento
  // ══════════════════════════════════════════════════════════════════════════
  const reqMiraflores = requisitions[2];  // 2 técnicos para Miraflores
  const reqHuancayo = requisitions[3];    // motorizado en Huancayo
  const reqQF = requisitions[1];          // QF para Breña

  const candData = [
    { dni:'71223344', nombres:'Estefani', apellidos:'Loayza Bautista', tipo:'TECNICO', req:reqMiraflores, etapa:'POSTULADO', origen:'BOLSA_UNIVERSITARIA', exp:1, edu:'Técnico en Farmacia — IDAT' },
    { dni:'71334455', nombres:'Bryan', apellidos:'Cueva Alarcón', tipo:'TECNICO', req:reqMiraflores, etapa:'POSTULADO', origen:'PORTAL_WEB', exp:0, edu:'Egresado Técnico en Farmacia — SENATI' },
    { dni:'71445566', nombres:'Yoselin', apellidos:'Cerrón Matos', tipo:'TECNICO', req:reqMiraflores, etapa:'FILTRO_CV', origen:'REFERIDO', exp:2, edu:'Técnico en Farmacia — CEPEA' },
    { dni:'71556677', nombres:'Renato', apellidos:'Yupanqui Silva', tipo:'TECNICO', req:reqMiraflores, etapa:'ENTREVISTA', origen:'PORTAL_WEB', exp:3, edu:'Técnico en Farmacia — IPAE', iScore:82 },
    { dni:'71667788', nombres:'Nayeli', apellidos:'Ochoa Ramírez', tipo:'TECNICO', req:reqMiraflores, etapa:'EVALUACION_TECNICA', origen:'FERIA_LABORAL', exp:2, edu:'Técnico en Farmacia — Avansys', iScore:88, tScore:91 },
    { dni:'71778899', nombres:'Marcelo', apellidos:'Prado Ynga', tipo:'TECNICO', req:reqMiraflores, etapa:'OFERTA', origen:'REFERIDO', exp:4, edu:'Técnico en Farmacia — CIBERTEC', iScore:93, tScore:95, sueldo:1900 },
    { dni:'71889900', nombres:'Karen', apellidos:'Bustinza Puma', tipo:'TECNICO', req:reqMiraflores, etapa:'DESCARTADO', origen:'PORTAL_WEB', exp:0, edu:'Secundaria completa', reject:'No cumple el requisito de título técnico' },

    { dni:'70112233', nombres:'Héctor', apellidos:'Ramos Chávez', tipo:'OPERARIO', req:reqHuancayo, etapa:'ENTREVISTA', origen:'REDES_SOCIALES', exp:2, edu:'Secundaria completa — licencia A-I vigente', iScore:79 },
    { dni:'70223344', nombres:'Efraín', apellidos:'Huaraca Ccanto', tipo:'OPERARIO', req:reqHuancayo, etapa:'FILTRO_CV', origen:'REFERIDO', exp:1, edu:'Secundaria completa — moto propia' },

    { dni:'69112233', nombres:'Paola', apellidos:'Ninaquispe Alarcón', tipo:'QF', req:reqQF, etapa:'EVALUACION_TECNICA', origen:'BASE_INTERNA', exp:5, edu:'QF — UNMSM', cqf:'CQF-34112', digemid:true, iScore:90, tScore:88 },
    { dni:'69223344', nombres:'Gustavo', apellidos:'Del Águila Torres', tipo:'QF', req:reqQF, etapa:'ENTREVISTA', origen:'PORTAL_WEB', exp:2, edu:'QF — UNFV', cqf:'CQF-40233', digemid:false, iScore:75 },
    { dni:'69334455', nombres:'Ariana', apellidos:'Solís Pumacayo', tipo:'QF', req:reqQF, etapa:'POSTULADO', origen:'BOLSA_UNIVERSITARIA', exp:0, edu:'Bachiller en Farmacia y Bioquímica — UPCH' },
  ];

  // Días en proceso según lo avanzada que esté la etapa
  const STAGE_AGE = { POSTULADO: 3, FILTRO_CV: 8, ENTREVISTA: 14, EVALUACION_TECNICA: 19, OFERTA: 24, DESCARTADO: 11, DESISTIO: 11, CONTRATADO: 30 };

  const candidates = [];
  for (const c of candData) {
    candidates.push(await Candidato.create({
      dni: c.dni, nombres: c.nombres, apellidos: c.apellidos,
      correo: `${c.nombres.toLowerCase().replace(/ /g,'')}.${c.apellidos.split(' ')[0].toLowerCase()}@correo.com`,
      telefono: `9${rnd(10000000, 99999999)}`,
      requerimiento: c.req._id, origen: c.origen,
      tipoProfesional: c.tipo, numeroCQF: c.cqf, tieneCapacitacionDigemid: c.digemid || false,
      anosExperiencia: c.exp, formacion: c.edu,
      etapa: c.etapa,
      puntajeEntrevista: c.iScore, puntajeTecnico: c.tScore,
      sueldoEsperado: c.sueldo,
      motivoRechazo: c.reject,
      historialEtapas: [{ etapa:'POSTULADO', usuario: userByEmail['seleccion@pharmatalent.pe']._id, nota:'Postulación registrada' }],
    }));
    const last = candidates[candidates.length - 1];
    await Candidato.collection.updateOne(
      { _id: last._id },
      { $set: { creadoEn: new Date(Date.now() - (STAGE_AGE[c.etapa] || 5) * 86400000) } }
    );
  }
  console.log(`${candidates.length} candidatos creados en el embudo`);

  // ══════════════════════════════════════════════════════════════════════════
  // DESCANSOS MÉDICOS Y SUBSIDIOS ESSALUD
  // ══════════════════════════════════════════════════════════════════════════
  const leaveData = [
    { dni:'47345678', tipo:'ENFERMEDAD_COMUN', diagnostico:'J06.9 — Infección respiratoria aguda', inicio:'2026-08-25', fin:'2026-08-29', center:'Clínica Internacional', doctor:'Dra. Rosa Ampuero', cmp:'CMP-45123', estado:'VALIDADO' },
    { dni:'47456789', tipo:'ACCIDENTE_TRABAJO', diagnostico:'S62.5 — Fractura de falange (caída en almacén)', inicio:'2026-07-10', fin:'2026-08-20', center:'EsSalud — Hospital Rebagliati', doctor:'Dr. Luis Talledo', cmp:'CMP-31002', estado:'VALIDADO', citt:'CITT-2026-004512' },
    { dni:'73112233', tipo:'MATERNIDAD', diagnostico:'Descanso pre y post natal', inicio:'2026-06-01', fin:'2026-09-26', center:'EsSalud — Hospital Almenara', doctor:'Dra. Carmen Bejarano', cmp:'CMP-27845', estado:'VALIDADO', citt:'CITT-2026-003988' },
    { dni:'20667788', tipo:'ENFERMEDAD_COMUN', diagnostico:'A09 — Gastroenteritis', inicio:'2026-08-18', fin:'2026-08-20', center:'Clínica Ortega — Huancayo', doctor:'Dr. Iván Rojas', cmp:'CMP-52201', estado:'REGISTRADO' },
    { dni:'47001122', tipo:'ACCIDENTE_COMUN', diagnostico:'S93.4 — Esguince de tobillo', inicio:'2026-08-22', fin:'2026-09-05', center:'Clínica San Pablo', doctor:'Dr. Enrique Salas', cmp:'CMP-38119', estado:'VALIDADO' },
  ];

  const leaves = [];
  for (const l of leaveData) {
    const emp = byDni[l.dni];
    const inicio = d(l.inicio), fin = d(l.fin);
    const diasTotales = Math.floor((fin - inicio) / 86400000) + 1;
    const leave = new DescansoMedico({
      empleado: emp._id, tipo: l.tipo, diagnostico: l.diagnostico,
      centroMedico: l.center, nombreMedico: l.doctor, cmpMedico: l.cmp,
      fechaInicio: inicio, fechaFin: fin, diasTotales,
      estado: l.estado,
      registradoPor: userByEmail['bienestar@pharmatalent.pe']._id,
      validadoPor: l.estado === 'VALIDADO' ? userByEmail['bienestar@pharmatalent.pe']._id : undefined,
      citt: l.citt ? { numero: l.citt, emitido: true, fechaEmision: fin } : undefined,
    });
    leave.calcularSubsidio(0, emp.sueldoBasico / 30);
    await leave.save();
    leaves.push(leave);
  }
  console.log(`${leaves.length} descansos médicos creados (${leaves.filter(l=>l.subsidio.aplica).length} con subsidio EsSalud)`);

  // ══════════════════════════════════════════════════════════════════════════
  // AUDITORÍAS DE CALIDAD — visitas inopinadas DIGEMID
  // ══════════════════════════════════════════════════════════════════════════
  const auditData = [
    { loc:'IKF-312', fecha:'2026-08-12', tdPresent:true, hallazgos:[
      { categoria:'ROTULADO_VENCIMIENTOS', severidad:'MENOR', descripcion:'Dos productos con rotulado de vencimiento poco legible en góndola 4', accionCorrectiva:'Reetiquetado inmediato', fechaVencimiento:'2026-08-19', resuelto:true },
    ]},
    { loc:'IKF-247', fecha:'2026-08-14', tdPresent:true, hallazgos:[
      { categoria:'CADENA_FRIO', severidad:'MAYOR', descripcion:'Registro de temperatura del refrigerador incompleto los días 08 y 09 de agosto', accionCorrectiva:'Reforzar el registro por turno y designar responsable', fechaVencimiento:'2026-08-28', resuelto:false },
      { categoria:'DOCUMENTACION', severidad:'OBSERVACION', descripcion:'Libro de reclamaciones sin actualizar en el mostrador', resuelto:true },
    ]},
    { loc:'MIF-098', fecha:'2026-08-19', tdPresent:false, hallazgos:[
      { categoria:'PRESENCIA_QF', severidad:'CRITICA', descripcion:'Local operando sin Director Técnico durante el turno tarde', accionCorrectiva:'Cobertura inmediata con QF de local vecino y apertura de requerimiento de personal', fechaVencimiento:'2026-09-02', resuelto:false },
      { categoria:'PRODUCTOS_CONTROLADOS', severidad:'MAYOR', descripcion:'Armario de psicotrópicos sin registro de apertura del día', accionCorrectiva:'Restablecer bitácora de apertura y cierre', fechaVencimiento:'2026-08-30', resuelto:false },
    ]},
    { loc:'IKF-733', fecha:'2026-08-08', tdPresent:true, hallazgos:[
      { categoria:'BPA_DISPENSACION', severidad:'MENOR', descripcion:'Falta señalización de zona de dispensación de recetas', accionCorrectiva:'Instalar señalética', fechaVencimiento:'2026-08-22', resuelto:true },
    ]},
    { loc:'MIF-156', fecha:'2026-07-30', tdPresent:true, hallazgos:[] },
    { loc:'IKF-089', fecha:'2026-08-21', tdPresent:true, hallazgos:[
      { categoria:'INFRAESTRUCTURA', severidad:'MENOR', descripcion:'Luminaria del almacén interno fundida', accionCorrectiva:'Reemplazo de luminaria', fechaVencimiento:'2026-09-04', resuelto:false },
      { categoria:'PERSONAL_CAPACITADO', severidad:'OBSERVACION', descripcion:'Un técnico sin constancia vigente de BPA', resuelto:false },
    ]},
    // Resto de la red — el plan anual cubre todas las boticas
    { loc:'MIF-441', fecha:'2026-07-24', tdPresent:true, hallazgos:[] },
    { loc:'IKF-178', fecha:'2026-08-05', tdPresent:true, hallazgos:[
      { categoria:'DOCUMENTACION', severidad:'OBSERVACION', descripcion:'Manual de BPA desactualizado a la versión 2026', accionCorrectiva:'Descargar versión vigente del portal corporativo', fechaVencimiento:'2026-08-19', resuelto:true },
    ]},
    { loc:'IKF-521', fecha:'2026-08-16', tdPresent:true, hallazgos:[
      { categoria:'ROTULADO_VENCIMIENTOS', severidad:'MENOR', descripcion:'Tres productos próximos a vencer sin señalización de rotación', accionCorrectiva:'Aplicar FEFO y señalizar', fechaVencimiento:'2026-08-30', resuelto:false },
    ]},
    { loc:'IKF-604', fecha:'2026-07-18', tdPresent:true, hallazgos:[] },
    { loc:'MIF-318', fecha:'2026-08-10', tdPresent:true, hallazgos:[
      { categoria:'CADENA_FRIO', severidad:'MENOR', descripcion:'Termómetro del refrigerador sin certificado de calibración vigente', accionCorrectiva:'Solicitar calibración al proveedor', fechaVencimiento:'2026-09-10', resuelto:false },
    ]},
    { loc:'IKF-810', fecha:'2026-08-03', tdPresent:true, hallazgos:[] },
    { loc:'MIF-905', fecha:'2026-08-13', tdPresent:true, hallazgos:[
      { categoria:'BPA_DISPENSACION', severidad:'OBSERVACION', descripcion:'Recetas archivadas sin orden cronológico', accionCorrectiva:'Reordenar archivo de recetas', fechaVencimiento:'2026-08-27', resuelto:true },
    ]},
  ];

  const audits = [];
  for (const a of auditData) {
    const loc = await Local.findById(L[a.loc]).select('zona directorTecnico');
    const audit = new VisitaAuditoria({
      local: L[a.loc], zona: loc.zona,
      auditor: userByEmail['auditor@pharmatalent.pe']._id,
      fechaVisita: d(a.fecha), tipo:'INOPINADA',
      directorTecnicoPresente: a.tdPresent,
      directorTecnicoDeTurno: loc.directorTecnico,
      hallazgos: a.hallazgos.map((f) => ({ ...f, fechaVencimiento: f.fechaVencimiento ? d(f.fechaVencimiento) : undefined, resueltoEn: f.resuelto ? d(a.fecha) : undefined })),
      resumen: a.hallazgos.length ? `Visita con ${a.hallazgos.length} hallazgo(s).` : 'Visita sin hallazgos. Local conforme.',
      estado: a.hallazgos.every((f) => f.resuelto) ? 'CERRADA' : 'EN_SEGUIMIENTO',
    });
    audit.calcularPuntaje();
    await audit.save();
    await Local.findByIdAndUpdate(L[a.loc], { puntajeUltimaAuditoria: audit.puntaje, fechaUltimaAuditoria: audit.fechaVisita });
    audits.push(audit);
  }
  console.log(`${audits.length} auditorías de calidad creadas`);

  // ══════════════════════════════════════════════════════════════════════════
  // PLANILLA — los tres últimos períodos, consolidados por el motor
  // ══════════════════════════════════════════════════════════════════════════
  const motorPlanilla = require('../src/services/payroll');

  const periodos = [];
  for (let atras = 2; atras >= 0; atras--) {
    const f = new Date();
    f.setMonth(f.getMonth() - atras);
    periodos.push(`${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`);
  }

  const conPuesto = await Empleado.find({ estado: 'ACTIVO' }).populate('cargoActual', 'nombre rolPorDefecto');
  const boletas = [];
  for (const periodo of periodos) {
    // Los meses cerrados se dan por pagados; el más reciente queda por aprobar
    const esCerrado = periodo !== periodos[periodos.length - 1];
    for (const emp of conPuesto) {
      const calculada = await motorPlanilla.computePayroll(emp, periodo);
      boletas.push({
        ...calculada,
        estado: esCerrado ? 'PAGADO' : 'CALCULADO',
        calculadoEn: new Date(),
        aprobadoPor: esCerrado ? userByEmail['gerente.rrhh@pharmatalent.pe']._id : undefined,
        pagadoEn: esCerrado ? new Date() : undefined,
      });
    }
  }
  await Boleta.insertMany(boletas);

  const neto = boletas
    .filter((b) => b.periodo === periodos[periodos.length - 1])
    .reduce((a, b) => a + b.netoAPagar, 0);
  console.log(`${boletas.length} boletas calculadas en ${periodos.length} períodos (${periodos.join(', ')})`);
  console.log(`   neto del último período: S/ ${Math.round(neto).toLocaleString('es-PE')}`);

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICACIONES
  // ══════════════════════════════════════════════════════════════════════════
  const notifications = [
    { usuario: userByEmail['zona.huancayo@pharmatalent.pe']._id, tipo:'REQUERIMIENTO', prioridad:'ALTA',
      titulo:'Requerimiento pendiente de aprobación',
      mensaje:'Inkafarma Huancayo Real solicita 1 Técnico en Farmacia para cubrir vacaciones de la Directora Técnica.' },
    { usuario: userByEmail['auditor@pharmatalent.pe']._id, tipo:'AUDITORIA', prioridad:'URGENTE',
      titulo:'Auditoría NO CONFORME',
      mensaje:'Mifarma Breña operó sin Director Técnico. Requiere seguimiento antes del 02/09.' },
    { usuario: userByEmail['bienestar@pharmatalent.pe']._id, tipo:'BIENESTAR', prioridad:'ALTA',
      titulo:'Subsidio EsSalud por tramitar',
      mensaje:'Camila Bravo Miranda supera los 20 días de incapacidad. Corresponde canje de CITT.' },
    { usuario: userByEmail['seleccion@pharmatalent.pe']._id, tipo:'RECLUTAMIENTO', prioridad:'ALTA',
      titulo:'Candidato en etapa de oferta',
      mensaje:'Marcelo Prado Ynga (Técnico en Farmacia) espera respuesta de oferta para Inkafarma Miraflores.' },
    { usuario: userByEmail['qf.huancayo@pharmatalent.pe']._id, tipo:'CAPACITACION', prioridad:'MEDIA',
      titulo:'Certificación DIGEMID vigente',
      mensaje:'Su actualización normativa DIGEMID 2026 vence el 15/03/2027.' },
    { usuario: userByEmail['admin.miraflores@pharmatalent.pe']._id, tipo:'TURNO', prioridad:'MEDIA',
      titulo:'Horario semanal pendiente de publicar',
      mensaje:'El horario de la semana del 31/08 aún no ha sido publicado.' },
  ];
  await Notificacion.insertMany(notifications);
  console.log(`${notifications.length} notificaciones creadas`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log('   SEED COMPLETADO — PharmaTalent');
  console.log('══════════════════════════════════════════════════');
  console.log(`\n  Empleados : ${employees.length}`);
  console.log(`  Centros       : ${locations.length} (14 boticas, 1 CEDI, 1 sede)`);
  console.log(`  Zonas         : ${zones.length}`);
  console.log(`  Puestos       : ${positions.length}`);
  console.log(`  Usuarios      : ${users.length}`);

  console.log('\n─── ACCESOS (contraseña única: la de CLAVE_DEMO en .env) ───\n');
  const grouped = users.reduce((acc, u) => { (acc[u.rol] ||= []).push(u.correo); return acc; }, {});
  for (const [rol, emails] of Object.entries(grouped)) {
    console.log(`  ${rol.padEnd(22)} ${emails.join('\n' + ' '.repeat(25))}`);
  }
  console.log('\n  Sugeridos para la demostración:');
  console.log('    admin@pharmatalent.pe            → visión nacional (CEO / Dirección)');
  console.log('    zona.huancayo@pharmatalent.pe    → supervisión de la Región Centro');
  console.log('    admin.huancayo@pharmatalent.pe   → Administrador de Botica en Huancayo');
  console.log('    qf.huancayo@pharmatalent.pe      → Director Técnico en Huancayo');
  console.log('    auditor@pharmatalent.pe          → mapa de riesgo regulatorio DIGEMID');
  console.log('    seleccion@pharmatalent.pe        → embudo de reclutamiento');
  console.log('    bienestar@pharmatalent.pe        → descansos médicos y subsidios');
  console.log('\n  mongodb://localhost:27017/pharmatalent\n');

  await mongoose.disconnect();
}

seed().catch((err) => { console.error('Error en seed:', err); process.exit(1); });
