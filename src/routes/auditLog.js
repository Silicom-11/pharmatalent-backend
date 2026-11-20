const router = require('express').Router();
const Bitacora = require('../models/Bitacora');
const { auth } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { paginacionDe } = require('../middleware/paginacion');

/**
 * Consulta de la bitácora.
 *
 * Sólo lectura y sólo para quien administra o dirige RRHH: la bitácora sirve
 * para responder «quién tocó esto», y perdería sentido si cualquiera pudiera
 * alterarla o si registrara consultas además de cambios.
 */

router.use(auth);

router.get('/', permit('bitacora', 'read'), async (req, res, next) => {
  try {
    const {
      modulo, accion, actor, afectado, sensible,
      desde, hasta,
    } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);

    const filtro = {};
    if (modulo) filtro.modulo = modulo;
    if (accion) filtro.accion = accion;
    if (actor) filtro.actor = actor;
    if (afectado) filtro.afectado = afectado;
    if (sensible === 'true') filtro.sensible = true;
    if (desde || hasta) {
      filtro.creadoEn = {};
      if (desde) filtro.creadoEn.$gte = new Date(desde);
      if (hasta) filtro.creadoEn.$lte = new Date(`${hasta}T23:59:59.999Z`);
    }

    const [registros, total] = await Promise.all([
      Bitacora.find(filtro)
        .populate('afectado', 'nombres apellidos dni')
        .sort({ creadoEn: -1 })
        .skip(skip).limit(limit)
        .lean(),
      Bitacora.countDocuments(filtro),
    ]);

    res.json({
      data: registros,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

/** Panorama del período: volumen, quién actúa más y sobre qué */
router.get('/resumen', permit('bitacora', 'read'), async (req, res, next) => {
  try {
    const dias = Number(req.query.dias) || 30;
    const desde = new Date(Date.now() - dias * 86400000);
    const rango = { creadoEn: { $gte: desde } };

    const [porModulo, porAccion, porActor, sensibles, total] = await Promise.all([
      Bitacora.aggregate([
        { $match: rango },
        { $group: { _id: '$modulo', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Bitacora.aggregate([
        { $match: rango },
        { $group: { _id: '$accion', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 12 },
      ]),
      Bitacora.aggregate([
        { $match: rango },
        { $group: { _id: { correo: '$actorCorreo', rol: '$actorRol' }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ]),
      Bitacora.countDocuments({ ...rango, sensible: true }),
      Bitacora.countDocuments(rango),
    ]);

    res.json({
      dias,
      desde,
      total,
      sensibles,
      porModulo: porModulo.map((m) => ({ modulo: m._id, total: m.total })),
      porAccion: porAccion.map((a) => ({ accion: a._id, total: a.total })),
      porActor: porActor.map((a) => ({ correo: a._id.correo, rol: a._id.rol, total: a.total })),
    });
  } catch (err) { next(err); }
});

/** Historial de una persona: todo lo que se hizo sobre su legajo */
router.get('/empleado/:employeeId', permit('bitacora', 'read'), async (req, res, next) => {
  try {
    const registros = await Bitacora.find({ afectado: req.params.employeeId })
      .sort({ creadoEn: -1 })
      .limit(200)
      .lean();
    res.json({ data: registros, total: registros.length });
  } catch (err) { next(err); }
});

module.exports = router;
