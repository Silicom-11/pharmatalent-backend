const router = require('express').Router();
const VisitaAuditoria = require('../models/VisitaAuditoria');
const Local = require('../models/Local');
const Empleado = require('../models/Empleado');
const Notificacion = require('../models/Notificacion');
const Usuario = require('../models/Usuario');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

router.get('/', scopeByRole, permit('audits', 'read'), async (req, res, next) => {
  try {
    const { local, resultado, estado } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (local) filter.local = local;
    if (resultado) filter.resultado = resultado;
    if (estado) filter.estado = estado;

    if (req.scope && !req.scope.isNational) {
      filter.local = { $in: req.scope.locationIds || [] };
    }

    const [data, total] = await Promise.all([
      VisitaAuditoria.find(filter)
        .populate('local', 'nombre marca codigo distrito')
        .populate('zona', 'nombre')
        .populate('auditor', 'correo rol')
        .populate('directorTecnicoDeTurno', 'nombres apellidos numeroCQF')
        .sort({ fechaVisita: -1 }).skip(skip).limit(limit),
      VisitaAuditoria.countDocuments(filter),
    ]);

    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── Semáforo regulatorio de la cadena ───────────────────────────────────────
router.get('/risk-map', scopeByRole, permit('audits', 'read'), async (req, res, next) => {
  try {
    const locFilter = { activo: true, tipo: 'BOTICA' };
    if (req.scope && !req.scope.isNational) locFilter._id = { $in: req.scope.locationIds || [] };

    const locations = await Local.find(locFilter)
      .populate('zona', 'nombre')
      .populate('directorTecnico', 'nombres apellidos numeroCQF vencimientoCQF')
      .select('nombre marca codigo zona puntajeUltimaAuditoria fechaUltimaAuditoria directorTecnico')
      .lean();

    const now = new Date();
    const items = locations.map((l) => {
      const puntaje = l.puntajeUltimaAuditoria;
      const daysSince = l.fechaUltimaAuditoria ? Math.floor((now - new Date(l.fechaUltimaAuditoria)) / 86400000) : null;
      const td = l.directorTecnico;
      const licenseExpired = td?.vencimientoCQF ? new Date(td.vencimientoCQF) < now : false;

      // Riesgo: sin Director Técnico o colegiatura vencida es crítico por norma DIGEMID
      let risk = 'BAJO';
      if (!td || licenseExpired) risk = 'CRITICO';
      else if (puntaje != null && puntaje < 70) risk = 'CRITICO';
      else if (puntaje != null && puntaje < 90) risk = 'MEDIO';
      else if (puntaje == null || (daysSince != null && daysSince > 180)) risk = 'MEDIO';

      return {
        _id: l._id, nombre: l.nombre, marca: l.marca, codigo: l.codigo,
        zona: l.zona?.nombre || '—',
        puntaje: puntaje ?? null,
        fechaUltimaAuditoria: l.fechaUltimaAuditoria || null,
        daysSinceAudit: daysSince,
        directorTecnico: td ? `${td.nombres} ${td.apellidos}` : null,
        numeroCQF: td?.numeroCQF || null,
        licenseExpired,
        risk,
      };
    });

    const resumen = { CRITICO: 0, MEDIO: 0, BAJO: 0 };
    for (const i of items) resumen[i.risk]++;

    res.json({
      items: items.sort((a, b) => ({ CRITICO: 0, MEDIO: 1, BAJO: 2 }[a.risk] - { CRITICO: 0, MEDIO: 1, BAJO: 2 }[b.risk])),
      resumen,
      total: items.length,
      compliance: items.length ? Math.round((resumen.BAJO / items.length) * 100) : 0,
    });
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('audits', 'read'), async (req, res, next) => {
  try {
    const item = await VisitaAuditoria.findById(req.params.id)
      .populate('local').populate('zona', 'nombre')
      .populate('auditor', 'correo rol')
      .populate('directorTecnicoDeTurno', 'nombres apellidos numeroCQF');
    if (!item) return res.status(404).json({ error: 'Auditoría no encontrada' });
    res.json(item);
  } catch (err) { next(err); }
});

// ─── Registro de visita inopinada ────────────────────────────────────────────
router.post('/', permit('audits', 'write'), validarCuerpo(esq.auditoriaCrear), async (req, res, next) => {
  try {
    const loc = await Local.findById(req.body.local).select('zona nombre directorTecnico');
    if (!loc) return res.status(404).json({ error: 'Local no encontrado' });

    const audit = new VisitaAuditoria({
      ...req.body,
      zona: loc.zona,
      auditor: req.usuario._id,
      directorTecnicoDeTurno: req.body.directorTecnicoDeTurno || loc.directorTecnico,
    });
    audit.calcularPuntaje();
    if (req.body.cierre) audit.estado = 'CERRADA';
    await audit.save();

    await Local.findByIdAndUpdate(loc._id, {
      puntajeUltimaAuditoria: audit.puntaje,
      fechaUltimaAuditoria: audit.fechaVisita,
    });

    // Una no conformidad escala al supervisor zonal y a la gerencia
    if (audit.resultado === 'NO_CONFORME') {
      const managers = await Usuario.find({ rol: { $in: ['JEFE_ZONA', 'GERENTE_RRHH', 'ADMIN'] }, activo: true }).select('_id');
      await Notificacion.insertMany(managers.map((u) => ({
        usuario: u._id,
        tipo: 'AUDITORIA',
        titulo: 'Auditoría NO CONFORME',
        mensaje: `${loc.nombre} obtuvo ${audit.puntaje}/100 en la visita ${audit.codigo}. ${audit.hallazgosCriticos} hallazgo(s) crítico(s).`,
        prioridad: 'URGENTE',
        modeloRelacionado: 'VisitaAuditoria',
        idRelacionado: audit._id,
      })));
    }

    res.status(201).json(audit);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('audits', 'write'), validarCuerpo(esq.auditoriaEditar), async (req, res, next) => {
  try {
    const audit = await VisitaAuditoria.findById(req.params.id);
    if (!audit) return res.status(404).json({ error: 'Auditoría no encontrada' });

    Object.assign(audit, req.body);
    audit.calcularPuntaje();
    await audit.save();

    await Local.findByIdAndUpdate(audit.local, {
      puntajeUltimaAuditoria: audit.puntaje, fechaUltimaAuditoria: audit.fechaVisita,
    });
    res.json(audit);
  } catch (err) { next(err); }
});

// ─── Levantamiento de un hallazgo ────────────────────────────────────────────
router.put('/:id/findings/:findingId/resolve', validarId(), permit('audits', 'write'), validarCuerpo(esq.hallazgoResolver), async (req, res, next) => {
  try {
    const audit = await VisitaAuditoria.findById(req.params.id);
    if (!audit) return res.status(404).json({ error: 'Auditoría no encontrada' });

    const finding = audit.hallazgos.id(req.params.findingId);
    if (!finding) return res.status(404).json({ error: 'Hallazgo no encontrado' });

    finding.resuelto = true;
    finding.resueltoEn = new Date();
    if (req.body.accionCorrectiva) finding.accionCorrectiva = req.body.accionCorrectiva;

    if (audit.hallazgos.every((f) => f.resuelto)) audit.estado = 'CERRADA';
    await audit.save();
    res.json(audit);
  } catch (err) { next(err); }
});

module.exports = router;
