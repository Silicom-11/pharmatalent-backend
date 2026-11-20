const router = require('express').Router();
const Boleta = require('../models/Boleta');
const Empleado = require('../models/Empleado');
const Planilla = require('../models/Planilla');
const { auth, authorize } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const payrollEngine = require('../services/payroll');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { aFechaLocal, finDelDia, comoTexto } = require('../utils/fechas');
const { armarBoleta } = require('../services/boleta');
const { cierreDelPeriodo, diasSinLiquidar } = require('../services/periodo');
const { paginacionDe } = require('../middleware/paginacion');
const { sincronizarPlanilla } = require('../services/planilla');
const exposicion = require('../config/exposicion');

/** En modo exposición la nómina que se ve es la de Junín (aprobar y pagar siguen siendo del período entero) */
const soloJunin = async () => (exposicion.soloJunin() ? { empleado: { $in: await exposicion.plantillaJunin() } } : {});

router.use(auth);

// Las rutas declaraban «:period» y leían req.params.periodo, que llegaba vacío:
// calcular respondía siempre «formato inválido», el resumen sumaba todas las
// boletas de la historia y «pagar el período» pagaba las aprobadas de todos
// los meses. El parámetro se llama como se lee, y su forma se valida una vez.
const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
router.param('periodo', (req, res, next, periodo) => {
  if (!PERIODO.test(periodo)) return res.status(400).json({ error: 'Formato de período inválido. Use AAAA-MM' });
  next();
});

// Las planillas del año y medio más reciente, para elegir período sabiendo
// en qué estado está cada uno (el ciclo va un mes detrás del calendario)
router.get('/periodos', permit('payroll', 'read'), async (_req, res, next) => {
  try {
    const planillas = await Planilla.find()
      .select('periodo estado empleadosIncluidos totalNeto costoEmpresa')
      .sort({ periodo: -1 }).limit(18).lean();
    // El que está en curso es el más reciente ya calculado y aún no pagado;
    // si no hay, el último que salió de borrador
    const enCurso = planillas.find((p) => ['CALCULADA', 'APROBADA'].includes(p.estado))
      || planillas.find((p) => p.estado !== 'BORRADOR');
    res.json({ data: planillas, enCurso: enCurso?.periodo || null });
  } catch (err) { next(err); }
});

