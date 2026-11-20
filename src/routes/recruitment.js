const router = require('express').Router();
const { patronDeBusqueda } = require('../utils/busqueda');
const Candidato = require('../models/Candidato');
const Requerimiento = require('../models/Requerimiento');
const Empleado = require('../models/Empleado');
const Contrato = require('../models/Contrato');
const Cargo = require('../models/Cargo');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');
const { rmvVigente } = require('../config/payrollParams');

router.use(auth);

const ETAPAS = ['POSTULADO', 'FILTRO_CV', 'ENTREVISTA', 'EVALUACION_TECNICA', 'OFERTA', 'CONTRATADO', 'DESCARTADO', 'DESISTIO'];
const ACTIVE_STAGES = ['POSTULADO', 'FILTRO_CV', 'ENTREVISTA', 'EVALUACION_TECNICA', 'OFERTA'];

// ─── Embudo completo (vista kanban) ──────────────────────────────────────────
router.get('/pipeline', permit('recruitment', 'read'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.requerimiento) filter.requerimiento = req.query.requerimiento;

    const candidates = await Candidato.find(filter)
      .populate({
        path: 'requerimiento',
        select: 'codigo cargo local urgencia',
        populate: [{ path: 'cargo', select: 'nombre codigo' }, { path: 'local', select: 'nombre marca' }],
      })
      .sort({ creadoEn: -1 });

    // Agrupa por etapa preservando el orden del embudo (toJSON incluye virtuales)
    const plain = candidates.map((c) => c.toJSON());
    const pipeline = ETAPAS.map((etapa) => ({
      etapa,
      candidates: plain.filter((c) => c.etapa === etapa),
    }));

    res.json({ pipeline, total: candidates.length });
  } catch (err) { next(err); }
});

// ─── Indicadores de reclutamiento ────────────────────────────────────────────
router.get('/stats', permit('recruitment', 'read'), async (_req, res, next) => {
  try {
    const [byStage, bySource, byType, hired] = await Promise.all([
      Candidato.aggregate([{ $group: { _id: '$etapa', count: { $sum: 1 } } }]),
      Candidato.aggregate([{ $group: { _id: '$origen', count: { $sum: 1 } } }]),
      Candidato.aggregate([
        { $match: { etapa: { $in: ACTIVE_STAGES } } },
        { $group: { _id: '$tipoProfesional', count: { $sum: 1 } } },
      ]),
      Candidato.countDocuments({ etapa: 'CONTRATADO' }),
    ]);

    const total = byStage.reduce((a, s) => a + s.count, 0);
    const activo = byStage.filter((s) => ACTIVE_STAGES.includes(s._id)).reduce((a, s) => a + s.count, 0);
    const discarded = byStage.filter((s) => ['DESCARTADO', 'DESISTIO'].includes(s._id)).reduce((a, s) => a + s.count, 0);

    res.json({
      byStage, bySource, byType,
      total, activo, hired, discarded,
      conversionRate: total ? Math.round((hired / total) * 100) : 0,
    });
  } catch (err) { next(err); }
});

