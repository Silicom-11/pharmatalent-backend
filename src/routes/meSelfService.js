const router = require('express').Router();
const Empleado = require('../models/Empleado');
const Asistencia = require('../models/Asistencia');
const Turno = require('../models/Turno');
const Vacacion = require('../models/Vacacion');
const Contrato = require('../models/Contrato');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const leave = require('../services/leaveRules');
const apr = require('../services/aprobaciones');
const { SHIFT_ROLES } = require('../config/formats');
const { exencionDe, jornadaDe } = require('../config/jornadas');
const Boleta = require('../models/Boleta');
const Evaluacion = require('../models/Evaluacion');
const { armarBoleta } = require('../services/boleta');
const { auth } = require('../middleware/auth');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');

/**
 * Autoservicio del empleado.
 *
 * Todo lo que hay aquí actúa sobre `req.usuario.empleado`: nunca acepta un
 * identificador de empleado por el cuerpo de la petición. Así un empleado
 * no puede marcar asistencia ni pedir vacaciones en nombre de otro.
 */

router.use(auth);

const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

/** Exige que la cuenta tenga ficha de empleado */
const requireEmployee = async (req, res, next) => {
  if (!req.usuario.empleado) {
    return res.status(404).json({
      error: 'Su usuario no tiene una ficha de empleado asociada. Contacte a Recursos Humanos.',
    });
  }
  req.empleado = await Empleado.findById(req.usuario.empleado)
    .populate('localActual', 'nombre codigo marca turnos horarioAtencion')
    .populate('cargoActual', 'nombre codigo rolPorDefecto');
  if (!req.empleado) return res.status(404).json({ error: 'Ficha de empleado no encontrada' });
  next();
};

/** Turno asignado al empleado en una fecha */
async function shiftOn(employeeId, fecha) {
  const from = new Date(fecha);
  const to = new Date(from.getTime() + DAY);
  return Turno.findOne({
    'asignaciones.empleado': employeeId,
    fecha: { $gte: from, $lt: to },
  }).populate('local', 'nombre codigo marca');
}


// ══════════════════════════════════════════════════════════════════════════
// MARCACIÓN DE ASISTENCIA
// ══════════════════════════════════════════════════════════════════════════

/** Estado de la jornada de hoy: turno, marcas y qué acción corresponde */
router.get('/attendance/today', requireEmployee, async (req, res, next) => {
  try {
    const today = startOfToday();
    const [record, turno] = await Promise.all([
      Asistencia.findOne({ empleado: req.empleado._id, fecha: today }).populate('local', 'nombre codigo'),
      shiftOn(req.empleado._id, today),
    ]);

    const mine = turno?.asignaciones?.find((a) => String(a.empleado) === String(req.empleado._id));
    // Sin turno: jornada fija de sede, o exención del registro
    const exento = exencionDe(req.usuario.rol);
    const fija = !turno && !exento ? jornadaDe(req.usuario.rol, today) : null;
    const scheduled = turno ? {
      tipoTurno: turno.tipoTurno,
      horaInicio: turno.horaInicio,
      horaFin: turno.horaFin,
      local: turno.local?.nombre,
      rol: mine?.rol,
      roleLabel: SHIFT_ROLES[mine?.rol]?.etiqueta || mine?.rol,
    } : fija ? {
      ...fija,
      local: req.empleado.localActual?.nombre,
      roleLabel: 'Jornada administrativa',
    } : null;

    let horasTrabajadas = null;
    if (record?.marcaEntrada) {
      const fin = record.marcaSalida ? new Date(record.marcaSalida) : new Date();
      horasTrabajadas = Math.round(((fin - new Date(record.marcaEntrada)) / 3600000) * 100) / 100;
    }

    res.json({
      fecha: ymd(today),
      hasShift: !!scheduled,
      scheduled,
      exento: exento || null,
      record: record || null,
      horasTrabajadas,
      canClockIn: false,
      canClockOut: false,
      marcaEnTerminal: true,
      serverTime: new Date(),
    });
  } catch (err) { next(err); }
});

/**
 * La marcación ya no se hace desde la sesión personal.
 *
 * Con estas dos rutas cualquiera registraba su entrada desde el celular, en
 * cualquier lugar. La asistencia la registra ahora el terminal del centro de
 * trabajo (routes/terminal.js); aquí sólo se consulta. Las rutas se conservan
 * para que una aplicación sin actualizar reciba una explicación y no un 404.
 */
