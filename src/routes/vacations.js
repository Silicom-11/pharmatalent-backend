const router = require('express').Router();
const Vacacion = require('../models/Vacacion');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const leave = require('../services/leaveRules');
const apr = require('../services/aprobaciones');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

const TYPE_LABEL = {
  VACACIONES: 'vacaciones', PERMISO: 'permiso',
  LICENCIA_MEDICA: 'licencia médica', LICENCIA_SIN_GOCE: 'licencia sin goce',
};

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/** Avisa al empleado sobre su propia solicitud */
async function notifyEmployee(employeeId, payload) {
  const account = await Usuario.findOne({ empleado: employeeId }).select('_id');
  if (account) await Notificacion.create({ ...payload, usuario: account._id });
}

// ─── Decisión sobre el paso pendiente (aval, autorización o rechazo) ─────────
// Va antes de las rutas: las tres que la usan validan su cuerpo con
// esq.decision, que declara todo lo que esta función lee de req.body.
/**
 * Decide sobre el paso que está pendiente.
 *
 * Concentra las comprobaciones que faltaban: que la solicitud siga abierta,
 * que quien decide sea quien corresponde a ese paso —y no cualquiera con el
 * permiso del módulo— y que nadie decida sobre su propia solicitud. Aval y
 * autorización comparten esta lógica; lo que cambia es el permiso que exige
 * cada endpoint y, por tanto, quién puede llamarlo.
 */
async function decidir(req, res, aprobar) {
  const vacation = await Vacacion.findById(req.params.id).populate('empleado');
  if (!vacation) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (!['PENDIENTE', 'APROBADO_LOCAL'].includes(vacation.estado)) {
    return res.status(400).json({ error: `La solicitud ya no está abierta (estado ${vacation.estado})` });
  }

  const ctx = await apr.contextoDe(vacation.empleado._id);
  const cadena = vacation.cadena?.length ? vacation.cadena : apr.cadenaDe(ctx);
  const paso = apr.pasoPendiente(cadena, vacation);
  const permiso = await apr.puedeActuar(req.usuario, paso, vacation, ctx);
  if (!permiso.ok) return res.status(403).json({ error: permiso.motivo });

  const comentario = aprobar ? req.body.comentario : (req.body.motivo || req.body.comentario);
  if (!aprobar && !comentario) {
    return res.status(400).json({ error: 'Indique el motivo del rechazo: el colaborador lo verá' });
  }

  const esFinal = cadena[cadena.length - 1] === paso;
  let impact = null;

  if (aprobar && esFinal) {
    // La salida de un QF sin reemplazo deja al local fuera de norma DIGEMID
    impact = await leave.coverageImpact(vacation.empleado, vacation.fechaInicio, vacation.fechaFin);
    if (impact?.blocking && !req.body.acknowledgeCoverage) {
      return res.status(409).json({
        error: `${impact.local} quedaría sin Químico Farmacéutico durante el período. Debe designar cobertura antes de autorizar.`,
        requiresAcknowledgement: true,
        impact,
      });
    }
  }

  vacation.cadena = cadena;
  vacation.aprobaciones.push({
    paso,
    usuario: req.usuario._id,
    decision: aprobar ? 'APROBADO' : 'RECHAZADO',
    comentario,
    suplencia: !!permiso.suplencia,
  });

  const nombre = `${vacation.empleado.nombres} ${vacation.empleado.apellidos}`;
  const periodo = `del ${ymd(vacation.fechaInicio)} al ${ymd(vacation.fechaFin)}`;

  if (!aprobar) {
    vacation.estado = 'RECHAZADO';
    vacation.motivoRechazo = comentario;
    await vacation.save();
    await notifyEmployee(vacation.empleado._id, {
      tipo: 'VACACION',
      titulo: 'Solicitud rechazada',
      mensaje: `Su solicitud de ${TYPE_LABEL[vacation.tipo] || 'descanso'} ${periodo} fue rechazada en el paso «${apr.PASOS[paso].etiqueta}». ${comentario}`,
      prioridad: 'ALTA', modeloRelacionado: 'Vacacion', idRelacionado: vacation._id,
    });
    return res.json({ vacation, paso });
  }

  if (!esFinal) {
    vacation.estado = 'APROBADO_LOCAL';
    await vacation.save();
    const siguiente = apr.pasoPendiente(cadena, vacation);
    const destinatarios = await apr.destinatariosDe(siguiente, ctx);
    if (destinatarios.length) {
      await Notificacion.insertMany(destinatarios.map((usuario) => ({
        usuario,
        tipo: 'VACACION',
        titulo: 'Descanso avalado: requiere su autorización',
        mensaje: `${nombre} (${ctx.empleado.localActual?.nombre || 'sin local'}) — ${vacation.diasTotales} días ${periodo}.`,
        prioridad: 'MEDIA', modeloRelacionado: 'Vacacion', idRelacionado: vacation._id,
      })));
    }
    return res.json({ vacation, paso, siguiente });
  }

  vacation.estado = 'APROBADO';
  vacation.aprobadoPor = req.usuario._id;
  vacation.aprobadoEn = new Date();
  if (impact?.blocking) {
    vacation.comentarios = `Autorizado con cobertura designada: ${req.body.coverageNote || 'pendiente de detallar'}`;
  }
  await vacation.save();
  await notifyEmployee(vacation.empleado._id, {
    tipo: 'VACACION',
    titulo: 'Descanso autorizado',
    mensaje: `Su solicitud de ${TYPE_LABEL[vacation.tipo] || 'descanso'} ${periodo} fue autorizada.`,
    prioridad: 'MEDIA', modeloRelacionado: 'Vacacion', idRelacionado: vacation._id,
  });
  return res.json({ vacation, paso, impact });
}