router.get('/', permit('recruitment', 'read'), async (req, res, next) => {
  try {
    const { etapa, requerimiento, search } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (etapa) filter.etapa = etapa;
    if (requerimiento) filter.requerimiento = requerimiento;
    const patron = patronDeBusqueda(search);
    if (patron) filter.$or = [{ nombres: patron }, { apellidos: patron }, { dni: patron }];

    const [data, total] = await Promise.all([
      Candidato.find(filter)
        .populate({ path: 'requerimiento', select: 'codigo cargo local', populate: { path: 'cargo', select: 'nombre' } })
        .sort({ creadoEn: -1 }).skip(skip).limit(limit),
      Candidato.countDocuments(filter),
    ]);

    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

router.post('/', permit('recruitment', 'write'), validarCuerpo(esq.candidatoCrear), async (req, res, next) => {
  try {
    const candidate = await Candidato.create({
      ...req.body,
      historialEtapas: [{ etapa: 'POSTULADO', usuario: req.usuario._id, nota: 'Postulación registrada' }],
    });
    res.status(201).json(candidate);
  } catch (err) { next(err); }
});

// ─── Mover de etapa en el embudo ─────────────────────────────────────────────
router.put('/:id/stage', validarId(), permit('recruitment', 'write'), validarCuerpo(esq.candidatoEtapa), async (req, res, next) => {
  try {
    const { etapa, nota } = req.body;
    if (!ETAPAS.includes(etapa)) return res.status(400).json({ error: 'Etapa inválida' });

    const candidate = await Candidato.findById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidato no encontrado' });

    // Un QF no puede pasar a oferta sin número de colegiatura
    if (etapa === 'OFERTA' && candidate.tipoProfesional === 'QF' && !candidate.numeroCQF) {
      return res.status(400).json({ error: 'Un Químico Farmacéutico requiere número de colegiatura CQF antes de la oferta' });
    }

    candidate.etapa = etapa;
    candidate.historialEtapas.push({ etapa, usuario: req.usuario._id, nota });
    if (['DESCARTADO', 'DESISTIO'].includes(etapa) && nota) candidate.motivoRechazo = nota;
    await candidate.save();

    res.json(candidate);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('recruitment', 'write'), validarCuerpo(esq.candidatoEditar), async (req, res, next) => {
  try {
    const candidate = await Candidato.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!candidate) return res.status(404).json({ error: 'Candidato no encontrado' });
    res.json(candidate);
  } catch (err) { next(err); }
});

// ─── Contratación: candidato → empleado + contrato ───────────────────────────
router.post('/:id/hire', validarId(), permit('recruitment', 'write'), validarCuerpo(esq.contratarCandidato), async (req, res, next) => {
  try {
    const candidate = await Candidato.findById(req.params.id).populate('requerimiento');
    if (!candidate) return res.status(404).json({ error: 'Candidato no encontrado' });
    if (candidate.etapa === 'CONTRATADO') return res.status(400).json({ error: 'El candidato ya fue contratado' });
    if (candidate.etapa !== 'OFERTA') {
      return res.status(400).json({ error: 'El candidato debe estar en etapa de OFERTA para ser contratado' });
    }

    const existing = await Empleado.findOne({ dni: candidate.dni });
    if (existing) return res.status(409).json({ error: `Ya existe un empleado con DNI ${candidate.dni}` });

    const req_ = candidate.requerimiento;
    const cargo = await Cargo.findById(req_.cargo);
    const fechaIngreso = req.body.fechaIngreso ? new Date(req.body.fechaIngreso) : new Date();
    const propuesto = req.body.sueldo || req_.sueldoOfrecido || candidate.sueldoEsperado || cargo?.rangoSueldo?.minimo || 0;
    // Nunca por debajo de la RMV de la fecha de ingreso (MNT-2026-014): una
    // oferta hecha antes del alza de octubre se ajusta al mínimo legal
    const sueldo = Math.max(Number(propuesto) || 0, rmvVigente(fechaIngreso));
    const esPracticante = candidate.anosExperiencia < 1 && candidate.tipoProfesional === 'TECNICO';

    const empleado = await Empleado.create({
      dni: candidate.dni,
      nombres: candidate.nombres,
      apellidos: candidate.apellidos,
      correo: candidate.correo,
      telefono: candidate.telefono,
      tipoProfesional: candidate.tipoProfesional,
      numeroCQF: candidate.numeroCQF,
      fechaIngreso,
      cargoActual: req_.cargo,
      localActual: req_.local,
      zona: req_.zona,
      sueldoBasico: sueldo,
      estado: 'ACTIVO',
      esPracticante,
      fechaFinPracticas: esPracticante ? new Date(fechaIngreso.getTime() + 90 * 86400000) : undefined,
      direccion: { distrito: 'Lima', ciudad: 'Lima', departamento: 'Lima' },
    });

    // Contrato inicial: prácticas para trainees, plazo fijo de 1 año en el resto
    const fechaFin = new Date(fechaIngreso);
    fechaFin.setFullYear(fechaFin.getFullYear() + 1);
    await Contrato.create({
      empleado: empleado._id,
      tipo: esPracticante ? 'PRACTICAS' : 'PLAZO_FIJO',
      fechaInicio: fechaIngreso,
      fechaFin,
      cargo: req_.cargo,
      sueldo,
      estado: 'VIGENTE',
    });

    candidate.etapa = 'CONTRATADO';
    candidate.contratadoComo = empleado._id;
    candidate.historialEtapas.push({ etapa: 'CONTRATADO', usuario: req.usuario._id, nota: 'Contratación formalizada' });
    await candidate.save();

    // Cierra el requerimiento si ya no quedan posiciones por cubrir
    const hiredCount = await Candidato.countDocuments({ requerimiento: req_._id, etapa: 'CONTRATADO' });
    if (hiredCount >= req_.cantidad) {
      await Requerimiento.findByIdAndUpdate(req_._id, {
        estado: 'CUBIERTO', cerradoEn: new Date(), empleadoContratado: empleado._id,
      });
      await Notificacion.create({
        usuario: req_.solicitadoPor,
        tipo: 'RECLUTAMIENTO',
        titulo: 'Requerimiento cubierto',
        mensaje: `${req_.codigo}: ${empleado.nombres} ${empleado.apellidos} se incorpora el ${fechaIngreso.toISOString().slice(0, 10)}.`,
        prioridad: 'ALTA',
        modeloRelacionado: 'Requerimiento',
        idRelacionado: req_._id,
      });
    }

    res.status(201).json({ mensaje: 'Candidato contratado', empleado, candidate });
  } catch (err) { next(err); }
});

module.exports = router;
