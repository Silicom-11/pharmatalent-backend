const router = require('express').Router();
const Empleado = require('../models/Empleado');
const Local = require('../models/Local');
const Contrato = require('../models/Contrato');
const Vacacion = require('../models/Vacacion');
const Asistencia = require('../models/Asistencia');
const Turno = require('../models/Turno');
const Requerimiento = require('../models/Requerimiento');
const DescansoMedico = require('../models/DescansoMedico');
const VisitaAuditoria = require('../models/VisitaAuditoria');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');

router.use(auth);

const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

/**
 * Resumen ejecutivo, acotado al alcance del rol:
 *  · ADMIN / GERENTE_RRHH / analistas → toda la cadena
 *  · Supervisor de Zona               → los locales de su zona
 *  · Administrador de Botica / QF     → su propio centro de trabajo
 */
router.get('/summary', scopeByRole, async (req, res, next) => {
  try {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const today = startOfToday();
    const tomorrow = new Date(today.getTime() + 86400000);

    const scoped = req.scope && !req.scope.isNational;
    const locIds = req.scope?.locationIds || [];
    const empFilter = scoped ? { localActual: { $in: locIds } } : {};
    const locFilter = scoped ? { _id: { $in: locIds }, activo: true } : { activo: true };

    // El QF lo exigen las boticas; el CEDI opera sin él por formato. Contar sus
    // turnos como «sin QF» inflaba el riesgo regulatorio del panel
    const boticas = (await Local.find({ ...locFilter, tipo: 'BOTICA' }).select('_id').lean()).map((l) => l._id);

    // Empleados dentro del alcance, para acotar contratos y vacaciones
    const scopedEmpIds = scoped
      ? (await Empleado.find(empFilter).select('_id').lean()).map((e) => e._id)
      : null;
    const byEmp = scopedEmpIds ? { empleado: { $in: scopedEmpIds } } : {};

    const [
      totalEmployees, activeEmployees, totalQFs, traineeCount,
      totalLocations, contractsExpiring, pendingVacations,
      todayAttendance, todayLate, shiftsWithoutQF,
      openRequisitions, activeLeaves, nonCompliantAudits, byType,
    ] = await Promise.all([
      Empleado.countDocuments(empFilter),
      Empleado.countDocuments({ ...empFilter, estado: 'ACTIVO' }),
      Empleado.countDocuments({ ...empFilter, tipoProfesional: 'QF', estado: 'ACTIVO' }),
      Empleado.countDocuments({ ...empFilter, esPracticante: true, estado: 'ACTIVO' }),
      Local.countDocuments(locFilter),
      Contrato.countDocuments({ ...byEmp, fechaFin: { $lte: in30, $gte: now }, estado: { $in: ['VIGENTE', 'POR_VENCER'] } }),
      Vacacion.countDocuments({ ...byEmp, estado: 'PENDIENTE' }),
      Asistencia.countDocuments({ ...(scoped ? { local: { $in: locIds } } : {}), fecha: { $gte: today, $lt: tomorrow }, estado: { $in: ['PRESENTE', 'TARDANZA'] } }),
      Asistencia.countDocuments({ ...(scoped ? { local: { $in: locIds } } : {}), fecha: { $gte: today, $lt: tomorrow }, estado: 'TARDANZA' }),
      Turno.countDocuments({ local: { $in: boticas }, fecha: { $gte: today, $lt: tomorrow }, tieneQF: false }),
      Requerimiento.countDocuments({ ...(scoped ? { local: { $in: locIds } } : {}), estado: { $nin: ['CUBIERTO', 'CANCELADO', 'RECHAZADO'] } }),
      DescansoMedico.countDocuments({ ...byEmp, fechaInicio: { $lte: now }, fechaFin: { $gte: now }, estado: { $ne: 'RECHAZADO' } }),
      VisitaAuditoria.countDocuments({ ...(scoped ? { local: { $in: locIds } } : {}), resultado: 'NO_CONFORME', estado: { $ne: 'CERRADA' } }),
      Empleado.aggregate([
        { $match: { ...empFilter, estado: 'ACTIVO' } },
        { $group: { _id: '$tipoProfesional', count: { $sum: 1 } } },
      ]),
    ]);

    // Boticas sin Director Técnico asignado — riesgo regulatorio directo
    const withoutTD = await Local.countDocuments({
      ...locFilter, tipo: 'BOTICA', directorTecnico: { $in: [null, undefined] },
    });

    res.json({
      scope: {
        tipo: req.scope?.scopeType || 'NATIONAL',
        locationName: req.scope?.locationName || null,
        isNational: !scoped,
      },
      employees: { total: totalEmployees, activo: activeEmployees, qfs: totalQFs, trainees: traineeCount, byType },
      locations: { total: totalLocations, withoutTechnicalDirector: withoutTD },
      alerts: {
        contractsExpiring,
        pendingVacations,
        shiftsWithoutQF,
        openRequisitions,
        activeLeaves,
        nonCompliantAudits,
      },
      today: { attendance: todayAttendance, late: todayLate },
    });
  } catch (err) { next(err); }
});

