const router = require('express').Router();
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

// GET / - Get current user's notifications (filter by read/unread)
router.get('/', async (req, res, next) => {
  try {
    const { leido, tipo } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = { usuario: req.usuario._id };
    if (leido !== undefined) filter.leido = leido === 'true';
    if (tipo) filter.tipo = tipo;

    const [notifications, total] = await Promise.all([
      Notificacion.find(filter)
        .sort({ creadoEn: -1 })
        .skip(skip)
        .limit(limit),
      Notificacion.countDocuments(filter),
    ]);

    res.json({
      data: notifications,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// GET /count - Get unread count
router.get('/count', async (req, res, next) => {
  try {
    const count = await Notificacion.countDocuments({ usuario: req.usuario._id, leido: false });
    res.json({ unread: count });
  } catch (err) { next(err); }
});

// PUT /read-all - Mark all as read
router.put('/read-all', async (req, res, next) => {
  try {
    const resultado = await Notificacion.updateMany(
      { usuario: req.usuario._id, leido: false },
      { leido: true, leidoEn: new Date() },
    );
    res.json({ mensaje: 'Todas las notificaciones marcadas como leídas', modified: resultado.modifiedCount });
  } catch (err) { next(err); }
});

// PUT /:id/read - Mark as read
router.put('/:id/read', validarId(), async (req, res, next) => {
  try {
    const notification = await Notificacion.findOneAndUpdate(
      { _id: req.params.id, usuario: req.usuario._id },
      { leido: true, leidoEn: new Date() },
      { new: true },
    );
    if (!notification) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json(notification);
  } catch (err) { next(err); }
});

module.exports = router;
