const router = require('express').Router();
const DescansoMedico = require('../models/DescansoMedico');
const Empleado = require('../models/Empleado');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

/** Días de incapacidad ya acumulados por el empleado en el año calendario */
async function accumulatedDays(employeeId, year, excludeId = null) {
  const filter = {
    empleado: employeeId,
    fechaInicio: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31`) },
    estado: { $ne: 'RECHAZADO' },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const rows = await DescansoMedico.find(filter).select('diasTotales');
  return rows.reduce((a, r) => a + r.diasTotales, 0);
}

// ─── Listado ─────────────────────────────────────────────────────────────────
router.get('/leaves', scopeByRole, permit('welfare', 'read'), async (req, res, next) => {
  try {
    const { empleado, estado, tipo, estadoReembolso } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (estado) filter.estado = estado;
    if (tipo) filter.tipo = tipo;
    if (estadoReembolso) filter['subsidio.estadoReembolso'] = estadoReembolso;

    // Alcance: quien no es nacional sólo ve su propio local / zona
    if (req.scope && !req.scope.isNational) {
      if (req.scope.scopeType === 'SELF') {
        filter.empleado = req.scope.employeeId;
      } else {
        const emps = await Empleado.find({ localActual: { $in: req.scope.locationIds || [] } }).select('_id');
        filter.empleado = { $in: emps.map((e) => e._id) };
      }
    }

    const [data, total] = await Promise.all([
      DescansoMedico.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional localActual')
        .sort({ fechaInicio: -1 }).skip(skip).limit(limit),
      DescansoMedico.countDocuments(filter),
    ]);

    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── Tablero de bienestar ────────────────────────────────────────────────────
router.get('/stats', permit('welfare', 'read'), async (_req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const yearStart = new Date(`${year}-01-01`);
    const today = new Date();

    const [byType, byClaim, activo, pendingClaims, totals] = await Promise.all([
      DescansoMedico.aggregate([
        { $match: { fechaInicio: { $gte: yearStart } } },
        { $group: { _id: '$tipo', count: { $sum: 1 }, days: { $sum: '$diasTotales' } } },
      ]),
      DescansoMedico.aggregate([
        { $match: { 'subsidio.aplica': true } },
        { $group: { _id: '$subsidio.estadoReembolso', count: { $sum: 1 }, monto: { $sum: '$subsidio.montoEstimado' } } },
      ]),
      DescansoMedico.countDocuments({ fechaInicio: { $lte: today }, fechaFin: { $gte: today }, estado: { $ne: 'RECHAZADO' } }),
      DescansoMedico.countDocuments({ 'subsidio.estadoReembolso': { $in: ['PENDIENTE', 'OBSERVADO'] } }),
      DescansoMedico.aggregate([
        { $match: { fechaInicio: { $gte: yearStart } } },
        { $group: { _id: null, days: { $sum: '$diasTotales' }, subsidio: { $sum: '$subsidio.montoEstimado' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Descansos cuyo plazo de canje ante EsSalud vence en menos de 30 días
    const soon = new Date(today.getTime() + 30 * 86400000);
    const atRisk = await DescansoMedico.find({
      'subsidio.aplica': true,
      'subsidio.estadoReembolso': { $in: ['PENDIENTE', 'OBSERVADO'] },
    }).populate('empleado', 'nombres apellidos').select('fechaFin subsidio empleado');

    const expiringClaims = atRisk.filter((l) => {
      const dl = l.fechaLimiteReembolso;
      return dl && dl <= soon;
    });

    res.json({
      byType, byClaim,
      activeLeaves: activo,
      pendingClaims,
      totalDaysYear: totals[0]?.days || 0,
      totalLeavesYear: totals[0]?.count || 0,
      estimatedSubsidy: Math.round(totals[0]?.subsidio || 0),
      expiringClaims: expiringClaims.map((l) => ({
        id: l._id,
        empleado: l.empleado ? `${l.empleado.nombres} ${l.empleado.apellidos}` : '—',
        deadline: l.fechaLimiteReembolso,
        monto: l.subsidio.montoEstimado,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/leaves/:id', validarId(), permit('welfare', 'read'), async (req, res, next) => {
  try {
    const item = await DescansoMedico.findById(req.params.id)
      .populate('empleado', 'nombres apellidos dni tipoProfesional')
      .populate('validadoPor', 'correo rol');
    if (!item) return res.status(404).json({ error: 'Descanso médico no encontrado' });
    res.json(item);
  } catch (err) { next(err); }
});

// ─── Registro con cálculo automático del subsidio ────────────────────────────
router.post('/leaves', permit('welfare', 'write'), validarCuerpo(esq.descansoMedicoCrear), async (req, res, next) => {
  try {
    const empleado = await Empleado.findById(req.body.empleado).select('sueldoBasico nombres apellidos');
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

    const inicio = new Date(req.body.fechaInicio);
    const fin = new Date(req.body.fechaFin);
    if (fin < inicio) return res.status(400).json({ error: 'La fecha de término no puede ser anterior al inicio' });
    const diasTotales = Math.floor((fin - inicio) / 86400000) + 1;

    const leave = new DescansoMedico({
      ...req.body,
      diasTotales,
      registradoPor: req.usuario._id,
    });

    const prior = await accumulatedDays(empleado._id, inicio.getFullYear());
    leave.calcularSubsidio(prior, (empleado.sueldoBasico || 0) / 30);
    await leave.save();

    if (leave.subsidio.aplica) {
      await Notificacion.create({
        usuario: req.usuario._id,
        tipo: 'BIENESTAR',
        titulo: 'Subsidio EsSalud por tramitar',
        mensaje: `${empleado.nombres} ${empleado.apellidos} supera los 20 días de incapacidad: ${leave.subsidio.diasEssalud} días subsidiables. Requiere canje de CITT.`,
        prioridad: 'ALTA',
        modeloRelacionado: 'DescansoMedico',
        idRelacionado: leave._id,
      });
    }

    res.status(201).json(leave);
  } catch (err) { next(err); }
});

router.put('/leaves/:id', validarId(), permit('welfare', 'write'), validarCuerpo(esq.descansoMedicoEditar), async (req, res, next) => {
  try {
    const item = await DescansoMedico.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Descanso médico no encontrado' });
    res.json(item);
  } catch (err) { next(err); }
});

router.put('/leaves/:id/validate', validarId(), permit('welfare', 'approve'), validarCuerpo(esq.descansoMedicoValidar), async (req, res, next) => {
  try {
    const item = await DescansoMedico.findByIdAndUpdate(
      req.params.id,
      { estado: 'VALIDADO', validadoPor: req.usuario._id },
      { new: true }
    ).populate('empleado', 'nombres apellidos');
    if (!item) return res.status(404).json({ error: 'Descanso médico no encontrado' });

    // El empleado pasa a estado LICENCIA mientras dure el descanso
    if (new Date() >= item.fechaInicio && new Date() <= item.fechaFin) {
      await Empleado.findByIdAndUpdate(item.empleado._id, { estado: 'LICENCIA' });
    }
    res.json(item);
  } catch (err) { next(err); }
});

// ─── Gestión del reembolso EsSalud ───────────────────────────────────────────
router.put('/leaves/:id/claim', validarId(), permit('welfare', 'approve'), validarCuerpo(esq.descansoMedicoValidar), async (req, res, next) => {
  try {
    const { estadoReembolso, montoReembolsado, cittNumber } = req.body;
    const item = await DescansoMedico.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Descanso médico no encontrado' });
    if (!item.subsidio.aplica) return res.status(400).json({ error: 'Este descanso no genera subsidio de EsSalud' });

    if (cittNumber) {
      item.citt.numero = cittNumber;
      item.citt.emitido = true;
      item.citt.fechaEmision = item.citt.fechaEmision || new Date();
    }
    if (estadoReembolso) {
      item.subsidio.estadoReembolso = estadoReembolso;
      if (estadoReembolso === 'PRESENTADO') {
        item.subsidio.fechaReembolso = new Date();
        item.citt.canjeadoEn = new Date();
      }
      if (estadoReembolso === 'REEMBOLSADO') {
        item.subsidio.montoReembolsado = montoReembolsado ?? item.subsidio.montoEstimado;
        item.estado = 'CERRADO';
      }
    }
    await item.save();
    res.json(item);
  } catch (err) { next(err); }
});

module.exports = router;