/** Cobertura de Químico Farmacéutico por turno del día */
router.get('/qf-coverage', scopeByRole, async (req, res, next) => {
  try {
    const today = startOfToday();
    const tomorrow = new Date(today.getTime() + 86400000);

    const filter = { fecha: { $gte: today, $lt: tomorrow } };
    if (req.scope && !req.scope.isNational) filter.local = { $in: req.scope.locationIds || [] };

    const turnos = await Turno.find(filter)
      .populate('local', 'nombre marca codigo dotacionRequerida')
      .populate('asignaciones.empleado', 'nombres apellidos');

    res.json(turnos.map((s) => {
      const requerido = s.local?.dotacionRequerida?.qfPorTurno || 1;
      return {
        local: s.local?.nombre,
        marca: s.local?.marca,
        tipoTurno: s.tipoTurno,
        tieneQF: s.tieneQF,
        conteoQF: s.conteoQF,
        requerido,
        estado: !s.tieneQF ? 'ROJO' : s.conteoQF >= requerido ? 'VERDE' : 'AMARILLO',
        assignedStaff: s.asignaciones.map((a) => ({
          nombre: a.empleado ? `${a.empleado.nombres} ${a.empleado.apellidos}` : 'N/A',
          rol: a.rol,
        })),
      };
    }));
  } catch (err) { next(err); }
});

/**
 * Tablero del Supervisor de Zona: una fila por botica con
 * dotación, asistencia del día, riesgo regulatorio y requerimientos abiertos.
 */
router.get('/zone-overview', scopeByRole, async (req, res, next) => {
  try {
    const today = startOfToday();
    const tomorrow = new Date(today.getTime() + 86400000);

    const filter = { activo: true, tipo: 'BOTICA' };
    if (req.scope && !req.scope.isNational) filter._id = { $in: req.scope.locationIds || [] };

    const locations = await Local.find(filter)
      .populate('responsable', 'nombres apellidos')
      .populate('directorTecnico', 'nombres apellidos vencimientoCQF')
      .select('nombre marca codigo dotacionRequerida responsable directorTecnico puntajeUltimaAuditoria')
      .lean();

    const rows = await Promise.all(locations.map(async (l) => {
      const [headcount, conteoQF, present, openReqs] = await Promise.all([
        Empleado.countDocuments({ localActual: l._id, estado: 'ACTIVO' }),
        Empleado.countDocuments({ localActual: l._id, tipoProfesional: 'QF', estado: 'ACTIVO' }),
        Asistencia.countDocuments({ local: l._id, fecha: { $gte: today, $lt: tomorrow }, estado: { $in: ['PRESENTE', 'TARDANZA'] } }),
        Requerimiento.countDocuments({ local: l._id, estado: { $nin: ['CUBIERTO', 'CANCELADO', 'RECHAZADO'] } }),
      ]);

      const td = l.directorTecnico;
      const licenseExpired = td?.vencimientoCQF ? new Date(td.vencimientoCQF) < new Date() : false;

      return {
        _id: l._id, nombre: l.nombre, marca: l.marca, codigo: l.codigo,
        responsable: l.responsable ? `${l.responsable.nombres} ${l.responsable.apellidos}` : null,
        directorTecnico: td ? `${td.nombres} ${td.apellidos}` : null,
        licenseExpired,
        headcount, conteoQF, present, openReqs,
        auditScore: l.puntajeUltimaAuditoria ?? null,
        alert: !td || licenseExpired ? 'SIN_DIRECTOR_TECNICO'
          : conteoQF < (l.dotacionRequerida?.qfPorTurno || 1) ? 'QF_INSUFICIENTE'
            : (l.puntajeUltimaAuditoria != null && l.puntajeUltimaAuditoria < 70) ? 'AUDITORIA'
              : null,
      };
    }));

    res.json({
      locations: rows.sort((a, b) => (a.alert ? 0 : 1) - (b.alert ? 0 : 1)),
      totals: {
        locations: rows.length,
        headcount: rows.reduce((a, r) => a + r.headcount, 0),
        present: rows.reduce((a, r) => a + r.present, 0),
        withAlert: rows.filter((r) => r.alert).length,
      },
    });
  } catch (err) { next(err); }
});

