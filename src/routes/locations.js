const router = require('express').Router();
const Local = require('../models/Local');
const Empleado = require('../models/Empleado');
const { auth, authorize } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const crypto = require('crypto');
const { hashClave } = require('./terminal');

router.use(auth);

router.get('/', scopeByRole, permit('locations', 'read'), async (req, res, next) => {
  try {
    const { zona, marca, activo = 'true' } = req.query;
    const filter = {};
    if (zona) filter.zona = zona;
    if (marca) filter.marca = marca;
    if (activo === 'true') filter.activo = true;

    // Un supervisor zonal ve los centros de su zona, no los de toda la cadena
    if (req.scope && !req.scope.isNational) {
      filter._id = { $in: req.scope.locationIds || [] };
    }

    const locations = await Local.find(filter)
      .populate('zona', 'nombre')
      .populate('responsable', 'nombres apellidos')
      .sort({ marca: 1, nombre: 1 });
    res.json(locations);
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('locations', 'read'), async (req, res, next) => {
  try {
    const local = await Local.findById(req.params.id)
      .populate('zona')
      .populate('responsable');
    if (!local) return res.status(404).json({ error: 'Local no encontrado' });

    const staff = await Empleado.find({ localActual: local._id, estado: 'ACTIVO' })
      .populate('cargoActual', 'nombre')
      .select('nombres apellidos tipoProfesional');
    res.json({ ...local.toObject(), staff });
  } catch (err) { next(err); }
});

router.post('/', permit('locations', 'write'), validarCuerpo(esq.localCrear), async (req, res, next) => {
  try {
    const local = await Local.create(req.body);
    res.status(201).json(local);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('locations', 'write'), validarCuerpo(esq.localEditar), async (req, res, next) => {
  try {
    const local = await Local.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!local) return res.status(404).json({ error: 'Local no encontrado' });
    res.json(local);
  } catch (err) { next(err); }
});

/**
 * Alta (o reemplazo) del terminal de marcación del local.
 *
 * Devuelve la clave en claro esta única vez: se guarda sólo su hash, así que
 * si se pierde no se recupera, se emite otra —y la anterior deja de valer, que
 * es lo que se quiere cuando un equipo se pierde o se cambia.
 */
router.post('/:id/terminal', validarId(), permit('locations', 'write'), async (req, res, next) => {
  try {
    const local = await Local.findById(req.params.id);
    if (!local) return res.status(404).json({ error: 'Centro de trabajo no encontrado' });
    if (!local.codigo) return res.status(400).json({ error: 'El local necesita un código antes de registrar su terminal' });

    const clave = crypto.randomBytes(18).toString('base64url');
    local.terminal = {
      claveHash: hashClave(clave),
      activo: true,
      altaEn: new Date(),
      altaPor: req.usuario._id,
    };
    await local.save();

    res.status(201).json({
      local: { nombre: local.nombre, codigo: local.codigo },
      clave,
      aviso: 'Instale esta clave en el terminal del local. No se volverá a mostrar.',
    });
  } catch (err) { next(err); }
});

/** Baja del terminal: deja de aceptar marcas de inmediato */
router.delete('/:id/terminal', validarId(), permit('locations', 'write'), async (req, res, next) => {
  try {
    const r = await Local.updateOne({ _id: req.params.id }, { 'terminal.activo': false });
    if (!r.matchedCount) return res.status(404).json({ error: 'Centro de trabajo no encontrado' });
    res.json({ mensaje: 'Terminal dado de baja' });
  } catch (err) { next(err); }
});

module.exports = router;
