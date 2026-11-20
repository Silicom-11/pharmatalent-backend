const router = require('express').Router();
const Cargo = require('../models/Cargo');
const { auth, authorize } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');

router.use(auth);

router.get('/', permit('positions', 'read'), async (_req, res, next) => {
  try {
    const positions = await Cargo.find({ activo: true }).sort({ nivel: 1, nombre: 1 });
    res.json(positions);
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('positions', 'read'), async (req, res, next) => {
  try {
    const cargo = await Cargo.findById(req.params.id);
    if (!cargo) return res.status(404).json({ error: 'Cargo no encontrado' });
    res.json(cargo);
  } catch (err) { next(err); }
});

router.post('/', permit('positions', 'write'), validarCuerpo(esq.puestoCrear), async (req, res, next) => {
  try {
    const cargo = await Cargo.create(req.body);
    res.status(201).json(cargo);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('positions', 'write'), validarCuerpo(esq.puestoEditar), async (req, res, next) => {
  try {
    const cargo = await Cargo.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!cargo) return res.status(404).json({ error: 'Cargo no encontrado' });
    res.json(cargo);
  } catch (err) { next(err); }
});

module.exports = router;