// ─── Listado con alcance ─────────────────────────────────────────────────────
router.get('/', scopeByRole, permit('vacations', 'read'), async (req, res, next) => {
  try {
    const { empleado, estado, tipo } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (estado) filter.estado = estado;
    if (tipo) filter.tipo = tipo;

    // Quien sólo ve lo suyo, ve sólo lo suyo
    if (req.scope && !req.scope.isNational) {
      if (req.scope.scopeType === 'SELF') {
        filter.empleado = req.scope.employeeId;
      } else {
        const staff = await Empleado.find({ localActual: { $in: req.scope.locationIds || [] } })
          .select('_id').lean();
        filter.empleado = { $in: staff.map((e) => e._id) };
      }
    }

    const [records, total] = await Promise.all([
      Vacacion.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional localActual')
        .populate('aprobadoPor', 'correo rol')
        .populate('aprobaciones.usuario', 'correo rol')
        .sort({ creadoEn: -1 }).skip(skip).limit(limit),
      Vacacion.countDocuments(filter),
    ]);

    res.json({ data: records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── Bandeja de aprobación con impacto de cobertura ──────────────────────────
router.get('/pending', scopeByRole, permit('vacations', 'read'), async (req, res, next) => {
  try {
    // Candidatas dentro del alcance; luego se queda sólo lo que espera una
    // decisión de quien consulta. Antes la bandeja mostraba todo lo pendiente
    // del alcance, sin distinguir si le tocaba decidir a él o a otro.
    const filter = { estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] } };
    if (req.scope && !req.scope.isNational) {
      const staff = await Empleado.find({ localActual: { $in: req.scope.locationIds || [] } })
        .select('_id').lean();
      filter.empleado = { $in: staff.map((e) => e._id) };
    }

    const candidatas = await Vacacion.find(filter)
      .populate('empleado', 'nombres apellidos dni tipoProfesional localActual fechaIngreso')
      .sort({ fechaInicio: 1 })
      .limit(300);

    /**
     * Mantenimiento preventivo MNT-2026-019. La prueba de carga (100 usuarios)
     * dio a esta bandeja un p95 de 2.2 s, cuatro veces el resto: evaluaba cada
     * solicitud una tras otra (contexto y permiso: unas cuatro consultas
     * seguidas por solicitud) y con carga cada espera se multiplicaba. Ahora
     * se evalúan por lotes en paralelo, el contexto de cada trabajador se
     * consulta una sola vez, y se conserva el orden y el tope de 50.
     */
    const contextos = new Map();
    const contextoDe = (id) => {
      const clave = String(id);
      if (!contextos.has(clave)) contextos.set(clave, apr.contextoDe(id));
      return contextos.get(clave);
    };
    const evaluar = async (v) => {
      if (!v.empleado) return null;
      const ctx = await contextoDe(v.empleado._id);
      if (!ctx) return null;
      const cadena = v.cadena?.length ? v.cadena : apr.cadenaDe(ctx);
      const paso = apr.pasoPendiente(cadena, v);
      if (!paso) return null;
      const permiso = await apr.puedeActuar(req.usuario, paso, v, ctx);
      return permiso.ok ? { v, paso, cadena, suplencia: !!permiso.suplencia } : null;
    };
    const mias = [];
    for (let i = 0; i < candidatas.length && mias.length < 50; i += 25) {
      const lote = await Promise.all(candidatas.slice(i, i + 25).map(evaluar));
      mias.push(...lote.filter(Boolean));
    }
    mias.splice(50);

    // Cada solicitud llega con el saldo del empleado y el impacto en la dotación
    const enriched = await Promise.all(mias.map(async ({ v, paso, cadena, suplencia }) => {
      const [balance, impact] = await Promise.all([
        leave.balanceOf(v.empleado),
        leave.coverageImpact(v.empleado, v.fechaInicio, v.fechaFin),
      ]);
      return {
        ...v.toJSON(), balance, impact,
        pasoPendiente: paso,
        etiquetaPaso: apr.PASOS[paso].etiqueta,
        cadena,
        esPasoFinal: cadena[cadena.length - 1] === paso,
        suplencia,
      };
    }));

    res.json({ data: enriched, total: enriched.length });
  } catch (err) { next(err); }
});

router.get('/balance/:employeeId', permit('vacations', 'read'), async (req, res, next) => {
  try {
    const empleado = await Empleado.findById(req.params.employeeId);
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
    const balance = await leave.balanceOf(empleado);
    res.json({ employeeId: empleado._id, nombreCompleto: empleado.nombreCompleto, fechaIngreso: empleado.fechaIngreso, ...balance });
  } catch (err) { next(err); }
});

// ─── Alta a nombre de un tercero (RRHH y jefaturas) ──────────────────────────
router.post('/', permit('vacations', 'write'), validarCuerpo(esq.vacacionCrear), async (req, res, next) => {
  try {
    const { employeeId, tipo, fechaInicio, fechaFin, motivo } = req.body;
    const empleado = await Empleado.findById(employeeId);
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

    const check = await leave.validateRequest({ empleado, tipo, fechaInicio, fechaFin });
    if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors });

    const vacation = await Vacacion.create({
      empleado: employeeId, tipo,
      fechaInicio: new Date(fechaInicio), fechaFin: new Date(fechaFin),
      diasTotales: check.diasTotales, motivo,
      solicitadoPor: req.usuario._id,
      avisosCobertura: check.warnings,
      dl713: {
        anosDeServicio: check.balance.anosDeServicio,
        diasAcumulados: check.balance.diasAcumulados,
        diasGozados: check.balance.diasGozados,
        diasDisponibles: check.balance.diasDisponibles,
        fechaLimite: check.balance.fechaLimite,
        riesgoTriplePago: check.balance.riesgoTriplePago,
      },
    });

    res.status(201).json({ vacation, warnings: check.warnings });
  } catch (err) { next(err); }
});

// ─── Aval del centro de trabajo (o autorización, si es el único paso) ───────
router.put('/:id/endorse', validarId(), permit('vacations', 'write'), validarCuerpo(esq.decision),
  async (req, res, next) => {
    try { await decidir(req, res, true); } catch (err) { next(err); }
  });

// ─── Autorización ────────────────────────────────────────────────────────────
router.put('/:id/approve', validarId(), permit('vacations', 'approve'), validarCuerpo(esq.decision),
  async (req, res, next) => {
    try { await decidir(req, res, true); } catch (err) { next(err); }
  });

// ─── Rechazo: lo hace quien decide el paso pendiente ─────────────────────────
router.put('/:id/reject', validarId(), permit('vacations', 'write'), validarCuerpo(esq.decision),
  async (req, res, next) => {
    try { await decidir(req, res, false); } catch (err) { next(err); }
  });

module.exports = router;
