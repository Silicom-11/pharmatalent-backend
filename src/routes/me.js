const router = require('express').Router();
const Empleado = require('../models/Empleado');
const Contrato = require('../models/Contrato');
const Vacacion = require('../models/Vacacion');
const Asistencia = require('../models/Asistencia');
const Turno = require('../models/Turno');
const Horario = require('../models/Horario');
const Capacitacion = require('../models/Capacitacion');
const Boleta = require('../models/Boleta');
const { auth } = require('../middleware/auth');
const { paginacionDe } = require('../middleware/paginacion');
const { balanceOf } = require('../services/leaveRules');

/** Estados en que una boleta ya es del trabajador: aprobada o pagada */
const ESTADOS_EMITIDOS = ['APROBADO', 'PAGADO'];

router.use(auth);
router.use(require('./meSelfService'));

// GET /profile - Get current user's full profile
router.get('/profile', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(404).json({ error: 'No tiene registro de empleado asociado' });
    }

    const empleado = await Empleado.findById(req.usuario.empleado)
      .populate('cargoActual')
      .populate('localActual')
      .populate('zona');

    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

    const [contrato, vacations] = await Promise.all([
      Contrato.findOne({ empleado: empleado._id, estado: 'VIGENTE' })
        .populate('cargo', 'nombre codigo'),
      Vacacion.find({ empleado: empleado._id, estado: { $in: ['APROBADO', 'EN_CURSO', 'COMPLETADO'] } })
        .sort({ fechaInicio: -1 })
        .limit(5),
    ]);

    // El mismo saldo que «Mis Vacaciones»: sólo descuentan las vacaciones, no
    // los permisos ni las licencias, y el riesgo se mide sobre el período más
    // antiguo sin gozar (D.L. 713)
    const b = await balanceOf(empleado);
    const vacationBalance = {
      anosDeServicio: b.anosDeServicio,
      diasAcumulados: b.diasAcumulados,
      diasGozados: b.diasGozados,
      diasDisponibles: b.diasDisponibles,
      fechaLimite: b.fechaLimite,
      riesgoTriplePago: b.riesgoTriplePago,
      // alias legado
      accrued: b.diasAcumulados, used: b.diasGozados, available: b.diasDisponibles,
    };

    // Colegiatura CQF: alerta de vencimiento para Químicos Farmacéuticos
    let licenseStatus = null;
    if (empleado.numeroCQF) {
      const daysToExpiry = empleado.vencimientoCQF
        ? Math.ceil((new Date(empleado.vencimientoCQF) - Date.now()) / 86400000)
        : null;
      licenseStatus = {
        numero: empleado.numeroCQF,
        expiry: empleado.vencimientoCQF,
        daysToExpiry,
        estado: daysToExpiry == null ? 'SIN_DATO'
          : daysToExpiry < 0 ? 'VENCIDA'
            : daysToExpiry <= 90 ? 'POR_VENCER' : 'VIGENTE',
      };
    }

    res.json({
      empleado,
      contrato,
      recentVacations: vacations,
      vacationBalance,
      licenseStatus,
      metaRol: req.usuario.metaRol,
    });
  } catch (err) { next(err); }
});

// GET /schedule - Get current user's schedule for current/next week
router.get('/schedule', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(404).json({ error: 'No tiene registro de empleado asociado' });
    }

    const now = new Date();
    const dayOfWeek = now.getDay();
    const inicioSemana = new Date(now);
    inicioSemana.setDate(inicioSemana.getDate() - dayOfWeek);
    inicioSemana.setHours(0, 0, 0, 0);

    const nextWeekEnd = new Date(inicioSemana);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 13);
    nextWeekEnd.setHours(23, 59, 59, 999);

    const turnos = await Turno.find({
      'asignaciones.empleado': req.usuario.empleado,
      fecha: { $gte: inicioSemana, $lte: nextWeekEnd },
    })
      .populate('local', 'nombre codigo marca')
      .sort({ fecha: 1, tipoTurno: 1 });

    res.json(turnos);
  } catch (err) { next(err); }
});

// GET /attendance - Get current user's attendance history (paginated)
router.get('/attendance', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(404).json({ error: 'No tiene registro de empleado asociado' });
    }

    const { fechaInicio, fechaFin } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = { empleado: req.usuario.empleado };
    if (fechaInicio && fechaFin) {
      filter.fecha = { $gte: new Date(fechaInicio), $lte: new Date(fechaFin) };
    }

    const [records, total] = await Promise.all([
      Asistencia.find(filter)
        .populate('local', 'nombre codigo')
        .sort({ fecha: -1 })
        .skip(skip)
        .limit(limit),
      Asistencia.countDocuments(filter),
    ]);

    res.json({
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// GET /trainings - Get current user's trainings
router.get('/trainings', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(404).json({ error: 'No tiene registro de empleado asociado' });
    }

    const { estado, tipo } = req.query;
    const filter = { empleado: req.usuario.empleado };
    if (estado) filter.estado = estado;
    if (tipo) filter.tipo = tipo;

    const trainings = await Capacitacion.find(filter)
      .sort({ fechaProgramada: -1 });

    res.json(trainings);
  } catch (err) { next(err); }
});

// GET /payroll - Get current user's payroll history
router.get('/payroll', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(404).json({ error: 'No tiene registro de empleado asociado' });
    }

    const { periodo } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    // Sólo la boleta emitida. Una en BORRADOR o CALCULADO todavía puede
    // cambiar —un descuento mal cargado, una hora extra sin validar— y el
    // trabajador la veía como si fuese su pago. La boleta se entrega cuando la
    // planilla se aprueba (D.S. 001-98-TR, art. 18), no mientras se calcula.
    const filter = { empleado: req.usuario.empleado, estado: { $in: ESTADOS_EMITIDOS } };
    if (periodo) filter.periodo = periodo;

    const [records, total] = await Promise.all([
      Boleta.find(filter)
        .sort({ periodo: -1 })
        .skip(skip)
        .limit(limit),
      Boleta.countDocuments(filter),
    ]);

    res.json({
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

module.exports = router;
