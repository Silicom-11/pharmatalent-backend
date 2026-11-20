const router = require('express').Router();
const Zona = require('../models/Zona');
const Local = require('../models/Local');
const { auth, authorize } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');

router.use(auth);

router.get('/', permit('zones', 'read'), async (_req, res, next) => {
  try {
    const zones = await Zona.find({ activo: true })
      .populate('responsable', 'nombres apellidos');
    const resultado = [];
    for (const zona of zones) {
      const locationCount = await Local.countDocuments({ zona: zona._id, activo: true });
      resultado.push({ ...zona.toObject(), locationCount });
    }
    res.json(resultado);
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('zones', 'read'), async (req, res, next) => {
  try {
    const zona = await Zona.findById(req.params.id).populate('responsable');
    if (!zona) return res.status(404).json({ error: 'Zona no encontrada' });
    const locations = await Local.find({ zona: zona._id, activo: true }).sort({ nombre: 1 });
    res.json({ ...zona.toObject(), locations });
  } catch (err) { next(err); }
});

router.post('/', permit('zones', 'write'), validarCuerpo(esq.zonaCrear), async (req, res, next) => {
  try { res.status(201).json(await Zona.create(req.body)); }
  catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('zones', 'write'), validarCuerpo(esq.zonaEditar), async (req, res, next) => {
  try {
    const zona = await Zona.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!zona) return res.status(404).json({ error: 'Zona no encontrada' });
    res.json(zona);
  } catch (err) { next(err); }
});

module.exports = router;
