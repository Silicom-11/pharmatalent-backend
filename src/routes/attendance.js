const router = require('express').Router();
const mongoose = require('mongoose');
const { registrarMarca } = require('../services/marcacion');
const Asistencia = require('../models/Asistencia');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const Local = require('../models/Local');
const { auth, authorize } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');
const { patronDeBusqueda } = require('../utils/busqueda');
const { aFechaLocal, inicioDelDia, finDelDia } = require('../utils/fechas');

router.use(auth);

router.get('/', scopeByRole, permit('attendance', 'read'), async (req, res, next) => {
  try {
    const { empleado, local, fecha, fechaInicio, fechaFin, estado, origen, search } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (empleado) filter.empleado = empleado;
    if (local) filter.local = local;
    if (estado) filter.estado = estado;
    if (origen) filter.origen = origen;
    // El día se toma en hora de Perú: `new Date('2026-10-02')` es medianoche
    // UTC, y el filtro arrancaba a las siete de la noche del día anterior
    if (fecha && aFechaLocal(fecha)) {
      filter.fecha = { $gte: inicioDelDia(fecha), $lte: finDelDia(fecha) };
    } else if (fechaInicio && fechaFin && aFechaLocal(fechaInicio) && aFechaLocal(fechaFin)) {
      filter.fecha = { $gte: inicioDelDia(fechaInicio), $lte: finDelDia(fechaFin) };
    }
    // El buscador de la pantalla busca por persona; antes la API lo ignoraba
    const patron = patronDeBusqueda(search);
    if (patron) {
      const coinciden = await Empleado.find({ $or: [{ nombres: patron }, { apellidos: patron }, { dni: patron }] })
        .select('_id').limit(500).lean();
      filter.empleado = filter.empleado || { $in: coinciden.map((e) => e._id) };
    }

    // Alcance de datos según el catálogo organizacional
    if (req.scope && !req.scope.isNational) {
      if (req.scope.scopeType === 'SELF') {
        filter.empleado = req.scope.employeeId;        // sólo su propia asistencia
      } else {
        const allowed = (req.scope.locationIds || []).map(String);
        filter.local = local && allowed.includes(String(local))
          ? local
          : { $in: req.scope.locationIds || [] };
      }
    }

    const [records, total] = await Promise.all([
      Asistencia.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional')
        .populate('local', 'nombre codigo')
        .sort({ fecha: -1, marcaEntrada: 1 })
        .skip(skip)
        .limit(limit),
      Asistencia.countDocuments(filter),
    ]);
    res.json({ data: records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

router.get('/report', scopeByRole, permit('attendance', 'read'), async (req, res, next) => {
  try {
    const { local, fechaInicio, fechaFin } = req.query;
    if (!aFechaLocal(fechaInicio) || !aFechaLocal(fechaFin)) {
      return res.status(400).json({ error: 'Indique fechaInicio y fechaFin (AAAA-MM-DD)' });
    }
    if (local && !mongoose.isValidObjectId(local)) return res.status(400).json({ error: 'Local inválido' });

    const match = { fecha: { $gte: inicioDelDia(fechaInicio), $lte: finDelDia(fechaFin) } };
    // El resumen también respeta el alcance: antes cualquier rol con lectura
    // obtenía los totales de toda la empresa
    const { scope } = req;
    if (scope && !scope.isNational) {
      if (scope.scopeType === 'SELF') match.empleado = new mongoose.Types.ObjectId(String(scope.employeeId));
      else {
        const propios = (scope.locationIds || []).map(String);
        if (local && !propios.includes(String(local))) return res.status(403).json({ error: 'Ese local no pertenece a su ámbito' });
        match.local = local ? new mongoose.Types.ObjectId(String(local)) : { $in: (scope.locationIds || []).map((id) => new mongoose.Types.ObjectId(String(id))) };
      }
    } else if (local) {
      match.local = new mongoose.Types.ObjectId(String(local));
    }

    const report = await Asistencia.aggregate([
      { $match: match },
      { $group: {
        _id: '$estado',
        count: { $sum: 1 },
        avgHours: { $avg: '$horasTrabajadas' },
      }},
    ]);
    res.json(report);
  } catch (err) { next(err); }
});

/**
 * Registro manual de la jefatura: la persona no pudo marcar en el terminal
 * —se cortó la luz, el lector no la reconoció— y su administrador lo deja
 * anotado.
 *
 * Antes esta ruta no funcionaba desde la pantalla (la interfaz enviaba
 * `empleado` y la ruta leía `employeeId`), no pedía motivo y dejaba marcar a
 * cualquier persona de la empresa. Ahora exige un motivo, se limita al
 * personal del propio alcance, no admite marcarse a uno mismo y queda con
 * origen CORRECCION: en el registro de asistencia se ve que no vino del
 * terminal y quién la puso.
 */
async function registroManual(req, res) {
  const empleadoId = req.body.empleado || req.body.employeeId;
  const motivo = String(req.body.motivo || req.body.nota || '').trim();
  if (!empleadoId) return res.status(400).json({ error: 'Indique el empleado' });
  if (motivo.length < 5) {
    return res.status(400).json({ error: 'Indique por qué se registra a mano: queda en el registro de asistencia' });
  }
  if (String(empleadoId) === String(req.usuario.empleado)) {
    return res.status(403).json({ error: 'Nadie puede registrar su propia asistencia a mano' });
  }

  const empleado = await Empleado.findById(empleadoId).select('nombres apellidos localActual estado');
  if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
  if (req.scope && !req.scope.isNational) {
    const permitidos = (req.scope.locationIds || []).map(String);
    if (!permitidos.includes(String(empleado.localActual))) {
      return res.status(403).json({ error: 'Esa persona no pertenece a su centro de trabajo' });
    }
  }

  const local = await Local.findById(req.body.local || req.body.locationId || empleado.localActual);
  if (!local) return res.status(400).json({ error: 'No se pudo determinar el centro de trabajo' });

  const cuenta = await Usuario.findOne({ empleado: empleado._id, activo: true }).select('rol').lean();
  const r = await registrarMarca({
    empleado, local, rol: cuenta?.rol, origen: 'CORRECCION',
    correccion: { por: req.usuario._id, motivo },
  });
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.status(201).json({ accion: r.accion, record: r.record, registradoPor: req.usuario.correo });
}

// Las dos rutas conservan su nombre para la interfaz; el servicio decide si
// la marca es entrada o salida según la jornada que la persona tenga abierta
router.post('/clock-in', scopeByRole, permit('attendance', 'write'), validarCuerpo(esq.asistenciaEntrada),
  async (req, res, next) => { try { await registroManual(req, res); } catch (err) { next(err); } });
router.post('/clock-out', scopeByRole, permit('attendance', 'write'), validarCuerpo(esq.asistenciaSalida),
  async (req, res, next) => { try { await registroManual(req, res); } catch (err) { next(err); } });

module.exports = router;
