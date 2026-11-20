const router = require('express').Router();
const Horario = require('../models/Horario');
const Turno = require('../models/Turno');
const Empleado = require('../models/Empleado');
const Local = require('../models/Local');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { FORMATS, SHIFT_ROLES, requiredRoster, shiftTypesOf, formatOf } = require('../config/formats');
const staffing = require('../services/staffing');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');

router.use(auth);

// ─── Catálogo de formatos y su dotación ──────────────────────────────────────
router.get('/formats', (_req, res) => {
  res.json({
    formats: Object.entries(FORMATS).map(([codigo, f]) => ({
      codigo,
      etiqueta: f.etiqueta,
      descripcion: f.descripcion,
      shiftTypes: f.shiftTypes,
      roster: f.roster,
      nightRoster: f.nightRoster || null,
      allowSubstitution: f.allowSubstitution,
      requiresAdmin: f.requiresAdmin,
      maxTraineesPerShift: f.maxTraineesPerShift,
      totalPerShift: Object.values(f.roster).reduce((a, n) => a + n, 0),
    })),
    roles: SHIFT_ROLES,
  });
});

// ─── Dotación requerida de un local, turno por turno ─────────────────────────
router.get('/requirements/:locationId', permit('schedules', 'read'), async (req, res, next) => {
  try {
    const local = await Local.findById(req.params.locationId).populate('zona', 'nombre');
    if (!local) return res.status(404).json({ error: 'Centro de trabajo no encontrado' });

    const fmt = formatOf(local);
    const tipos = shiftTypesOf(local);

    res.json({
      local: {
        _id: local._id, nombre: local.nombre, marca: local.marca,
        codigo: local.codigo, formato: local.formato, tipo: local.tipo,
        zona: local.zona?.nombre,
      },
      formato: { codigo: local.formato, etiqueta: fmt.etiqueta, descripcion: fmt.descripcion,
        allowSubstitution: fmt.allowSubstitution, maxTraineesPerShift: fmt.maxTraineesPerShift },
      turnos: tipos.map((tipoTurno) => {
        const roster = requiredRoster(local, tipoTurno);
        return {
          tipoTurno,
          horario: local.turnos?.horario?.[tipoTurno] || null,
          roster: Object.entries(roster).map(([rol, count]) => ({
            rol, etiqueta: SHIFT_ROLES[rol]?.etiqueta || rol, count, legal: !!SHIFT_ROLES[rol]?.legal,
          })),
          total: Object.values(roster).reduce((a, n) => a + n, 0),
        };
      }),
    });
  } catch (err) { next(err); }
});

