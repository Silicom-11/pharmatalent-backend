const router = require('express').Router();
const { proyeccionContrato } = require('../utils/remuneracion');
const Contrato = require('../models/Contrato');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit, employeeScopeFilter } = require('../middleware/scopeByRole');
const reglas = require('../services/contractRules');
const { revisarSueldoMinimo } = require('../services/sueldoMinimo');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');
const { revocarAccesoPorCese } = require('../services/accesos');

router.use(auth);

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Avisa a los usuarios de los roles indicados */
async function notificarRoles(roles, payload) {
  const destinatarios = await Usuario.find({ rol: { $in: roles }, activo: true }).select('_id');
  if (destinatarios.length) {
    await Notificacion.insertMany(destinatarios.map((u) => ({ ...payload, usuario: u._id })));
  }
}

/** Avisa al propio empleado, si tiene cuenta en el sistema */
async function avisarColaborador(employeeId, payload) {
  const cuenta = await Usuario.findOne({ empleado: employeeId }).select('_id');
  if (cuenta) await Notificacion.create({ ...payload, usuario: cuenta._id });
}

// ─── Listado con alcance ─────────────────────────────────────────────────────
router.get('/', scopeByRole, permit('contracts', 'read'), async (req, res, next) => {
  try {
    const { empleado, estado, expiringSoon } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (estado) filter.estado = estado;
    if (expiringSoon === 'true') {
      const en30 = new Date();
      en30.setDate(en30.getDate() + 30);
      filter.fechaFin = { $lte: en30, $gte: new Date() };
      filter.estado = 'VIGENTE';
    }

    // Nadie ve los contratos de empleados fuera de su ámbito
    Object.assign(filter, await employeeScopeFilter(req.scope, Empleado));

    const [records, total] = await Promise.all([
      Contrato.find(filter)
        // El sueldo pactado es remuneración: sólo para quien la administra
        .select(proyeccionContrato(req.usuario.rol))
        .populate('empleado', 'nombres apellidos dni tipoProfesional')
        .populate('cargo', 'nombre')
        .sort({ fechaFin: 1 })
        .skip(skip)
        .limit(limit),
      Contrato.countDocuments(filter),
    ]);
    res.json({ data: records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── Alertas por proximidad de vencimiento ───────────────────────────────────
router.get('/alerts', scopeByRole, permit('contracts', 'read'), async (req, res, next) => {
  try {
    const ahora = new Date();
    const en = (dias) => new Date(ahora.getTime() + dias * 86400000);
    const alcance = await employeeScopeFilter(req.scope, Empleado);

    /**
     * Los que aún corren: se avisa con antelación para poder decidir.
     * Se excluye a propósito el estado VENCIDO, que se trata aparte.
     */
    const vigentes = { ...alcance, estado: { $in: ['VIGENTE', 'POR_VENCER'] } };
    const traer = (filtro) => Contrato.find({ ...vigentes, ...filtro })
      .select(proyeccionContrato(req.usuario.rol))
      .populate('empleado', 'nombres apellidos dni estado').sort({ fechaFin: 1 });

    const [porVencerYa, en7dias, en15dias, en30dias] = await Promise.all([
      traer({ fechaFin: { $lt: ahora } }),
      traer({ fechaFin: { $gte: ahora, $lte: en(7) } }),
      traer({ fechaFin: { $gt: en(7), $lte: en(15) } }),
      traer({ fechaFin: { $gt: en(15), $lte: en(30) } }),
    ]);

    /**
     * Contratos ya vencidos con la persona todavía en planilla.
     *
     * Es el caso más delicado y antes no aparecía en ninguna alerta: el aviso
     * se apagaba justo al pasar la fecha, que es cuando empieza el problema.
     * Si un contrato a plazo fijo vence y el trabajador sigue laborando, el
     * vínculo se desnaturaliza y pasa a indeterminado por mandato del artículo
     * 77 de la LPCL, sin que la empresa lo haya decidido.
     */
    const yaVencidos = await Contrato.find({
      ...alcance,
      estado: 'VENCIDO',
      fechaFin: { $lt: ahora },
    })
      .populate('empleado', 'nombres apellidos dni estado localActual')
      .sort({ fechaFin: 1 })
      .lean();

    const desnaturalizados = yaVencidos
      .filter((c) => c.empleado?.estado === 'ACTIVO')
      .map((c) => ({
        ...c,
        diasDesdeElVencimiento: Math.floor((ahora - new Date(c.fechaFin)) / 86400000),
      }));

    const vencidos = [...porVencerYa, ...desnaturalizados]
      .sort((a, b) => new Date(a.fechaFin) - new Date(b.fechaFin));

    res.json({
      vencidos: { count: vencidos.length, contracts: vencidos },
      // El subconjunto que exige actuar hoy, no cuando se pueda
      desnaturalizacion: {
        count: desnaturalizados.length,
        contracts: desnaturalizados,
        aviso: desnaturalizados.length
          ? `${desnaturalizados.length} empleado(es) siguen trabajando con el contrato vencido. `
            + 'Conforme al artículo 77 de la LPCL, el vínculo se considera de duración indeterminada.'
          : undefined,
      },
      en7dias: { count: en7dias.length, contracts: en7dias },
      en15dias: { count: en15dias.length, contracts: en15dias },
      en30dias: { count: en30dias.length, contracts: en30dias },
    });
  } catch (err) { next(err); }
});

/**
 * Cartera de renovaciones.
 *
 * Cada contrato próximo a vencer llega con lo que la decisión necesita: los
 * antecedentes del empleado, el tiempo acumulado bajo contrato modal y la
 * advertencia legal si renovar superaría el tope de cinco años.
 */
router.get('/pipeline', scopeByRole, permit('contracts', 'read'), async (req, res, next) => {
  try {
    const horizonte = Number(req.query.dias) || 90;
    const limite = new Date(Date.now() + horizonte * 86400000);

    const filter = {
      tipo: { $in: reglas.MODALIDADES_SUJETAS_A_TOPE },
      estado: { $in: ['VIGENTE', 'POR_VENCER', 'VENCIDO'] },
      fechaFin: { $lte: limite },
    };
    Object.assign(filter, await employeeScopeFilter(req.scope, Empleado));

    const contratos = await Contrato.find(filter)
      .select(proyeccionContrato(req.usuario.rol))
      .populate({
        path: 'empleado',
        select: 'nombres apellidos dni tipoProfesional localActual estado',
        populate: { path: 'localActual', select: 'nombre marca' },
      })
      .populate('cargo', 'nombre')
      .populate('decisionRenovacion.recomendadoPor', 'correo rol')
      .populate('decisionRenovacion.decididoPor', 'correo rol')
      .sort({ fechaFin: 1 });

    const enriquecidos = [];
    for (const c of contratos) {
      if (!c.empleado) continue;
      const [legal, antecedentes] = await Promise.all([
        reglas.evaluarRenovacion(c),
        reglas.antecedentes(c.empleado._id),
      ]);
      enriquecidos.push({ ...c.toObject(), urgencia: reglas.urgencia(c), legal, antecedentes });
    }

    const porNivel = enriquecidos.reduce((acc, c) => {
      acc[c.urgencia.nivel] = (acc[c.urgencia.nivel] || 0) + 1;
      return acc;
    }, {});

    res.json({
      data: enriquecidos,
      horizonte,
      total: enriquecidos.length,
      porNivel,
      sinDecidir: enriquecidos.filter((c) => !c.decisionRenovacion?.decision).length,
      sinRecomendacion: enriquecidos.filter((c) => !c.decisionRenovacion?.recomendacion).length,
      requierenIndeterminado: enriquecidos.filter((c) => c.legal.debeSerIndeterminado).length,
    });
  } catch (err) { next(err); }
});

// ─── Alta ────────────────────────────────────────────────────────────────────
router.post('/', permit('contracts', 'write'), validarCuerpo(esq.contratoCrear), async (req, res, next) => {
  try {
    const bajoMinimo = revisarSueldoMinimo(req.body.sueldo, { fecha: req.body.fechaInicio || new Date(), tipoContrato: req.body.tipo });
    if (bajoMinimo) return res.status(400).json({ error: bajoMinimo });
    const contrato = await Contrato.create(req.body);
    res.status(201).json(contrato);
  } catch (err) { next(err); }
});

/** Paso 1: quien dirige el centro recomienda, porque conoce a la persona */
router.put('/:id/recommend', validarId(), permit('contracts', 'read'), validarCuerpo(esq.contratoRecomendar), async (req, res, next) => {
  try {
    const { recomendacion, nota } = req.body;
    if (!['RENOVAR', 'NO_RENOVAR', 'INDETERMINADO'].includes(recomendacion)) {
      return res.status(400).json({ error: 'Recomendación inválida' });
    }

    const contrato = await Contrato.findById(req.params.id)
      .populate('empleado', 'nombres apellidos localActual');
    if (!contrato) return res.status(404).json({ error: 'Contrato no encontrado' });
    if (contrato.decisionRenovacion?.decision) {
      return res.status(400).json({ error: 'El contrato ya tiene una decisión tomada' });
    }

    contrato.decisionRenovacion = {
      ...(contrato.decisionRenovacion?.toObject?.() || contrato.decisionRenovacion || {}),
      recomendacion,
      recomendadoPor: req.usuario._id,
      recomendadoEn: new Date(),
      notaRecomendacion: nota,
    };
    await contrato.save();

    await notificarRoles(['GERENTE_RRHH', 'ANALISTA_SELECCION'], {
      tipo: 'CONTRATO',
      titulo: 'Recomendación de renovación registrada',
      mensaje: `${contrato.empleado.nombres} ${contrato.empleado.apellidos}: el centro recomienda ${recomendacion.toLowerCase().replace('_', ' ')}.`,
      prioridad: 'MEDIA',
      modeloRelacionado: 'Contrato',
      idRelacionado: contrato._id,
    });

    res.json(contrato);
  } catch (err) { next(err); }
});

/** Paso 2: Recursos Humanos resuelve, con control del tope legal */
router.put('/:id/renew', validarId(), permit('contracts', 'write'), validarCuerpo(esq.contratoRenovar), async (req, res, next) => {
  try {
    const { nuevaFechaFin, sueldo, notas, convertToIndefinite, acknowledgeLegalCap } = req.body;

    const contrato = await Contrato.findById(req.params.id).populate('empleado', 'nombres apellidos _id');
    if (!contrato) return res.status(404).json({ error: 'Contrato no encontrado' });
    if (contrato.decisionRenovacion?.decision) {
      return res.status(400).json({ error: 'El contrato ya fue resuelto' });
    }
    // El sueldo de la renovación rige desde que vence el contrato actual
    const bajoMinimo = revisarSueldoMinimo(sueldo || contrato.sueldo, {
      fecha: contrato.fechaFin && contrato.fechaFin > new Date() ? contrato.fechaFin : new Date(),
      tipoContrato: convertToIndefinite ? 'INDETERMINADO' : contrato.tipo,
    });
    if (bajoMinimo) return res.status(400).json({ error: `${bajoMinimo} Indique el nuevo sueldo de la renovación.` });

    const decisionPrevia = contrato.decisionRenovacion?.toObject?.() || contrato.decisionRenovacion || {};

    /**
     * Separación de firmas.
     *
     * Renovar compromete a la empresa por años y puede acercar el vínculo al
     * tope de 5 años de la LPCL, tras el cual la modalidad se desnaturaliza y
     * el contrato pasa a indeterminado por ministerio de la ley. Por eso son
     * dos personas: quien conoce a la persona recomienda, y Recursos Humanos
     * resuelve. Que una sola haga ambas cosas anularía el control.
     */
    if (!decisionPrevia.recomendacion) {
      return res.status(409).json({
        error: 'Falta la recomendación del centro de trabajo antes de resolver la renovación.',
        siguientePaso: `PUT /api/contracts/${contrato._id}/recommend`,
      });
    }
    if (String(decisionPrevia.recomendadoPor) === String(req.usuario._id)) {
      return res.status(409).json({
        error: 'Quien recomendó no puede resolver la misma renovación. Debe firmarla otra persona.',
        recomendadaPor: 'usted mismo',
      });
    }

    // Paso a indeterminado: la modalidad deja de tener plazo
    if (convertToIndefinite) {
      contrato.tipo = 'INDETERMINADO';
      contrato.fechaFin = undefined;
      contrato.estado = 'VIGENTE';
      if (sueldo) contrato.sueldo = sueldo;
      contrato.decisionRenovacion = {
        ...decisionPrevia,
        decision: 'CONVERTIDO_INDETERMINADO',
        decididoPor: req.usuario._id, decididoEn: new Date(), notaDecision: notas,
      };
      await contrato.save();

      await avisarColaborador(contrato.empleado._id, {
        tipo: 'CONTRATO',
        titulo: 'Contrato a plazo indeterminado',
        mensaje: 'Su contrato pasó a duración indeterminada.',
        prioridad: 'ALTA', modeloRelacionado: 'Contrato', idRelacionado: contrato._id,
      });
      return res.json({ contrato, mensaje: 'Contrato convertido a duración indeterminada' });
    }

    if (!nuevaFechaFin) return res.status(400).json({ error: 'Indique la nueva fecha de término' });

    const legal = await reglas.evaluarRenovacion(contrato, nuevaFechaFin);
    if (legal.superaTope) {
      // Superar el tope no se confirma con un clic de cualquiera: lo asume la gerencia
      const PUEDEN_ASUMIRLO = ['ADMIN', 'GERENTE_RRHH'];
      if (!PUEDEN_ASUMIRLO.includes(req.usuario.rol)) {
        return res.status(403).json({
          error: 'Esta renovación supera el tope de 5 años de contratación a plazo fijo. Sólo la Gerencia de Recursos Humanos puede resolverla.',
          legal,
        });
      }
      if (!acknowledgeLegalCap) {
        return res.status(409).json({
          error: legal.avisos[0],
          requiresConversion: true,
          legal,
        });
      }
    }

    contrato.historialRenovaciones.push({
      fechaFinAnterior: contrato.fechaFin,
      nuevaFechaFin: new Date(nuevaFechaFin),
      aprobadoPor: req.usuario._id,
      notas,
    });
    contrato.fechaFin = new Date(nuevaFechaFin);
    contrato.estado = 'VIGENTE';
    if (sueldo) contrato.sueldo = sueldo;
    contrato.decisionRenovacion = {
      ...decisionPrevia,
      decision: 'RENOVADO',
      decididoPor: req.usuario._id, decididoEn: new Date(), notaDecision: notas,
    };
    await contrato.save();

    await avisarColaborador(contrato.empleado._id, {
      tipo: 'CONTRATO',
      titulo: 'Contrato renovado',
      mensaje: `Su contrato fue renovado hasta el ${ymd(nuevaFechaFin)}.`,
      prioridad: 'ALTA', modeloRelacionado: 'Contrato', idRelacionado: contrato._id,
    });

    res.json({ contrato, legal });
  } catch (err) { next(err); }
});

/** Paso 2 alternativo: no se renueva y el vínculo termina al vencimiento */
router.put('/:id/terminate', validarId(), permit('contracts', 'write'), validarCuerpo(esq.contratoTerminar), async (req, res, next) => {
  try {
    const { motivo, ceaseEmployee = true } = req.body;
    if (!motivo) return res.status(400).json({ error: 'Indique el motivo de la no renovación' });

    const contrato = await Contrato.findById(req.params.id).populate('empleado', 'nombres apellidos _id');
    if (!contrato) return res.status(404).json({ error: 'Contrato no encontrado' });

    const decisionPrevia = contrato.decisionRenovacion?.toObject?.() || contrato.decisionRenovacion || {};
    contrato.estado = 'TERMINADO';
    contrato.motivoTermino = motivo;
    contrato.decisionRenovacion = {
      ...decisionPrevia,
      decision: 'NO_RENOVADO',
      decididoPor: req.usuario._id, decididoEn: new Date(), notaDecision: motivo,
    };
    await contrato.save();

    // El cese se aplica al vencer el plazo, no antes
    const vencido = !contrato.fechaFin || new Date(contrato.fechaFin) <= new Date();
    if (ceaseEmployee && vencido) {
      await Empleado.findByIdAndUpdate(contrato.empleado._id, { estado: 'CESADO' });
      await revocarAccesoPorCese(contrato.empleado._id, req.usuario._id);
    }

    await avisarColaborador(contrato.empleado._id, {
      tipo: 'CONTRATO',
      titulo: 'Contrato no renovado',
      mensaje: `Su contrato concluye el ${ymd(contrato.fechaFin) || 'término previsto'}. ${motivo}`,
      prioridad: 'URGENTE', modeloRelacionado: 'Contrato', idRelacionado: contrato._id,
    });

    res.json({
      contrato,
      ceseAplicado: ceaseEmployee && vencido,
      mensaje: vencido
        ? 'Contrato terminado y empleado cesado'
        : 'Registrado como no renovable; el cese se aplicará al vencimiento',
    });
  } catch (err) { next(err); }
});

module.exports = router;
