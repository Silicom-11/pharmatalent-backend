const router = require('express').Router();
const { patronDeBusqueda } = require('../utils/busqueda');
const Empleado = require('../models/Empleado');
const Local = require('../models/Local');
const { auth, authorize } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');
const { proyeccionEmpleado } = require('../utils/remuneracion');
const { revocarAccesoPorCese } = require('../services/accesos');
const { revisarSueldoMinimo } = require('../services/sueldoMinimo');

router.use(auth);

router.get('/', scopeByRole, permit('employees', 'read'), async (req, res, next) => {
  try {
    const { estado, tipo, local, zona, search } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (estado) filter.estado = estado;
    if (tipo) filter.tipoProfesional = tipo;
    if (local) filter.localActual = local;
    if (zona) filter.zona = zona;
    const patron = patronDeBusqueda(search);
    if (patron) filter.$or = [{ nombres: patron }, { apellidos: patron }, { dni: patron }];

    // Alcance de datos según el catálogo organizacional
    if (req.scope && !req.scope.isNational) {
      if (req.scope.scopeType === 'SELF') {
        filter._id = req.scope.employeeId;             // sólo su propio registro
      } else {
        const allowed = (req.scope.locationIds || []).map(String);
        filter.localActual = local && allowed.includes(String(local))
          ? local
          : { $in: req.scope.locationIds || [] };
      }
    }

    // El alcance decide qué legajos se ven; la proyección, qué parte de ellos.
    // Sin la segunda, quien lee el equipo de su local recibía también sueldos
    // y cuentas bancarias.
    const campos = proyeccionEmpleado(req.usuario.rol);

    const [employees, total] = await Promise.all([
      Empleado.find(filter)
        .select(campos)
        .populate('cargoActual', 'nombre codigo')
        .populate('localActual', 'nombre marca codigo')
        .populate('zona', 'nombre')
        .sort({ apellidos: 1, nombres: 1 })
        .skip(skip)
        .limit(limit),
      Empleado.countDocuments(filter),
    ]);

    res.json({
      data: employees,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

router.get('/stats', permit('employees', 'read'), async (_req, res, next) => {
  try {
    const [byType, byStatus, byLocation] = await Promise.all([
      Empleado.aggregate([
        { $match: { estado: 'ACTIVO' } },
        { $group: { _id: '$tipoProfesional', count: { $sum: 1 } } },
      ]),
      Empleado.aggregate([
        { $group: { _id: '$estado', count: { $sum: 1 } } },
      ]),
      Empleado.aggregate([
        { $match: { estado: 'ACTIVO' } },
        { $group: { _id: '$localActual', count: { $sum: 1 } } },
        { $lookup: { from: 'locales', localField: '_id', foreignField: '_id', as: 'local' } },
        { $unwind: '$local' },
        { $project: { locationName: '$local.nombre', count: 1 } },
      ]),
    ]);
    res.json({ byType, byStatus, byLocation });
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('employees', 'read'), async (req, res, next) => {
  try {
    const empleado = await Empleado.findById(req.params.id)
      .select(proyeccionEmpleado(req.usuario.rol))
      .populate('cargoActual')
      .populate('localActual')
      .populate('zona');
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(empleado);
  } catch (err) { next(err); }
});

router.post('/', permit('employees', 'write'), validarCuerpo(esq.employeeCrear), async (req, res, next) => {
  try {
    const bajoMinimo = revisarSueldoMinimo(req.body.sueldoBasico, { fecha: req.body.fechaIngreso || new Date() });
    if (bajoMinimo) return res.status(400).json({ error: bajoMinimo });
    const empleado = await Empleado.create(req.body);
    res.status(201).json(empleado);
  } catch (err) { next(err); }
});

/**
 * Edición del legajo, dejando rastro de lo que importa.
 *
 * Un sueldo y un puesto no son campos cualesquiera: son las dos cosas por las
 * que alguien pregunta meses después —«¿desde cuándo gana esto?», «¿cuándo lo
 * ascendieron?»— y las que sustentan una liquidación o una reclamación.
 *
 * El modelo ya tenía `historialSueldos` y `historialCargos`, y el legajo los
 * mostraba, pero ninguna ruta los escribía: cambiar un sueldo lo sobrescribía
 * y la línea de tiempo salía siempre vacía.
 */
router.put('/:id', validarId(), permit('employees', 'write'), validarCuerpo(esq.employeeEditar),
  async (req, res, next) => {
    try {
      const empleado = await Empleado.findById(req.params.id);
      if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

      const { motivo } = req.body;
      const hoy = new Date();
      const cambios = [];

      // ─── Remuneración ───
      const sueldoNuevo = req.body.sueldoBasico;
      if (sueldoNuevo !== undefined && sueldoNuevo !== empleado.sueldoBasico) {
        const bajoMinimo = revisarSueldoMinimo(sueldoNuevo, { fecha: hoy });
        if (bajoMinimo) return res.status(400).json({ error: bajoMinimo });
        const anterior = empleado.sueldoBasico;
        // La primera vez se registra también el sueldo de partida, para que la
        // línea de tiempo no empiece con un salto sin origen
        if (!empleado.historialSueldos?.length && anterior != null) {
          empleado.historialSueldos.push({
            monto: anterior,
            fechaVigencia: empleado.fechaIngreso || hoy,
            motivo: 'Remuneración de ingreso',
          });
        }
        empleado.historialSueldos.push({
          monto: sueldoNuevo,
          fechaVigencia: hoy,
          motivo: motivo || 'Cambio de remuneración',
        });
        cambios.push(`remuneración: S/ ${anterior} → S/ ${sueldoNuevo}`);
      }

      // ─── Puesto o centro de trabajo ───
      const puestoNuevo = req.body.cargoActual;
      const centroNuevo = req.body.localActual;
      const cambiaPuesto = puestoNuevo && String(puestoNuevo) !== String(empleado.cargoActual);
      const cambiaCentro = centroNuevo && String(centroNuevo) !== String(empleado.localActual);

      if (cambiaPuesto || cambiaCentro) {
        if (!empleado.historialCargos?.length && empleado.cargoActual) {
          empleado.historialCargos.push({
            cargo: empleado.cargoActual,
            local: empleado.localActual,
            fechaInicio: empleado.fechaIngreso || hoy,
            fechaFin: hoy,
            motivo: 'Puesto de ingreso',
          });
        } else {
          // Se cierra el tramo anterior antes de abrir el nuevo
          const abierto = empleado.historialCargos.find((h) => !h.fechaFin);
          if (abierto) abierto.fechaFin = hoy;
        }
        empleado.historialCargos.push({
          cargo: puestoNuevo || empleado.cargoActual,
          local: centroNuevo || empleado.localActual,
          fechaInicio: hoy,
          motivo: motivo || (cambiaPuesto ? 'Cambio de puesto' : 'Traslado de centro'),
        });
        cambios.push(cambiaPuesto ? 'cambio de puesto' : 'traslado de centro');
      }

      Object.assign(empleado, req.body);
      await empleado.save();

      res.json({
        ...empleado.toJSON(),
        // Se devuelve para que la interfaz pueda confirmarlo, no como adorno
        cambiosRegistrados: cambios.length ? cambios : undefined,
      });
    } catch (err) { next(err); }
  });

router.delete('/:id', validarId(), permit('employees', 'approve'), async (req, res, next) => {
  try {
    const empleado = await Empleado.findByIdAndUpdate(req.params.id, { estado: 'CESADO' }, { new: true });
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
    const cuentasCerradas = await revocarAccesoPorCese(empleado._id, req.usuario._id);
    res.json({ mensaje: 'Empleado cesado', empleado, cuentasCerradas });
  } catch (err) { next(err); }
});

module.exports = router;