const MARCA_EN_TERMINAL = {
  error: 'La asistencia se marca en el terminal de su centro de trabajo, no desde su cuenta. '
    + 'Si no pudo marcar, su administrador puede registrarlo indicando el motivo.',
  marcaEnTerminal: true,
};
router.post('/attendance/clock-in', (_req, res) => res.status(403).json(MARCA_EN_TERMINAL));
router.post('/attendance/clock-out', (_req, res) => res.status(403).json(MARCA_EN_TERMINAL));

// ══════════════════════════════════════════════════════════════════════════
// VACACIONES Y PERMISOS
// ══════════════════════════════════════════════════════════════════════════

/** Saldo D.L. 713 e historial propio */
router.get('/vacations', requireEmployee, async (req, res, next) => {
  try {
    const [balance, requests] = await Promise.all([
      leave.balanceOf(req.empleado),
      Vacacion.find({ empleado: req.empleado._id })
        .populate('aprobadoPor', 'correo rol')
        .populate('aprobaciones.usuario', 'correo rol')
        .sort({ fechaInicio: -1 }),
    ]);

    res.json({
      balance,
      requests,
      pending: requests.filter((r) => ['PENDIENTE', 'APROBADO_LOCAL'].includes(r.estado)).length,
    });
  } catch (err) { next(err); }
});

/** Simulación previa: qué pasaría si pidiera estas fechas */
router.post('/vacations/preview', requireEmployee, validarCuerpo(esq.vacacionPropia), async (req, res, next) => {
  try {
    const { tipo = 'VACACIONES', fechaInicio, fechaFin } = req.body;
    const check = await leave.validateRequest({ empleado: req.empleado, tipo, fechaInicio, fechaFin });
    res.json({
      valid: check.ok,
      errors: check.errors,
      warnings: check.warnings,
      diasTotales: check.diasTotales,
      balance: check.balance,
      impact: check.impact,
    });
  } catch (err) { next(err); }
});

/** El empleado solicita su propio descanso */
router.post('/vacations', requireEmployee, validarCuerpo(esq.vacacionPropia), async (req, res, next) => {
  try {
    const { tipo = 'VACACIONES', fechaInicio, fechaFin, motivo } = req.body;
    if (!fechaInicio || !fechaFin) return res.status(400).json({ error: 'Indique las fechas de inicio y término' });

    const check = await leave.validateRequest({ empleado: req.empleado, tipo, fechaInicio, fechaFin });
    if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors });

    const vacation = await Vacacion.create({
      empleado: req.empleado._id,
      tipo,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      diasTotales: check.diasTotales,
      motivo,
      solicitadoPor: req.usuario._id,
      avisosCobertura: check.warnings,
      dl713: {
        anosDeServicio: check.balance.anosDeServicio,
        diasAcumulados: check.balance.diasAcumulados,
        diasGozados: check.balance.diasGozados,
        diasDisponibles: check.balance.diasDisponibles,
        fechaLimite: check.balance.fechaLimite,
        riesgoTriplePago: check.balance.riesgoTriplePago,
      },
    });

    // La cadena se fija ahora: un traslado posterior no cambia quién decide.
    // Antes la notificación iba al responsable del local aunque el que pedía
    // fuese él mismo, y el personal de CEDI o de la sede no llegaba a nadie.
    const ctx = await apr.contextoDe(req.empleado._id);
    vacation.cadena = apr.cadenaDe(ctx);
    await vacation.save();
    const destinatarios = await apr.destinatariosDe(vacation.cadena[0], ctx);

    if (destinatarios.length) {
      await Notificacion.insertMany(destinatarios.map((usuario) => ({
        usuario,
        tipo: 'VACACION',
        titulo: 'Nueva solicitud de descanso',
        mensaje: `${req.empleado.nombres} ${req.empleado.apellidos} solicita ${check.diasTotales} días desde el ${ymd(fechaInicio)}.` +
          (check.warnings.length ? ` Atención: ${check.warnings[0]}` : ''),
        prioridad: check.warnings.length ? 'ALTA' : 'MEDIA',
        modeloRelacionado: 'Vacacion',
        idRelacionado: vacation._id,
      })));
    }

    res.status(201).json({ vacation, warnings: check.warnings, balance: check.balance });
  } catch (err) { next(err); }
});