// ─── Listado con alcance ─────────────────────────────────────────────────────
router.get('/', scopeByRole, permit('schedules', 'read'), async (req, res, next) => {
  try {
    const { local, estado, inicioSemana } = req.query;
    const filter = {};
    if (local) filter.local = local;
    if (estado) filter.estado = estado;
    if (inicioSemana) filter.inicioSemana = new Date(inicioSemana);

    if (req.scope && !req.scope.isNational) {
      if (req.scope.scopeType === 'SELF') {
        const employeeShifts = await Turno.find({ 'asignaciones.empleado': req.scope.employeeId })
          .distinct('horario');
        filter._id = { $in: employeeShifts };
      } else {
        const allowed = (req.scope.locationIds || []).map(String);
        filter.local = local && allowed.includes(String(local))
          ? local
          : { $in: req.scope.locationIds || [] };
      }
    }

    const schedules = await Horario.find(filter)
      .populate('local', 'nombre marca codigo formato tipo')
      .populate('creadoPor', 'correo')
      .sort({ inicioSemana: -1 });
    res.json(schedules);
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('schedules', 'read'), async (req, res, next) => {
  try {
    const horario = await Horario.findById(req.params.id)
      .populate('local')
      .populate('creadoPor', 'correo');
    if (!horario) return res.status(404).json({ error: 'Cronograma no encontrado' });

    const turnos = await Turno.find({ horario: horario._id })
      .populate('asignaciones.empleado', 'nombres apellidos tipoProfesional esPracticante')
      .sort({ fecha: 1, tipoTurno: 1 });

    const fmt = formatOf(horario.local);
    res.json({
      ...horario.toObject(),
      formato: { codigo: horario.local?.formato, etiqueta: fmt.etiqueta, descripcion: fmt.descripcion },
      turnos,
    });
  } catch (err) { next(err); }
});

// ─── Generación automática según el formato del local ────────────────────────
router.post('/generate', permit('schedules', 'write'), validarCuerpo(esq.horarioGenerar), async (req, res, next) => {
  try {
    // El esquema acepta el centro como `local` o `locationId`: se leen los dos
    const { inicioSemana } = req.body;
    const locationId = req.body.locationId || req.body.local;
    const local = await Local.findById(locationId);
    if (!local) return res.status(404).json({ error: 'Centro de trabajo no encontrado' });

    // validarCuerpo ya entrega la fecha como Date anclada a la medianoche local.
    // Antes se volvía a leer como texto 'AAAA-MM-DD' y String(Date) no tiene esa
    // forma: «Generar cronograma» respondía siempre «fecha inválida».
    if (!(inicioSemana instanceof Date) || Number.isNaN(inicioSemana.getTime())) {
      return res.status(400).json({ error: 'Fecha de inicio de semana inválida' });
    }
    const inicio = new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate());
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 6);

    const existing = await Horario.findOne({ local: locationId, inicioSemana: inicio });
    if (existing) return res.status(409).json({ error: 'Ya existe un cronograma para esa semana' });

    // Todo el personal del centro, no sólo QF y técnicos
    const staff = await Empleado.find({ localActual: locationId, estado: 'ACTIVO' })
      .populate('cargoActual', 'nombre codigo rolPorDefecto');

    if (!staff.length) {
      return res.status(400).json({ error: 'El centro de trabajo no tiene personal activo asignado' });
    }

    const horario = await Horario.create({
      local: locationId,
      inicioSemana: inicio,
      finSemana: fin,
      formato: local.formato,
      creadoPor: req.usuario._id,
    });

    const planned = staffing.generateWeek(local, staff, inicio);
    const created = await Turno.insertMany(
      planned.map((s) => ({ ...s, horario: horario._id }))
    );

    horario.validacion = staffing.summarizeSchedule(planned);
    await horario.save();

    res.status(201).json({
      horario,
      turnos: created,
      formato: { codigo: local.formato, etiqueta: formatOf(local).etiqueta },
      validacion: horario.validacion,
    });
  } catch (err) { next(err); }
});

// ─── Revalidación contra el formato vigente ──────────────────────────────────
router.post('/:id/validate', validarId(), permit('schedules', 'write'), async (req, res, next) => {
  try {
    const horario = await Horario.findById(req.params.id).populate('local');
    if (!horario) return res.status(404).json({ error: 'Cronograma no encontrado' });

    const turnos = await Turno.find({ horario: horario._id });
    const evaluated = [];

    for (const turno of turnos) {
      const cov = staffing.evaluateCoverage(turno.asignaciones, horario.local, turno.tipoTurno);
      turno.cobertura = {
        roles: cov.roles,
        porcentajeCobertura: cov.porcentajeCobertura,
        sustitucionesUsadas: cov.sustitucionesUsadas,
        severidad: cov.severidad,
      };
      turno.conflictos = cov.conflictos;
      turno.cumpleNormativa = cov.cumpleNormativa;
      await turno.save();
      evaluated.push({ fecha: turno.fecha, tipoTurno: turno.tipoTurno, conflictos: cov.conflictos, cobertura: turno.cobertura });
    }

    horario.formato = horario.local.formato;
    horario.validacion = staffing.summarizeSchedule(evaluated);
    await horario.save();

    res.json({ validacion: horario.validacion, turnos: evaluated.length });
  } catch (err) { next(err); }
});

