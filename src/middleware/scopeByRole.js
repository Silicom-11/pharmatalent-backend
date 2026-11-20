const Empleado = require('../models/Empleado');
const Local = require('../models/Local');
const { getRole, can, SCOPES } = require('../config/roles');
const exposicion = require('../config/exposicion');

/**
 * Resuelve el alcance de datos del usuario autenticado a partir del
 * catálogo organizacional y lo deja en `req.scope`.
 *
 * req.scope = {
 *   role, scopeType, employeeId, locationId, zoneId, brand, orgLevel,
 *   locationIds   → locales visibles (null = todos)
 *   isNational    → atajo para consultas sin filtro
 * }
 */
const scopeByRole = async (req, res, next) => {
  try {
    const { rol } = req.usuario;
    const def = getRole(rol);

    if (!def) {
      return res.status(403).json({ error: `Rol desconocido: ${rol}` });
    }

    const scope = {
      rol,
      nivelOrganizacional: def.nivelOrganizacional,
      scopeType: def.scope,
      isNational: def.scope === SCOPES.NATIONAL,
      employeeId: req.usuario.empleado || null,
      locationId: null,
      zoneId: null,
      locationIds: null, // null = sin restricción
      marca: null,
    };

    // Alcance nacional: sin filtros de ubicación
    if (def.scope === SCOPES.NATIONAL) {
      // En modo exposición lo nacional es Junín: las rutas ya filtran por
      // locationIds cuando el alcance no es nacional
      if (exposicion.soloJunin()) {
        scope.isNational = false;
        scope.locationIds = await exposicion.localesJunin();
        scope.exposicion = true;
      }
      req.scope = scope;
      return next();
    }

    // El resto necesita un registro de empleado para anclar el alcance
    const empleado = await Empleado.findById(req.usuario.empleado)
      .populate('localActual', 'zona marca nombre codigo tipo')
      .lean();

    if (!empleado) {
      return res.status(403).json({
        error: 'Su usuario no tiene un registro de empleado asociado. Contacte a Recursos Humanos.',
      });
    }

    scope.employeeId = empleado._id;
    scope.locationId = empleado.localActual?._id || null;
    scope.zoneId = empleado.zona || empleado.localActual?.zona || null;
    scope.marca = empleado.localActual?.marca || null;
    scope.locationName = empleado.localActual?.nombre || null;

    if (def.scope === SCOPES.ZONE) {
      // Todos los locales de su zona
      const locs = await Local.find({ zona: scope.zoneId, activo: true }).select('_id').lean();
      scope.locationIds = locs.map((l) => l._id);
    } else {
      // LOCATION y SELF quedan anclados a su propio centro de trabajo
      scope.locationIds = scope.locationId ? [scope.locationId] : [];
    }

    req.scope = scope;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Construye el filtro Mongo de locales según el alcance.
 * @param {object} scope   req.scope
 * @param {string} field   nombre del campo que referencia al local
 */
// Los nombres por omisión son los del modelo en castellano. Antes decían
// `employee` y `currentLocation`, campos que ya no existen desde la traducción:
// el filtro resultante no coincidía con ningún documento y todo rol que no
// fuera nacional veía cero contratos, evaluaciones, capacitaciones y ceses.
const locationFilter = (scope, field = 'localActual') => {
  if (!scope || scope.isNational || scope.locationIds === null) return {};
  return { [field]: { $in: scope.locationIds } };
};

/**
 * Filtro para roles con alcance SELF: sólo ven su propio registro.
 * @param {string} field   campo que referencia al empleado
 */
const selfFilter = (scope, field = 'empleado') => {
  if (!scope || scope.scopeType !== SCOPES.SELF) return null;
  return { [field]: scope.employeeId };
};

/**
 * Filtro por empleado según el alcance del rol.
 *
 * Devuelve la cláusula Mongo que restringe una colección cuyo documento
 * referencia a un empleado (contratos, evaluaciones, capacitaciones, boletas):
 *  · alcance nacional  → sin restricción
 *  · alcance de zona o local → los empleados de esos centros
 *  · alcance personal → sólo el propio registro
 *
 * @param {Object} scope   req.scope
 * @param {Model}  Employee  modelo de empleados para resolver la pertenencia
 * @param {String} field   campo que referencia al empleado
 */
async function employeeScopeFilter(scope, Empleado, field = 'empleado') {
  if (!scope || scope.isNational) return {};

  if (scope.scopeType === 'SELF') {
    return { [field]: scope.employeeId };
  }

  const plantilla = await Empleado.find({ localActual: { $in: scope.locationIds || [] } })
    .select('_id').lean();
  return { [field]: { $in: plantilla.map((e) => e._id) } };
}

/**
 * Middleware de autorización por módulo y acción, alimentado por la
 * matriz de permisos del catálogo de roles.
 *
 *   router.post('/', auth, permit('payroll', 'write'), handler)
 */
const permit = (module, action = 'read') => (req, res, next) => {
  if (!can(req.usuario.rol, module, action)) {
    const def = getRole(req.usuario.rol);
    return res.status(403).json({
      error: `El rol "${def?.etiqueta || req.usuario.rol}" no tiene permiso para ${
        { read: 'consultar', write: 'modificar', approve: 'aprobar' }[action]
      } el módulo ${module}.`,
    });
  }
  next();
};

module.exports = scopeByRole;
module.exports.scopeByRole = scopeByRole;
module.exports.locationFilter = locationFilter;
module.exports.selfFilter = selfFilter;
module.exports.permit = permit;
module.exports.employeeScopeFilter = employeeScopeFilter;