/**
 * Tablero del Centro de Distribución.
 *
 * El CEDI no opera con formato comercial ni Director Técnico: lo que importa es
 * la dotación de operarios por turno, la carga de trabajo y las boticas que
 * abastece. Se mide contra la propia plantilla, no contra un roster de botica.
 */
router.get('/cedi-overview', scopeByRole, async (req, res, next) => {
  try {
    const hoy = startOfToday();
    const manana = new Date(hoy.getTime() + 86400000);

    // El centro del usuario, o el CEDI de la cadena para quien tiene alcance nacional
    let cedi = null;
    if (req.scope && !req.scope.isNational && req.scope.locationId) {
      cedi = await Local.findOne({ _id: req.scope.locationId, tipo: 'CEDI' });
    }
    if (!cedi) cedi = await Local.findOne({ tipo: 'CEDI', activo: true });
    if (!cedi) return res.status(404).json({ error: 'No hay centro de distribución registrado' });

    const plantilla = await Empleado.find({ localActual: cedi._id, estado: { $ne: 'CESADO' } })
      .populate('cargoActual', 'nombre codigo rolPorDefecto')
      .select('nombres apellidos tipoProfesional estado cargoActual');

    const porPuesto = plantilla.reduce((acc, e) => {
      const p = e.cargoActual?.nombre || e.tipoProfesional;
      acc[p] = (acc[p] || 0) + 1;
      return acc;
    }, {});

    const idsPlantilla = plantilla.map((e) => e._id);

    const [marcasHoy, ausentesHoy, turnosHoy, requerimientos, contratosPorVencer] = await Promise.all([
      Asistencia.find({ empleado: { $in: idsPlantilla }, fecha: { $gte: hoy, $lt: manana } })
        .populate('empleado', 'nombres apellidos')
        .select('empleado estado marcaEntrada marcaSalida minutosTardanza horasTrabajadas'),
      Vacacion.countDocuments({
        empleado: { $in: idsPlantilla },
        estado: { $in: ['APROBADO', 'EN_CURSO'] },
        fechaInicio: { $lte: manana }, fechaFin: { $gte: hoy },
      }),
      Turno.find({ local: cedi._id, fecha: { $gte: hoy, $lt: manana } }).select('tipoTurno asignaciones'),
      Requerimiento.countDocuments({ local: cedi._id, estado: { $nin: ['CUBIERTO', 'CANCELADO', 'RECHAZADO'] } }),
      Contrato.countDocuments({
        empleado: { $in: idsPlantilla },
        fechaFin: { $lte: new Date(Date.now() + 30 * 86400000), $gte: new Date() },
        estado: { $in: ['VIGENTE', 'POR_VENCER'] },
      }),
    ]);

    const presentes = marcasHoy.filter((m) => ['PRESENTE', 'TARDANZA'].includes(m.estado));
    const activos = plantilla.filter((e) => e.estado === 'ACTIVO').length;

    // Boticas que este centro abastece: toda la red activa de la cadena
    const [boticas, porZona] = await Promise.all([
      Local.countDocuments({ tipo: 'BOTICA', activo: true }),
      Local.aggregate([
        { $match: { tipo: 'BOTICA', activo: true } },
        { $lookup: { from: 'zonas', localField: 'zona', foreignField: '_id', as: 'z' } },
        { $unwind: { path: '$z', preserveNullAndEmptyArrays: true } },
        { $group: { _id: '$z.nombre', boticas: { $sum: 1 } } },
        { $sort: { boticas: -1 } },
      ]),
    ]);

    res.json({
      centro: {
        _id: cedi._id, nombre: cedi.nombre, codigo: cedi.codigo,
        distrito: cedi.direccion?.distrito,
        horario: cedi.horarioAtencion,
      },
      plantilla: {
        total: plantilla.length,
        activos,
        ausentesHoy,
        porPuesto,
        detalle: plantilla.map((e) => ({
          _id: e._id,
          nombre: `${e.nombres} ${e.apellidos}`,
          cargo: e.cargoActual?.nombre || e.tipoProfesional,
          estado: e.estado,
        })),
      },
      jornada: {
        turnosProgramados: turnosHoy.length,
        asignacionesHoy: turnosHoy.reduce((a, t) => a + (t.asignaciones?.length || 0), 0),
        marcaron: presentes.length,
        tardanzas: marcasHoy.filter((m) => m.estado === 'TARDANZA').length,
        horasAcumuladas: Math.round(marcasHoy.reduce((a, m) => a + (m.horasTrabajadas || 0), 0) * 10) / 10,
        cobertura: activos ? Math.round((presentes.length / activos) * 100) : 0,
      },
      abastecimiento: { boticas, porZona },
      alertas: { requerimientosAbiertos: requerimientos, contratosPorVencer },
    });
  } catch (err) { next(err); }
});

module.exports = router;