// ─── Asignación manual de un empleado a un turno ──────────────────────────
router.put('/:id/shifts/:shiftId/assign', validarId(), permit('schedules', 'write'), validarCuerpo(esq.turnoAsignar), async (req, res, next) => {
  try {
    const { employeeId, rol, remove } = req.body;
    const horario = await Horario.findById(req.params.id).populate('local');
    if (!horario) return res.status(404).json({ error: 'Cronograma no encontrado' });

    const turno = await Turno.findOne({ _id: req.params.shiftId, horario: horario._id });
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

    if (remove) {
      turno.asignaciones = turno.asignaciones.filter((a) => String(a.empleado) !== String(employeeId));
    } else {
      const empleado = await Empleado.findById(employeeId).populate('cargoActual', 'rolPorDefecto');
      if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
      if (String(empleado.localActual) !== String(horario.local._id)) {
        return res.status(400).json({ error: 'El empleado no pertenece a este centro de trabajo' });
      }

      // Una sola asignación por persona y día
      const sameDay = await Turno.findOne({
        _id: { $ne: turno._id },
        local: horario.local._id,
        fecha: turno.fecha,
        'asignaciones.empleado': empleado._id,
      });
      if (sameDay) {
        return res.status(409).json({ error: `${empleado.nombres} ya tiene un turno asignado ese día` });
      }

      const ownRole = staffing.shiftRoleOf(empleado);
      const meta = rol || ownRole;
      const allowed = staffing.coverableRoles(empleado, formatOf(horario.local));
      if (!allowed.includes(meta)) {
        return res.status(400).json({
          error: `${empleado.nombres} (${SHIFT_ROLES[ownRole]?.etiqueta || ownRole}) no puede cubrir el puesto de ${SHIFT_ROLES[meta]?.etiqueta || meta} en el formato ${formatOf(horario.local).etiqueta}`,
        });
      }

      if (turno.asignaciones.some((a) => String(a.empleado) === String(empleado._id))) {
        return res.status(409).json({ error: 'El empleado ya está asignado a este turno' });
      }

      turno.asignaciones.push({ empleado: empleado._id, rol: meta, esSustituto: meta !== ownRole });
    }

    const cov = staffing.evaluateCoverage(turno.asignaciones, horario.local, turno.tipoTurno);
    turno.cobertura = {
      roles: cov.roles, porcentajeCobertura: cov.porcentajeCobertura,
      sustitucionesUsadas: cov.sustitucionesUsadas, severidad: cov.severidad,
    };
    turno.conflictos = cov.conflictos;
    turno.cumpleNormativa = cov.cumpleNormativa;
    await turno.save();

    // El cronograma se revalida en conjunto
    const all = await Turno.find({ horario: horario._id });
    horario.validacion = staffing.summarizeSchedule(all);
    await horario.save();

    const populated = await Turno.findById(turno._id)
      .populate('asignaciones.empleado', 'nombres apellidos tipoProfesional esPracticante');
    res.json({ turno: populated, validacion: horario.validacion });
  } catch (err) { next(err); }
});

// ─── Publicación: bloqueada por incumplimientos críticos ─────────────────────
router.put('/:id/publish', validarId(), permit('schedules', 'approve'), validarCuerpo(esq.horarioPublicar), async (req, res, next) => {
  try {
    const horario = await Horario.findById(req.params.id).populate('local', 'nombre formato');
    if (!horario) return res.status(404).json({ error: 'Cronograma no encontrado' });

    const critical = (horario.validacion?.conflictos || []).filter((c) => c.severidad === 'CRITICA');
    if (critical.length > 0) {
      return res.status(400).json({
        error: `No se puede publicar: ${critical.length} turno(s) sin Químico Farmacéutico. El local no puede operar sin Director Técnico.`,
        conflictos: critical,
      });
    }

    const major = (horario.validacion?.conflictos || []).filter((c) => c.severidad === 'MAYOR');
    if (major.length > 0 && !req.body.acknowledgeGaps) {
      return res.status(409).json({
        error: `El cronograma tiene ${major.length} turno(s) por debajo de la dotación del formato ${horario.local?.formato}. Confirme para publicar de todos modos.`,
        requiresAcknowledgement: true,
        conflictos: major,
      });
    }

    horario.estado = 'PUBLICADO';
    horario.publicadoPor = req.usuario._id;
    horario.publicadoEn = new Date();
    if (major.length > 0) horario.notas = `Publicado con ${major.length} brecha(s) de dotación reconocida(s).`;
    await horario.save();

    res.json(horario);
  } catch (err) { next(err); }
});

module.exports = router;
