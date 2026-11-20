const router = require('express').Router();
const Capacitacion = require('../models/Capacitacion');
const Empleado = require('../models/Empleado');
const { auth, authorize } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit, employeeScopeFilter } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

router.use(auth);

// GET / - List trainings (filter by employee, type, status)
router.get('/', scopeByRole, permit('training', 'read'), async (req, res, next) => {
  try {
    const { empleado, tipo, estado } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (tipo) filter.tipo = tipo;
    if (estado) filter.estado = estado;

    // La formación de terceros sólo dentro del ámbito propio
    Object.assign(filter, await employeeScopeFilter(req.scope, Empleado));

    const [trainings, total] = await Promise.all([
      Capacitacion.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional')
        .sort({ fechaProgramada: -1 })
        .skip(skip)
        .limit(limit),
      Capacitacion.countDocuments(filter),
    ]);

    res.json({
      data: trainings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// ─── Cumplimiento: Dirección Técnica y SST ───────────────────────────────────
/**
 * Lo que la ley exige y cómo va cada persona, dentro del alcance de quien
 * consulta. Antes devolvía los QF de todo el país a cualquiera con lectura del
 * módulo —un administrador de botica veía a los de las demás— y la pantalla
 * no lo mostraba: esperaba una lista y recibía un objeto.
 *
 *  · Dirección Técnica: todo QF (titular o asistente) con BPA/BPD y la
 *    actualización DIGEMID completadas y vigentes (vencen al año).
 *  · SST: Ley 29783, art. 35 b), no menos de cuatro capacitaciones al año.
 *    Se mide lo programado hasta hoy: una sesión de diciembre no es deuda en
 *    octubre.
 */
// Las sesiones de seguridad y salud en el trabajo
const TIPO_SST = 'SEGURIDAD';

router.get('/compliance', scopeByRole, permit('training', 'read'), async (req, res, next) => {
  try {
    const ahora = new Date();
    const { scope } = req;
    const alcance = scope.isNational ? {}
      : scope.scopeType === 'SELF' ? { _id: scope.employeeId }
        : { localActual: { $in: scope.locationIds || [] } };

    // ── Dirección Técnica ────────────────────────────────────────────────────
    const qfs = await Empleado.find({ ...alcance, tipoProfesional: 'QF', estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
      .populate('localActual', 'nombre codigo marca')
      .populate('zona', 'nombre')
      .select('nombres apellidos dni numeroCQF vencimientoCQF localActual zona')
      .lean();
    const cursos = await Capacitacion.find({
      empleado: { $in: qfs.map((q) => q._id) }, tipo: { $in: ['DIGEMID', 'BPA'] }, estado: 'COMPLETADA',
    }).sort({ fechaCompletado: -1 }).lean();
    const ultimo = new Map();
    for (const c of cursos) {
      const k = `${c.empleado}|${c.tipo}`;
      if (!ultimo.has(k)) ultimo.set(k, c);
    }
    const vigencia = (c) => c && {
      completado: c.fechaCompletado, venceEn: c.venceEn, puntaje: c.puntaje,
      vencido: c.venceEn ? c.venceEn < ahora : false,
    };
    const details = qfs.map((qf) => {
      const digemid = vigencia(ultimo.get(`${qf._id}|DIGEMID`));
      const bpa = vigencia(ultimo.get(`${qf._id}|BPA`));
      return {
        empleado: {
          _id: qf._id, nombreCompleto: `${qf.nombres} ${qf.apellidos}`, dni: qf.dni,
          numeroCQF: qf.numeroCQF, vencimientoCQF: qf.vencimientoCQF,
          local: qf.localActual, zona: qf.zona,
        },
        digemid, bpa,
        cqfVencido: qf.vencimientoCQF ? qf.vencimientoCQF < ahora : false,
        cumple: !!(digemid && bpa && !digemid.vencido && !bpa.vencido),
      };
    }).sort((a, b) => Number(a.cumple) - Number(b.cumple)
      || a.empleado.nombreCompleto.localeCompare(b.empleado.nombreCompleto));

    const resumen = {
      totalQF: details.length,
      cumplen: details.filter((d) => d.cumple).length,
      noCumplen: details.filter((d) => !d.cumple).length,
      cqfVencido: details.filter((d) => d.cqfVencido).length,
    };

    // ── Seguridad y salud en el trabajo ──────────────────────────────────────
    const anio = ahora.getFullYear();
    const personal = await Empleado.find({ ...alcance, estado: { $in: ['ACTIVO', 'VACACIONES', 'LICENCIA'] } })
      .populate('localActual', 'nombre codigo')
      .select('nombres apellidos localActual').lean();
    const porPersona = await Capacitacion.aggregate([
      { $match: {
        empleado: { $in: personal.map((e) => e._id) }, tipo: TIPO_SST,
        fechaProgramada: { $gte: new Date(anio, 0, 1), $lt: new Date(anio + 1, 0, 1) },
        estado: { $ne: 'CANCELADA' },
      } },
      { $group: {
        _id: '$empleado',
        completadas: { $sum: { $cond: [{ $eq: ['$estado', 'COMPLETADA'] }, 1, 0] } },
        // Programadas cuya fecha ya pasó sin completarse
        atrasadas: { $sum: { $cond: [{ $and: [{ $ne: ['$estado', 'COMPLETADA'] }, { $lt: ['$fechaProgramada', ahora] }] }, 1, 0] } },
        // Recuperaciones de una sesión a la que no asistió
        recuperaciones: { $sum: { $cond: [{ $and: [{ $ne: ['$estado', 'COMPLETADA'] }, { $regexMatch: { input: '$nombre', regex: /\(recuperación\)$/ } }] }, 1, 0] } },
        programadas: { $sum: { $cond: [{ $ne: ['$estado', 'COMPLETADA'] }, 1, 0] } },
      } },
    ]);
    const sstDe = new Map(porPersona.map((p) => [String(p._id), p]));
    const pendientes = [];
    let alDia = 0, sinRegistro = 0, completadas = 0;
    for (const e of personal) {
      const p = sstDe.get(String(e._id));
      if (!p) { sinRegistro++; continue; }
      completadas += p.completadas;
      if (!p.atrasadas && !p.recuperaciones) { alDia++; continue; }
      pendientes.push({
        empleado: { _id: e._id, nombreCompleto: `${e.nombres} ${e.apellidos}`, local: e.localActual },
        completadas: p.completadas, atrasadas: p.atrasadas, recuperaciones: p.recuperaciones,
      });
    }
    pendientes.sort((a, b) => b.atrasadas - a.atrasadas || a.completadas - b.completadas);

    res.json({
      resumen,
      details,
      sst: {
        anio,
        exigidasPorAnio: 4,
        base: 'Ley 29783, art. 35 b)',
        personal: personal.length,
        alDia,
        conPendientes: pendientes.length,
        sinRegistro,
        promedioCompletadas: personal.length ? Math.round((completadas / personal.length) * 10) / 10 : 0,
        pendientes: pendientes.slice(0, 200),
      },
    });
  } catch (err) { next(err); }
});

// POST / - Create training
router.post('/', permit('training', 'write'), validarCuerpo(esq.capacitacionCrear), async (req, res, next) => {
  try {
    const training = await Capacitacion.create(req.body);
    res.status(201).json(training);
  } catch (err) { next(err); }
});

// PUT /:id - Update training
router.put('/:id', validarId(), permit('training', 'write'), validarCuerpo(esq.capacitacionEditar), async (req, res, next) => {
  try {
    const training = await Capacitacion.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!training) return res.status(404).json({ error: 'Capacitación no encontrada' });
    res.json(training);
  } catch (err) { next(err); }
});

module.exports = router;