// GET / - List payroll records (with pagination, filter by period/status)
router.get('/', permit('payroll', 'read'), async (req, res, next) => {
  try {
    const { periodo, estado, empleado } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (periodo) filter.periodo = periodo;
    if (estado) filter.estado = estado;
    if (empleado) filter.empleado = empleado;
    if (!empleado) Object.assign(filter, await soloJunin());

    const [records, total] = await Promise.all([
      Boleta.find(filter)
        .populate('empleado', 'nombres apellidos dni tipoProfesional')
        .populate('aprobadoPor', 'correo')
        .sort({ periodo: -1 })
        .skip(skip)
        .limit(limit),
      Boleta.countDocuments(filter),
    ]);

    res.json({
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

/**
 * No existe alta manual de boletas.
 *
 * Una boleta es el resultado de liquidar un período contra la asistencia
 * registrada. Permitir crearla a mano sería permitir inventar una remuneración
 * sin respaldo. Se usa POST /calculate/:period.
 */
router.post('/', permit('payroll', 'write'), (_req, res) => {
  res.status(405).json({
    error: 'Las boletas se generan calculando el período, no se crean a mano.',
    usar: 'POST /api/payroll/calculate/:periodo',
  });
});

// PUT /:id - Update payroll record
/**
 * Lo único editable a mano es la observación.
 *
 * Antes esta ruta volcaba el cuerpo entero sobre el documento, de modo que
 * quien tenía permiso de escritura podía fijar `status: PAGADO` sin pasar por
 * la aprobación ni dejar constancia de pago. Los importes los produce el motor
 * de cálculo; el estado, las rutas de aprobación y pago.
 */
router.put('/:id', validarId(), permit('payroll', 'write'), validarCuerpo(esq.payrollEditar),
  async (req, res, next) => {
    try {
      const payroll = await Boleta.findById(req.params.id);
      if (!payroll) return res.status(404).json({ error: 'Registro de nómina no encontrado' });
      if (payroll.estado === 'PAGADO') {
        return res.status(400).json({ error: 'No se puede modificar una nómina ya pagada' });
      }

      Object.assign(payroll, req.body);
      if (req.body.notas !== undefined) {
        payroll.notaPor = req.usuario._id;
        payroll.notaEn = new Date();
      }
      await payroll.save();
      res.json({
        ...payroll.toJSON(),
        ignorado: req.descartados.length
          ? `Se ignoraron campos no editables: ${req.descartados.join(', ')}`
          : undefined,
      });
    } catch (err) { next(err); }
  });

/**
 * Cálculo del período para todo el personal activo.
 *
 * Cada boleta se arma consolidando lo que el mes dejó registrado: asistencia
 * marcada, horas extra, tardanzas, descansos médicos y vacaciones gozadas.
 */
router.post('/calculate/:periodo', permit('payroll', 'write'), validarCuerpo(esq.payrollCalcular), async (req, res, next) => {
  try {
    const { periodo } = req.params;
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ error: 'Formato de período inválido. Use YYYY-MM' });
    }

    const { recalculate = false, local } = req.body || {};
    // Quien ingresó después del período no tiene boleta de ese mes
    const [a, m] = periodo.split('-').map(Number);
    const filtro = { estado: { $ne: 'CESADO' }, fechaIngreso: { $lte: new Date(a, m, 0, 23, 59, 59) } };
    if (local) filtro.localActual = local;

    const empleados = await Empleado.find(filtro).populate('cargoActual', 'nombre rolPorDefecto');
    const resumen = { created: 0, updated: 0, skipped: 0, errors: [] };
    const totales = { ingresos: 0, descuentos: 0, neto: 0, aportes: 0, costoEmpresa: 0 };

    for (const emp of empleados) {
      try {
        const existente = await Boleta.findOne({ empleado: emp._id, periodo });
        if (existente && !recalculate) { resumen.skipped++; continue; }
        if (existente && ['APROBADO', 'PAGADO'].includes(existente.estado)) { resumen.skipped++; continue; }

        const boleta = await payrollEngine.computePayroll(emp, periodo);

        const doc = existente || new Boleta({ empleado: emp._id, periodo });
        Object.assign(doc, boleta, { estado: 'CALCULADO', calculadoEn: new Date() });
        await doc.save();

        totales.ingresos += boleta.ingresos.total;
        totales.descuentos += boleta.descuentos.total;
        totales.neto += boleta.netoAPagar;
        totales.aportes += boleta.aportesEmpleador.total;
        totales.costoEmpresa += boleta.costoEmpresa;

        existente ? resumen.updated++ : resumen.created++;
      } catch (err) {
        resumen.errors.push({ empleado: `${emp.nombres} ${emp.apellidos}`, error: err.message });
      }
    }

    for (const k of Object.keys(totales)) totales[k] = Math.round(totales[k] * 100) / 100;
    await sincronizarPlanilla(periodo, req.usuario);
    res.json({ periodo, ...resumen, totales });
  } catch (err) { next(err); }
});

/** Resumen del período: masa salarial, aportes y costo total para la empresa */
router.get('/summary/:periodo', permit('payroll', 'read'), async (req, res, next) => {
  try {
    const { periodo } = req.params;
    const boletas = await Boleta.find({ periodo, ...(await soloJunin()) })
      .populate('empleado', 'nombres apellidos tipoProfesional localActual');

    if (!boletas.length) {
      return res.json({ periodo, calculado: false, empleados: 0 });
    }

    const suma = (f) => Math.round(boletas.reduce((a, b) => a + (f(b) || 0), 0) * 100) / 100;

    const porEstado = boletas.reduce((acc, b) => {
      acc[b.estado] = (acc[b.estado] || 0) + 1;
      return acc;
    }, {});

    // Conceptos que sólo aparecen en ciertos meses
    const conGratificacion = boletas.filter((b) => b.gratificacion?.aplica).length;
    const conCts = boletas.filter((b) => b.cts?.aplica).length;
    const conSubsidio = boletas.filter((b) => (b.ingresos?.subsidioEsSalud || 0) > 0);
    const conTardanza = boletas.filter((b) => (b.descuentos?.tardanza?.monto || 0) > 0);

    res.json({
      periodo,
      calculado: true,
      empleados: boletas.length,
      porEstado,
      ingresos: {
        basico: suma((b) => b.ingresos?.basico),
        asignacionFamiliar: suma((b) => b.ingresos?.asignacionFamiliar),
        horasExtra: suma((b) => b.ingresos?.horasExtra?.monto),
        subsidioEsSalud: suma((b) => b.ingresos?.subsidioEsSalud),
        total: suma((b) => b.ingresos?.total),
      },
      descuentos: {
        pension: suma((b) => b.descuentos?.pension?.total),
        rentaQuinta: suma((b) => b.descuentos?.rentaQuinta?.monto),
        tardanza: suma((b) => b.descuentos?.tardanza?.monto),
        total: suma((b) => b.descuentos?.total),
      },
      aportesEmpleador: {
        esSalud: suma((b) => b.aportesEmpleador?.esSalud),
        sctr: suma((b) => b.aportesEmpleador?.sctr),
        total: suma((b) => b.aportesEmpleador?.total),
      },
      gratificacion: { empleados: conGratificacion, total: suma((b) => b.gratificacion?.total) },
      cts: { empleados: conCts, total: suma((b) => b.cts?.monto) },
      netoAPagar: suma((b) => b.netoAPagar),
      costoEmpresa: suma((b) => b.costoEmpresa),
      horasExtraTotales: suma((b) => b.ingresos?.horasExtra?.horas),
      alertas: {
        conSubsidioPorRecuperar: conSubsidio.length,
        montoSubsidioPorRecuperar: Math.round(conSubsidio.reduce((a, b) => a + (b.ingresos?.subsidioEsSalud || 0), 0) * 100) / 100,
        conDescuentoTardanza: conTardanza.length,
      },
    });
  } catch (err) { next(err); }
});

/** Recalcula una boleta puntual sin tocar el resto del período */
router.post('/:id/recalculate', validarId(), permit('payroll', 'write'), async (req, res, next) => {
  try {
    const boleta = await Boleta.findById(req.params.id);
    if (!boleta) return res.status(404).json({ error: 'Boleta no encontrada' });
    if (['APROBADO', 'PAGADO'].includes(boleta.estado)) {
      return res.status(400).json({ error: `No se puede recalcular una boleta en estado ${boleta.estado}` });
    }

    const emp = await Empleado.findById(boleta.empleado).populate('cargoActual', 'nombre rolPorDefecto');
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    const calculada = await payrollEngine.computePayroll(emp, boleta.periodo);
    Object.assign(boleta, calculada, { estado: 'CALCULADO', calculadoEn: new Date() });
    await boleta.save();
    await sincronizarPlanilla(boleta.periodo, req.usuario);

    res.json(boleta);
  } catch (err) { next(err); }
});

router.put('/:id/approve', validarId(), permit('payroll', 'approve'), async (req, res, next) => {
  try {
    const payroll = await Boleta.findById(req.params.id);
    if (!payroll) return res.status(404).json({ error: 'Registro de nómina no encontrado' });
    if (payroll.estado === 'BORRADOR') {
      return res.status(400).json({ error: 'La nómina debe estar calculada antes de aprobar' });
    }
    if (payroll.estado === 'PAGADO') {
      return res.status(400).json({ error: 'La nómina ya fue pagada' });
    }
    // Aprobar es autorizar un egreso: quien aprueba no autoriza el suyo
    if (esPropia(req, payroll)) {
      return res.status(403).json({ error: 'No puede aprobar su propia boleta: la aprueba otro responsable de planilla' });
    }

    payroll.estado = 'APROBADO';
    payroll.aprobadoPor = req.usuario._id;
    payroll.aprobadoEn = new Date();
    await payroll.save();
    await sincronizarPlanilla(payroll.periodo, req.usuario);
    res.json(payroll);
  } catch (err) { next(err); }
});

/**
 * Registro del pago.
 *
 * Aprobar una boleta autoriza el egreso; pagarla es un hecho posterior con
 * fecha propia, y esa fecha es la que se declara en el PLAME y la que cuenta
 * para los intereses por pago tardío. Por eso son dos pasos y no uno.
 */
router.put('/:id/pay', validarId(), permit('payroll', 'approve'), validarCuerpo(esq.payrollPagar), async (req, res, next) => {
  try {
    const { paymentDate, medioDePago, referenciaPago } = req.body;
    const boleta = await Boleta.findById(req.params.id).populate('empleado', 'nombres apellidos');
    if (!boleta) return res.status(404).json({ error: 'Boleta no encontrada' });

    if (boleta.estado !== 'APROBADO') {
      return res.status(400).json({
        error: boleta.estado === 'PAGADO'
          ? `Esta boleta ya figura pagada el ${comoTexto(boleta.pagadoEn)}`
          : 'Sólo se puede registrar el pago de una boleta aprobada',
      });
    }

    const fecha = paymentDate ? aFechaLocal(paymentDate) : new Date();
    if (!fecha) return res.status(400).json({ error: 'Fecha de pago inválida' });
    // Una fecha futura convertiría la constancia en una promesa
    if (fecha > finDelDia()) {
      return res.status(400).json({ error: 'La fecha de pago no puede ser posterior a hoy' });
    }

    boleta.estado = 'PAGADO';
    boleta.pagadoEn = fecha;
    boleta.pagadoPor = req.usuario._id;
    if (medioDePago) boleta.medioDePago = medioDePago;
    if (referenciaPago) boleta.referenciaPago = referenciaPago;
    await boleta.save();
    await sincronizarPlanilla(boleta.periodo, req.usuario);

    // El empleado se entera de que su boleta ya está disponible
    const cuenta = await Usuario.findOne({ empleado: boleta.empleado._id }).select('_id');
    if (cuenta) {
      await Notificacion.create({
        usuario: cuenta._id,
        tipo: 'SISTEMA',
        titulo: `Boleta de ${boleta.periodo} disponible`,
        mensaje: `Se registró el pago de su boleta del período ${boleta.periodo}.`,
        prioridad: 'MEDIA',
      });
    }

    res.json(boleta);
  } catch (err) { next(err); }
});

const esPropia = (req, boleta) => req.usuario.empleado
  && String(boleta.empleado?._id || boleta.empleado) === String(req.usuario.empleado);

/**
 * Aprobación del período completo.
 *
 * Sólo existía la aprobación boleta por boleta: para aprobar un mes de
 * cuatrocientas boletas había que pulsar cuatrocientas veces, y el período se
 * quedaba «esperando a RRHH». Se aprueban las calculadas, salvo la de quien
 * aprueba: esa queda para otro responsable, como en cualquier egreso.
 */
router.post('/:periodo/approve-all', permit('payroll', 'approve'), async (req, res, next) => {
  try {
    const { periodo } = req.params;
    const filtro = { periodo, estado: 'CALCULADO' };
    if (req.usuario.empleado) filtro.empleado = { $ne: req.usuario.empleado };
    const r = await Boleta.updateMany(filtro, {
      $set: { estado: 'APROBADO', aprobadoPor: req.usuario._id, aprobadoEn: new Date() },
    });
    if (!r.modifiedCount) {
      const soloLaPropia = req.usuario.empleado
        && await Boleta.exists({ periodo, estado: 'CALCULADO', empleado: req.usuario.empleado });
      if (soloLaPropia) {
        return res.status(409).json({ error: 'Sólo queda su propia boleta por aprobar: la aprueba otro responsable de planilla (Administración).' });
      }
      const borradores = await Boleta.countDocuments({ periodo, estado: 'BORRADOR' });
      return res.status(400).json({
        error: borradores
          ? `No hay boletas calculadas en ${periodo}: ${borradores} siguen en borrador. Calcule el período primero.`
          : `No hay boletas por aprobar en ${periodo}`,
      });
    }
    const propiaPendiente = req.usuario.empleado
      ? await Boleta.exists({ periodo, estado: 'CALCULADO', empleado: req.usuario.empleado })
      : null;
    const planilla = await sincronizarPlanilla(periodo, req.usuario);
    res.json({ periodo, aprobadas: r.modifiedCount, propiaPendiente: !!propiaPendiente, estadoPlanilla: planilla?.estado });
  } catch (err) { next(err); }
});

/** Pago del período completo: es como se paga en la práctica, no boleta a boleta */
router.post('/:periodo/pay-all', permit('payroll', 'approve'), validarCuerpo(esq.payrollPagar), async (req, res, next) => {
  try {
    const { paymentDate, medioDePago, referenciaPago } = req.body;
    const fecha = paymentDate ? aFechaLocal(paymentDate) : new Date();
    if (!fecha || fecha > finDelDia()) {
      return res.status(400).json({ error: 'Fecha de pago inválida o posterior a hoy' });
    }

    const pendientes = await Boleta.find({ periodo: req.params.periodo, estado: 'APROBADO' })
      .select('_id empleado netoAPagar');
    if (!pendientes.length) {
      const calculadas = await Boleta.countDocuments({ periodo: req.params.periodo, estado: 'CALCULADO' });
      return res.status(400).json({
        error: calculadas
          ? `No hay boletas aprobadas en ${req.params.periodo}. Hay ${calculadas} calculada(s) esperando aprobación.`
          : `No hay boletas aprobadas pendientes de pago en ${req.params.periodo}`,
      });
    }

    const total = pendientes.reduce((s, b) => s + (b.netoAPagar || 0), 0);
    await Boleta.updateMany(
      { _id: { $in: pendientes.map((b) => b._id) } },
      {
        $set: {
          estado: 'PAGADO',
          pagadoEn: fecha,
          pagadoPor: req.usuario._id,
          medioDePago: medioDePago || 'DEPOSITO_CUENTA',
          referenciaPago: referenciaPago || undefined,
        },
      }
    );

    const cuentas = await Usuario.find({ empleado: { $in: pendientes.map((b) => b.empleado) } })
      .select('_id').lean();
    if (cuentas.length) {
      await Notificacion.insertMany(cuentas.map((c) => ({
        usuario: c._id,
        tipo: 'SISTEMA',
        titulo: `Boleta de ${req.params.periodo} disponible`,
        mensaje: `Se registró el pago de su boleta del período ${req.params.periodo}.`,
        prioridad: 'MEDIA',
      })));
    }

    await sincronizarPlanilla(req.params.periodo, req.usuario);
    res.json({
      periodo: req.params.periodo,
      pagadas: pendientes.length,
      montoTotal: Math.round(total * 100) / 100,
      fechaPago: fecha,
      avisados: cuentas.length,
    });
  } catch (err) { next(err); }
});

/**
 * Boleta de pago con el contenido que exige el D.S. 001-98-TR (arts. 18 y 19).
 *
 * Es la misma estructura que ve el empleado en su propio perfil: se arma
 * una sola vez para que la pantalla, la impresión y una futura exportación al
 * PLAME no puedan discrepar.
 */
router.get('/:id/boleta', validarId(), permit('payroll', 'read'), async (req, res, next) => {
  try {
    const boleta = await Boleta.findById(req.params.id).populate({
      path: 'empleado',
      select: 'nombres apellidos dni fechaIngreso sistemaPensiones cuspp cuentaBancaria cargoActual localActual',
      populate: [
        { path: 'cargoActual', select: 'nombre' },
        { path: 'localActual', select: 'nombre marca' },
      ],
    });
    if (!boleta) return res.status(404).json({ error: 'Boleta no encontrada' });
    res.json(armarBoleta(boleta));
  } catch (err) { next(err); }
});

/**
 * Días trabajados que quedaron fuera de una planilla ya pagada.
 *
 * Si el período se pagó antes de terminar, lo trabajado después existe en el
 * registro de asistencia pero no lo cubre ninguna boleta, y recalcular está
 * bloqueado con razón. Esto lo saca a la luz para pagarlo como reintegro.
 */
router.get('/:periodo/sin-liquidar', permit('payroll', 'read'), async (req, res, next) => {
  try {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.periodo)) {
      return res.status(400).json({ error: 'Formato de período inválido. Use AAAA-MM' });
    }
    res.json(await diasSinLiquidar(req.params.periodo));
  } catch (err) { next(err); }
});

/** Estado de cierre del período: si ya salió, desde cuándo y cuánto */
router.get('/:periodo/cierre', permit('payroll', 'read'), async (req, res, next) => {
  try {
    const cierre = await cierreDelPeriodo(req.params.periodo);
    res.json(cierre || { periodo: req.params.periodo, cerrado: false });
  } catch (err) { next(err); }
});

module.exports = router;
