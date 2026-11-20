const router = require('express').Router();
const { ROLES, ORG_LEVELS, MODULES, SCOPES } = require('../config/roles');
const Empleado = require('../models/Empleado');
const Local = require('../models/Local');
const Zona = require('../models/Zona');
const Cargo = require('../models/Cargo');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');

const { permit } = require('../middleware/scopeByRole');

router.use(auth);

// ─── Catálogo organizacional (roles, niveles, permisos) ──────────────────────
router.get('/catalog', (_req, res) => {
  res.json({
    orgLevels: ORG_LEVELS,
    scopes: SCOPES,
    modules: MODULES,
    roles: Object.entries(ROLES)
      .filter(([, r]) => !r.deprecated)
      .map(([codigo, r]) => ({ codigo, ...r })),
  });
});

// ─── Organigrama: dotación por nivel, puesto y zona ──────────────────────────
router.get('/chart', scopeByRole, permit('org', 'read'), async (req, res, next) => {
  try {
    const match = { estado: { $ne: 'CESADO' } };
    if (req.scope && !req.scope.isNational) {
      match.localActual = { $in: req.scope.locationIds || [] };
    }

    const [byPosition, byType, zones, locationTypes] = await Promise.all([
      Empleado.aggregate([
        { $match: match },
        { $group: { _id: '$cargoActual', count: { $sum: 1 } } },
        { $lookup: { from: 'cargos', localField: '_id', foreignField: '_id', as: 'p' } },
        { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            count: 1,
            nombre: '$p.nombre',
            codigo: '$p.codigo',
            nivel: '$p.nivel',
            nivelOrganizacional: { $ifNull: ['$p.nivelOrganizacional', 'BOTICA'] },
            departamento: '$p.departamento',
          },
        },
        { $sort: { nivel: -1 } },
      ]),
      Empleado.aggregate([
        { $match: match },
        { $group: { _id: '$tipoProfesional', count: { $sum: 1 } } },
      ]),
      Zona.aggregate([
        { $lookup: { from: 'locales', localField: '_id', foreignField: 'zona', as: 'locs' } },
        {
          $project: {
            nombre: 1, codigo: 1,
            locationCount: { $size: '$locs' },
            locationIds: '$locs._id',
          },
        },
      ]),
      Local.aggregate([
        { $match: { activo: true } },
        { $group: { _id: { tipo: '$tipo', marca: '$marca' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Dotación por zona
    const zoneRows = [];
    for (const z of zones) {
      const headcount = await Empleado.countDocuments({
        ...match,
        localActual: { $in: z.locationIds },
      });
      zoneRows.push({ _id: z._id, nombre: z.nombre, codigo: z.codigo, locations: z.locationCount, headcount });
    }

    // Agrupa los puestos por nivel organizacional
    const levels = Object.values(ORG_LEVELS)
      .sort((a, b) => a.order - b.order)
      .map((lvl) => {
        const positions = byPosition.filter((p) => (p.nivelOrganizacional || 'BOTICA') === lvl.codigo);
        return {
          ...lvl,
          headcount: positions.reduce((a, p) => a + p.count, 0),
          positions,
        };
      });

    res.json({
      levels,
      byType,
      zones: zoneRows,
      locationTypes,
      totalHeadcount: byPosition.reduce((a, p) => a + p.count, 0),
    });
  } catch (err) { next(err); }
});

// ─── Ficha de un centro de trabajo: dotación real vs. requerida ──────────────
router.get('/staffing/:locationId', permit('org', 'read'), async (req, res, next) => {
  try {
    const local = await Local.findById(req.params.locationId)
      .populate('zona', 'nombre')
      .populate('responsable', 'nombres apellidos')
      .populate('directorTecnico', 'nombres apellidos numeroCQF vencimientoCQF');
    if (!local) return res.status(404).json({ error: 'Centro de trabajo no encontrado' });

    const staff = await Empleado.find({ localActual: local._id, estado: { $ne: 'CESADO' } })
      .populate('cargoActual', 'nombre codigo nivel')
      .select('nombres apellidos tipoProfesional estado cargoActual esPracticante numeroCQF vencimientoCQF')
      .sort({ tipoProfesional: 1, apellidos: 1 });

    const byType = staff.reduce((acc, e) => {
      acc[e.tipoProfesional] = (acc[e.tipoProfesional] || 0) + 1;
      return acc;
    }, {});

    const req_ = local.dotacionRequerida || {};
    const shiftsPerDay = (local.turnos?.tipos || ['MANANA', 'TARDE']).length;
    const gaps = [
      { rol: 'Químico Farmacéutico', requerido: (req_.qfPorTurno || 0) * shiftsPerDay, real: byType.QF || 0, critical: true },
      { rol: 'Técnico en Farmacia', requerido: (req_.tecnicosPorTurno || 0) * shiftsPerDay, real: byType.TECNICO || 0, critical: false },
      { rol: 'Personal de apoyo', requerido: ((req_.cajerosPorTurno || 0) + (req_.dermoPorTurno || 0) + (req_.almacenPorTurno || 0) + (req_.seguridadPorTurno || 0) + (req_.repartidoresPorTurno || 0)) * shiftsPerDay, real: byType.OPERARIO || 0, critical: false },
    ].map((g) => ({ ...g, brecha: g.real - g.requerido, cubierto: g.real >= g.requerido }));

    res.json({
      local,
      staff,
      byType,
      gaps,
      fullyCovered: gaps.every((g) => g.cubierto),
      criticalGap: gaps.some((g) => g.critical && !g.cubierto),
    });
  } catch (err) { next(err); }
});

module.exports = router;
