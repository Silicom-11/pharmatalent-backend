const router = require('express').Router();
const Evaluacion = require('../models/Evaluacion');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { auth, authorize } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit, employeeScopeFilter } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

/**
 * Quién puede tocar qué evaluación.
 *
 * Antes cualquiera con permiso de escritura creaba evaluaciones para personal
 * de cualquier botica, eligiendo además quién figuraba como evaluador; y con
 * el id de una evaluación se leía o comunicaba la de cualquier persona.
 * Ahora el evaluador es quien la registra, y todo se hace dentro del ámbito
 * de la cuenta: su botica, su zona o, si es nacional, toda la empresa.
 */
async function enAmbito(req, empleadoId) {
  const { scope } = req;
  if (!scope || scope.isNational) return true;
  if (scope.scopeType === 'SELF') return String(empleadoId) === String(scope.employeeId);
  const e = await Empleado.findById(empleadoId?._id || empleadoId).select('localActual').lean();
  return !!e && (scope.locationIds || []).map(String).includes(String(e.localActual));
}
const esEvaluador = (req, ev) => !!req.usuario.empleado
  && String(ev.evaluador?._id || ev.evaluador) === String(req.usuario.empleado);
const NO_ENCONTRADA = { error: 'Evaluación no encontrada' };

router.get('/', scopeByRole, permit('evaluations', 'read'), async (req, res, next) => {
  try {
    const { empleado, estado } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (estado) filter.estado = estado;

    // Las evaluaciones se leen dentro del ámbito de quien consulta
    Object.assign(filter, await employeeScopeFilter(req.scope, Empleado));
    // Un borrador lo ve sólo quien lo está armando
    if (!req.scope?.isNational) {
      filter.$or = [{ estado: { $ne: 'BORRADOR' } }, { evaluador: req.usuario.empleado || null }];
    }

    const [records, total] = await Promise.all([
      Evaluacion.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional')
        .populate('evaluador', 'nombres apellidos')
        .sort({ 'periodo.fechaFin': -1 })
        .skip(skip)
        .limit(limit),
      Evaluacion.countDocuments(filter),
    ]);
    res.json({ data: records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), scopeByRole, permit('evaluations', 'read'), async (req, res, next) => {
  try {
    const evaluation = await Evaluacion.findById(req.params.id)
      .populate('empleado', 'nombres apellidos dni tipoProfesional localActual cargoActual')
      .populate('evaluador', 'nombres apellidos');
    // Fuera del ámbito, o borrador ajeno: no existe para quien pregunta
    if (!evaluation || !(await enAmbito(req, evaluation.empleado))
      || (evaluation.estado === 'BORRADOR' && !req.scope.isNational && !esEvaluador(req, evaluation))) {
      return res.status(404).json(NO_ENCONTRADA);
    }
    res.json(evaluation);
  } catch (err) { next(err); }
});

router.post('/', scopeByRole, permit('evaluations', 'write'), validarCuerpo(esq.evaluacionCrear), async (req, res, next) => {
  try {
    if (!req.usuario.empleado) {
      return res.status(400).json({ error: 'Su cuenta no está vinculada a un legajo: no puede figurar como evaluador' });
    }
    if (String(req.body.empleado) === String(req.usuario.empleado)) {
      return res.status(400).json({ error: 'Nadie evalúa su propio desempeño' });
    }
    if (!(await enAmbito(req, req.body.empleado))) {
      return res.status(403).json({ error: 'La persona no pertenece a su ámbito' });
    }
    const evaluation = await Evaluacion.create({ ...req.body, evaluador: req.usuario.empleado });
    res.status(201).json(evaluation);
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), scopeByRole, permit('evaluations', 'write'), validarCuerpo(esq.evaluacionEditar),
  async (req, res, next) => {
    try {
      const evaluation = await Evaluacion.findById(req.params.id);
      if (!evaluation || !(await enAmbito(req, evaluation.empleado))) return res.status(404).json(NO_ENCONTRADA);
      if (!req.scope.isNational && !esEvaluador(req, evaluation)) {
        return res.status(403).json({ error: 'Sólo quien registró la evaluación puede modificarla' });
      }
      // Retocarla después de comunicada dejaría sin valor la firma del empleado
      if (evaluation.estado !== 'BORRADOR') {
        return res.status(400).json({
          error: 'La evaluación ya fue comunicada al empleado y no admite cambios',
        });
      }
      Object.assign(evaluation, req.body);
      await evaluation.save();
      res.json(evaluation);
    } catch (err) { next(err); }
  });

/**
 * Avisa al empleado, si tiene cuenta en el sistema.
 * El aviso es secundario: que no se pueda notificar no debe impedir que la
 * evaluación quede comunicada.
 */
async function avisar(employeeId, aviso) {
  try {
    const cuenta = await Usuario.findOne({ empleado: employeeId }).select('_id');
    if (!cuenta) return false;
    await Notificacion.create({ usuario: cuenta._id, ...aviso });
    return true;
  } catch (err) {
    console.error('[evaluaciones] no se pudo notificar:', err.message);
    return false;
  }
}

/**
 * Paso 1 · el evaluador comunica la evaluación al empleado.
 *
 * Hasta aquí era un borrador que sólo veía quien evaluaba. A partir de ahora
 * el empleado puede leerla y responder, y el evaluador ya no la retoca:
 * modificarla después de comunicada vaciaría de sentido la firma.
 */
router.put('/:id/enviar', validarId(), scopeByRole, permit('evaluations', 'write'),
  async (req, res, next) => {
    try {
      const ev = await Evaluacion.findById(req.params.id).populate('empleado', 'nombres apellidos');
      if (!ev || !(await enAmbito(req, ev.empleado))) return res.status(404).json(NO_ENCONTRADA);
      if (!req.scope.isNational && !esEvaluador(req, ev)) {
        return res.status(403).json({ error: 'Sólo quien registró la evaluación puede comunicarla' });
      }
      if (ev.estado !== 'BORRADOR') {
        return res.status(400).json({ error: `La evaluación ya fue comunicada (estado ${ev.estado})` });
      }
      if (!ev.kpis?.length) {
        return res.status(400).json({ error: 'No se puede comunicar una evaluación sin indicadores' });
      }
      const peso = ev.kpis.reduce((a, k) => a + (k.peso || 0), 0);
      if (Math.round(peso) !== 100) {
        return res.status(400).json({
          error: `Los pesos de los indicadores suman ${Math.round(peso)}% y deben sumar 100%`,
        });
      }

      ev.estado = 'ENVIADO';
      ev.enviadoEn = new Date();
      ev.enviadoPor = req.usuario._id;
      await ev.save();

      const avisado = await avisar(ev.empleado._id, {
        tipo: 'EVALUACION',
        titulo: 'Su evaluación de desempeño está disponible',
        mensaje: `Puntaje ${ev.puntajeGlobal}/100 (${ev.calificacionCualitativa}). Revísela y deje constancia de que la conoció.`,
        prioridad: 'ALTA',
        modeloRelacionado: 'Evaluacion',
        idRelacionado: ev._id,
      });

      res.json({
        evaluacion: ev,
        mensaje: avisado
          ? 'Evaluación comunicada al empleado'
          : 'Evaluación comunicada. El empleado no tiene cuenta: entréguesela en físico.',
      });
    } catch (err) { next(err); }
  });

/** Paso 2 · la jefatura superior la visa */
router.put('/:id/revisar', validarId(), scopeByRole, permit('evaluations', 'approve'),
  validarCuerpo(esq.decision), async (req, res, next) => {
    try {
      const ev = await Evaluacion.findById(req.params.id);
      if (!ev || !(await enAmbito(req, ev.empleado))) return res.status(404).json(NO_ENCONTRADA);
      if (ev.estado === 'BORRADOR') {
        return res.status(400).json({ error: 'Aún no se comunica al empleado' });
      }
      // La visa es de otra jefatura: ni quien evaluó ni quien fue evaluado
      if (esEvaluador(req, ev) || String(ev.empleado) === String(req.usuario.empleado)) {
        return res.status(403).json({ error: 'La revisión la hace una jefatura distinta de quien evaluó y de quien fue evaluado' });
      }
      if (ev.revisadoEn) return res.status(400).json({ error: 'Ya fue revisada' });

      ev.revisadoEn = new Date();
      ev.revisadoPor = req.usuario._id;
      // Si el empleado ya firmó, la revisión no retrocede el estado
      if (ev.estado === 'ENVIADO') ev.estado = 'REVISADO';
      if (req.body.comentario) {
        ev.comentarios = `${ev.comentarios || ''}\n[Revisión] ${req.body.comentario}`.trim();
      }
      await ev.save();

      res.json({ evaluacion: ev, mensaje: 'Evaluación revisada' });
    } catch (err) { next(err); }
  });

/**
 * Paso 3 · el empleado deja constancia.
 *
 * Sólo el propio evaluado puede firmar la suya, y puede hacerlo en desacuerdo:
 * lo que se acredita es que la conoció, no que la comparta.
 */
router.put('/:id/firmar', validarId(), validarCuerpo(esq.evaluacionFirmar),
  async (req, res, next) => {
    try {
      const ev = await Evaluacion.findById(req.params.id);
      if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });

      if (!req.usuario.empleado || String(ev.empleado) !== String(req.usuario.empleado)) {
        return res.status(403).json({ error: 'Sólo el evaluado puede firmar su evaluación' });
      }
      if (ev.estado === 'BORRADOR') {
        return res.status(400).json({ error: 'Esta evaluación aún no le fue comunicada' });
      }
      if (ev.firmadoPorEmpleado) {
        return res.status(400).json({ error: 'Ya dejó constancia de esta evaluación' });
      }

      ev.firmadoPorEmpleado = true;
      ev.firmadoEn = new Date();
      ev.estado = 'FIRMADO';
      if (req.body.comentarioEmpleado) ev.comentarioEmpleado = req.body.comentarioEmpleado;
      if (req.body.empleadoConforme !== undefined) ev.empleadoConforme = req.body.empleadoConforme;
      await ev.save();

      // El desacuerdo se comunica a quien evaluó: es información, no un trámite
      if (ev.empleadoConforme === false && ev.enviadoPor) {
        await Notificacion.create({
          usuario: ev.enviadoPor,
          tipo: 'EVALUACION',
          titulo: 'Un empleado firmó en desacuerdo',
          mensaje: req.body.comentarioEmpleado
            ? `Descargo: ${String(req.body.comentarioEmpleado).slice(0, 200)}`
            : 'Dejó constancia de desacuerdo sin comentario.',
          prioridad: 'ALTA',
          modeloRelacionado: 'Evaluacion',
          idRelacionado: ev._id,
        });
      }

      res.json({
        evaluacion: ev,
        mensaje: ev.empleadoConforme === false
          ? 'Constancia registrada con su desacuerdo'
          : 'Constancia registrada',
      });
    } catch (err) { next(err); }
  });

/** Las mías pendientes de firma, para resolverlas desde el propio perfil */
router.get('/mias/pendientes', async (req, res, next) => {
  try {
    if (!req.usuario.empleado) return res.json({ data: [], total: 0 });
    const pendientes = await Evaluacion.find({
      empleado: req.usuario.empleado,
      estado: { $in: ['ENVIADO', 'REVISADO'] },
      firmadoPorEmpleado: false,
    })
      .populate('evaluador', 'nombres apellidos')
      .sort({ enviadoEn: -1 })
      .lean();
    res.json({ data: pendientes, total: pendientes.length });
  } catch (err) { next(err); }
});

module.exports = router;
