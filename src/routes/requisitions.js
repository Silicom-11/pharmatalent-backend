const router = require('express').Router();
const Requerimiento = require('../models/Requerimiento');
const Notificacion = require('../models/Notificacion');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const Local = require('../models/Local');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

/** Notifica a todos los usuarios de un rol dentro de una zona (o a nivel nacional) */
async function notifyRole(roles, payload, zoneId = null) {
  const users = await Usuario.find({ rol: { $in: roles }, activo: true })
    .populate('empleado', 'zona')
    .lean();
  const targets = zoneId
    ? users.filter((u) => !u.empleado?.zona || String(u.empleado.zona) === String(zoneId))
    : users;
  if (!targets.length) return;
  await Notificacion.insertMany(targets.map((u) => ({ ...payload, usuario: u._id })));
}

// ─── Listado con alcance ─────────────────────────────────────────────────────
router.get('/', scopeByRole, permit('requisitions', 'read'), async (req, res, next) => {
  try {
    const { estado, local, urgencia } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (estado) filter.estado = estado;
    if (urgencia) filter.urgencia = urgencia;
    if (local) filter.local = local;

    if (req.scope && !req.scope.isNational) {
      const allowed = (req.scope.locationIds || []).map(String);
      filter.local = local && allowed.includes(String(local))
        ? local
        : { $in: req.scope.locationIds || [] };
    }

    const [data, total] = await Promise.all([
      Requerimiento.find(filter)
        .populate('cargo', 'nombre codigo nivelOrganizacional')
        .populate('local', 'nombre marca codigo')
        .populate('zona', 'nombre')
        .populate('solicitadoPor', 'correo rol')
        .populate('reemplazaA', 'nombres apellidos')
        .sort({ creadoEn: -1 })
        .skip(skip)
        .limit(limit),
      Requerimiento.countDocuments(filter),
    ]);

    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── Indicadores del embudo ──────────────────────────────────────────────────
router.get('/stats', scopeByRole, permit('requisitions', 'read'), async (req, res, next) => {
  try {
    const match = {};
    if (req.scope && !req.scope.isNational) {
      match.local = { $in: req.scope.locationIds || [] };
    }

    const [byStatus, byUrgency, avgDays] = await Promise.all([
      Requerimiento.aggregate([{ $match: match }, { $group: { _id: '$estado', count: { $sum: 1 } } }]),
      Requerimiento.aggregate([
        { $match: { ...match, estado: { $nin: ['CUBIERTO', 'CANCELADO', 'RECHAZADO'] } } },
        { $group: { _id: '$urgencia', count: { $sum: 1 } } },
      ]),
      Requerimiento.aggregate([
        { $match: { ...match, estado: 'CUBIERTO', cerradoEn: { $ne: null } } },
        { $project: { days: { $divide: [{ $subtract: ['$cerradoEn', '$creadoEn'] }, 86400000] } } },
        { $group: { _id: null, avg: { $avg: '$days' } } },
      ]),
    ]);

    const apertura = byStatus
      .filter((s) => !['CUBIERTO', 'CANCELADO', 'RECHAZADO'].includes(s._id))
      .reduce((a, s) => a + s.count, 0);

    res.json({
      byStatus, byUrgency,
      apertura,
      avgDaysToFill: avgDays[0]?.avg != null ? Math.max(0, Math.round(avgDays[0].avg)) : null,
      pendingApproval: byStatus.find((s) => s._id === 'SOLICITADO')?.count || 0,
      inSearch: byStatus.find((s) => s._id === 'EN_BUSQUEDA')?.count || 0,
    });
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('requisitions', 'read'), async (req, res, next) => {
  try {
    const item = await Requerimiento.findById(req.params.id)
      .populate('cargo').populate('local').populate('zona')
      .populate('solicitadoPor', 'correo rol')
      .populate('aprobaciones.usuario', 'correo rol')
      .populate('reemplazaA', 'nombres apellidos dni');
    if (!item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
    res.json(item);
  } catch (err) { next(err); }
});

/**
 * ¿Puede esta cuenta decidir sobre este requerimiento?
 *
 * Antes cualquiera con el permiso aprobaba cualquier requerimiento: un Jefe de
 * Zona el de otra zona, quien lo pidió el suyo, Selección sin pasar por la
 * zona. Ahora, como en la cadena de descansos: decide el Jefe de Zona de ese
 * local; el CEDI, que no pertenece a una zona comercial, lo decide RRHH; la
 * Gerencia y Administración pueden suplir. Y nadie aprueba lo que pidió.
 */
async function puedeDecidir(req, item) {
  if (String(item.solicitadoPor) === String(req.usuario._id)) {
    return 'Quien pidió el requerimiento no puede aprobarlo: lo decide otra jefatura';
  }
  if (['GERENTE_RRHH', 'ADMIN'].includes(req.usuario.rol)) return null;
  const local = await Local.findById(item.local?._id || item.local).select('tipo').lean();
  if (local?.tipo === 'CEDI') return 'Los requerimientos del CEDI los decide Recursos Humanos';
  if (req.usuario.rol !== 'JEFE_ZONA') return 'Este paso lo decide el Jefe de Zona del local';
  const propios = (req.scope?.locationIds || []).map(String);
  if (!propios.includes(String(item.local?._id || item.local))) return 'El local no pertenece a su zona';
  return null;
}

// ─── 1. El Administrador de Botica levanta la necesidad ──────────────────────
router.post('/', scopeByRole, permit('requisitions', 'write'), validarCuerpo(esq.requerimientoCrear), async (req, res, next) => {
  try {
    const body = { ...req.body, solicitadoPor: req.usuario._id };

    // Los roles con alcance de local sólo pueden solicitar para su propio local
    if (req.scope && !req.scope.isNational && req.scope.locationId) {
      body.local = req.scope.locationId;
    }
    if (!body.local) return res.status(400).json({ error: 'Debe indicar el local del requerimiento' });
    // Un Jefe de Zona pide para los locales de su zona, no para los de otra
    if (req.scope && !req.scope.isNational && !(req.scope.locationIds || []).map(String).includes(String(body.local))) {
      return res.status(403).json({ error: 'El local no pertenece a su ámbito' });
    }

    const loc = await Local.findById(body.local).select('zona nombre tipo');
    body.zona = loc?.zona;

    const item = await Requerimiento.create(body);

    // Avisa a quien decide: el Jefe de Zona del local, o RRHH si es el CEDI
    await notifyRole(loc?.tipo === 'CEDI' ? ['GERENTE_RRHH'] : ['JEFE_ZONA'], {
      tipo: 'REQUERIMIENTO',
      titulo: 'Nuevo requerimiento de personal',
      mensaje: `${loc?.nombre || 'Un local'} solicita ${item.cantidad} posición(es). Requiere su aprobación.`,
      prioridad: item.urgencia === 'CRITICA' ? 'URGENTE' : 'ALTA',
      modeloRelacionado: 'Requerimiento',
      idRelacionado: item._id,
    }, loc?.tipo === 'CEDI' ? null : item.zona);

    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ─── 2. El Supervisor de Zona aprueba o rechaza ──────────────────────────────
router.put('/:id/approve', validarId(), scopeByRole, permit('requisitions', 'approve'), validarCuerpo(esq.decision), async (req, res, next) => {
  try {
    const item = await Requerimiento.findById(req.params.id).populate('local', 'nombre');
    if (!item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
    if (item.estado !== 'SOLICITADO') {
      return res.status(400).json({ error: `No se puede aprobar un requerimiento en estado ${item.estado}` });
    }
    const impedimento = await puedeDecidir(req, item);
    if (impedimento) return res.status(403).json({ error: impedimento });

    item.estado = 'APROBADO_ZONAL';
    item.aprobaciones.push({ paso: 'ZONAL', usuario: req.usuario._id, decision: 'APROBADO', comentario: req.body.comentario });
    if (req.body.sueldoOfrecido) item.sueldoOfrecido = req.body.sueldoOfrecido;
    await item.save();

    // Notifica a Selección para que inicie la búsqueda
    await notifyRole(['ANALISTA_SELECCION', 'GERENTE_RRHH'], {
      tipo: 'RECLUTAMIENTO',
      titulo: 'Requerimiento aprobado — iniciar búsqueda',
      mensaje: `${item.codigo} para ${item.local?.nombre} fue aprobado por el supervisor zonal.`,
      prioridad: item.urgencia === 'CRITICA' ? 'URGENTE' : 'ALTA',
      modeloRelacionado: 'Requerimiento',
      idRelacionado: item._id,
    });

    res.json(item);
  } catch (err) { next(err); }
});

router.put('/:id/reject', validarId(), scopeByRole, permit('requisitions', 'approve'), validarCuerpo(esq.decision), async (req, res, next) => {
  try {
    const item = await Requerimiento.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
    // Antes se podía «rechazar» uno ya cubierto o en búsqueda
    if (item.estado !== 'SOLICITADO') {
      return res.status(400).json({ error: `No se puede rechazar un requerimiento en estado ${item.estado}` });
    }
    const impedimento = await puedeDecidir(req, item);
    if (impedimento) return res.status(403).json({ error: impedimento });
    if (!String(req.body.comentario || '').trim()) {
      return res.status(400).json({ error: 'Indique el motivo del rechazo: se le comunica a quien lo pidió' });
    }

    item.estado = 'RECHAZADO';
    item.cerradoEn = new Date();
    item.aprobaciones.push({ paso: 'ZONAL', usuario: req.usuario._id, decision: 'RECHAZADO', comentario: req.body.comentario });
    await item.save();

    await Notificacion.create({
      usuario: item.solicitadoPor,
      tipo: 'REQUERIMIENTO',
      titulo: 'Requerimiento rechazado',
      mensaje: `${item.codigo} fue rechazado. ${req.body.comentario || ''}`.trim(),
      prioridad: 'ALTA',
      modeloRelacionado: 'Requerimiento',
      idRelacionado: item._id,
    });

    res.json(item);
  } catch (err) { next(err); }
});

// ─── 3. El Analista de Selección abre la vacante ─────────────────────────────
router.put('/:id/start-search', validarId(), permit('recruitment', 'write'), async (req, res, next) => {
  try {
    const item = await Requerimiento.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
    if (item.estado !== 'APROBADO_ZONAL') {
      return res.status(400).json({ error: 'El requerimiento debe estar aprobado por el supervisor zonal' });
    }

    item.estado = 'EN_BUSQUEDA';
    item.reclutadorAsignado = req.usuario._id;
    item.aprobaciones.push({ paso: 'SELECCION', usuario: req.usuario._id, decision: 'APROBADO', comentario: 'Búsqueda iniciada' });
    await item.save();

    await Notificacion.create({
      usuario: item.solicitadoPor,
      tipo: 'RECLUTAMIENTO',
      titulo: 'Búsqueda iniciada',
      mensaje: `Selección abrió la convocatoria para ${item.codigo}.`,
      modeloRelacionado: 'Requerimiento',
      idRelacionado: item._id,
    });

    res.json(item);
  } catch (err) { next(err); }
});

// ─── 4. Cierre del requerimiento ─────────────────────────────────────────────
router.put('/:id/close', validarId(), permit('recruitment', 'write'), validarCuerpo(esq.requerimientoCerrar), async (req, res, next) => {
  try {
    const item = await Requerimiento.findByIdAndUpdate(
      req.params.id,
      { estado: 'CUBIERTO', cerradoEn: new Date(), empleadoContratado: req.body.empleadoContratado },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: 'Requerimiento no encontrado' });

    await Notificacion.create({
      usuario: item.solicitadoPor,
      tipo: 'RECLUTAMIENTO',
      titulo: 'Posición cubierta',
      mensaje: `${item.codigo} fue cubierto. El nuevo empleado se incorpora en breve.`,
      modeloRelacionado: 'Requerimiento',
      idRelacionado: item._id,
    });

    res.json(item);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), scopeByRole, permit('requisitions', 'write'), validarCuerpo(esq.requerimientoEditar), async (req, res, next) => {
  try {
    // Se corrige mientras espera decisión, y sólo dentro del propio ámbito
    const actual = await Requerimiento.findById(req.params.id).select('local estado').lean();
    const enAmbito = actual && (req.scope?.isNational
      || (req.scope?.locationIds || []).map(String).includes(String(actual.local)));
    if (!enAmbito) return res.status(404).json({ error: 'Requerimiento no encontrado' });
    if (actual.estado !== 'SOLICITADO') {
      return res.status(400).json({ error: `Ya fue decidido (${actual.estado}): no admite cambios` });
    }
    const item = await Requerimiento.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    res.json(item);
  } catch (err) { next(err); }
});

module.exports = router;