/** Retiro de una solicitud aún no autorizada */
router.delete('/vacations/:id', validarId(), requireEmployee, async (req, res, next) => {
  try {
    const vacation = await Vacacion.findOne({ _id: req.params.id, empleado: req.empleado._id });
    if (!vacation) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!['PENDIENTE', 'APROBADO_LOCAL'].includes(vacation.estado)) {
      return res.status(400).json({ error: 'Sólo puede retirar solicitudes que aún no han sido autorizadas' });
    }

    vacation.estado = 'CANCELADO';
    vacation.comentarios = 'Retirada por el empleado';
    await vacation.save();
    res.json({ mensaje: 'Solicitud retirada', vacation });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════
// EVALUACIONES DE DESEMPEÑO
// ══════════════════════════════════════════════════════════════════════════

/**
 * Las evaluaciones propias.
 *
 * La vista «Mis Evaluaciones» llamaba a `/evaluations`, que es el listado de
 * gestión y exige el módulo de evaluaciones. Ningún rol operativo lo tiene, de
 * modo que la pantalla fallaba para todo el que no evalúa a nadie: justo para
 * quien más le interesa ver su calificación. Aquí no hace falta módulo, porque
 * sólo se devuelve lo del propio trabajador.
 */
router.get('/evaluations', requireEmployee, async (req, res, next) => {
  try {
    const items = await Evaluacion.find({ empleado: req.empleado._id })
      .populate('evaluador', 'nombres apellidos')
      .sort({ 'periodo.fechaInicio': -1 })
      .lean();
    res.json({ data: items, total: items.length });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════
// CONTRATOS
// ══════════════════════════════════════════════════════════════════════════

/** Historial contractual propio, con alerta de vencimiento */
router.get('/contracts', requireEmployee, async (req, res, next) => {
  try {
    const contracts = await Contrato.find({ empleado: req.empleado._id })
      .populate('cargo', 'nombre codigo')
      .sort({ fechaInicio: -1 });

    const current = contracts.find((c) => c.estado === 'VIGENTE' || c.estado === 'POR_VENCER') || contracts[0] || null;
    const daysToExpiry = current?.fechaFin
      ? Math.ceil((new Date(current.fechaFin) - Date.now()) / DAY)
      : null;

    res.json({
      contracts,
      current,
      daysToExpiry,
      alert: daysToExpiry != null && daysToExpiry <= 30 && daysToExpiry >= 0
        ? `Su contrato vence en ${daysToExpiry} días. Recursos Humanos gestiona la renovación.`
        : null,
      managedBy: 'Recursos Humanos — Analista de Selección y Gerencia de RRHH',
    });
  } catch (err) { next(err); }
});

/**
 * Mi boleta de pago.
 *
 * Sólo las pagadas: una boleta en borrador o pendiente de aprobación todavía
 * puede cambiar, y entregarla como definitiva induciría a error sobre lo que
 * se va a cobrar.
 */
router.get('/payroll/:id/boleta', validarId(), requireEmployee, async (req, res, next) => {
  try {
    const boleta = await Boleta.findOne({
      _id: req.params.id,
      empleado: req.empleado._id,
      // Mismo criterio que el listado: el detalle de un borrador tampoco
      estado: { $in: ['APROBADO', 'PAGADO'] },
    }).populate({
      path: 'empleado',
      select: 'nombres apellidos dni fechaIngreso sistemaPensiones cuspp cuentaBancaria cargoActual localActual',
      populate: [
        { path: 'cargoActual', select: 'nombre' },
        { path: 'localActual', select: 'nombre marca' },
      ],
    });

    if (!boleta) return res.status(404).json({ error: 'No se encontró esa boleta entre las suyas' });
    if (!['APROBADO', 'PAGADO'].includes(boleta.estado)) {
      return res.status(409).json({
        error: 'Esa boleta aún está en proceso de liquidación y todavía puede variar.',
      });
    }
    res.json(armarBoleta(boleta));
  } catch (err) { next(err); }
});

module.exports = router;
