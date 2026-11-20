const router = require('express').Router();
const { veRemuneracion, proyeccionLiquidacion } = require('../utils/remuneracion');
const Liquidacion = require('../models/Liquidacion');
const Empleado = require('../models/Empleado');
const Contrato = require('../models/Contrato');
const Boleta = require('../models/Boleta');
const Vacacion = require('../models/Vacacion');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit, employeeScopeFilter } = require('../middleware/scopeByRole');
const { validarCuerpo, validarId } = require('../middleware/validar');
const { paginacionDe } = require('../middleware/paginacion');
const esq = require('../validators/esquemas');
const { calcularLiquidacion } = require('../services/liquidacion');
const { balanceOf } = require('../services/leaveRules');
const { aFechaLocal, comoTexto, finDelDia } = require('../utils/fechas');
const P = require('../config/payrollParams');
const C = require('../config/ceseParams');
const { revocarAccesoPorCese } = require('../services/accesos');

/**
 * Cese y liquidación de beneficios sociales.
 *
 * Cesar a alguien no es cambiarle un estado: es cerrar un vínculo laboral y
 * pagar en 48 horas lo que se devengó. Este módulo hace las dos cosas en el
 * orden correcto —primero se calcula lo que se le debe, luego se aprueba,
 * luego se paga, y sólo entonces el empleado queda cesado— porque al revés
 * se pierde el rastro de lo que había que pagarle.
 */

router.use(auth);

/** Catálogo de causas, para que la interfaz no las escriba a mano */
router.get('/causas', permit('contracts', 'read'), (_req, res) => {
  res.json(Object.entries(C.CAUSAS).map(([codigo, meta]) => ({ codigo, ...meta })));
});

// ─── Listado ─────────────────────────────────────────────────────────────────
router.get('/', scopeByRole, permit('contracts', 'read'), async (req, res, next) => {
  try {
    const { estado, causa } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);

    const filtro = { ...(await employeeScopeFilter(req.scope, Empleado)) };
    if (estado) filtro.estado = estado;
    if (causa) filtro.causa = causa;

    const [data, total] = await Promise.all([
      Liquidacion.find(filtro)
        // Quien no administra remuneraciones ve el estado y los plazos, no los montos
        .select(proyeccionLiquidacion(req.usuario.rol))
        .populate('empleado', 'nombres apellidos dni cargoActual localActual')
        .populate('aprobadaPor', 'correo')
        .sort({ fechaCese: -1 })
        .skip(skip).limit(limit),
      Liquidacion.countDocuments(filtro),
    ]);

    // Lo que importa vigilar: las que ya pasaron el plazo de 48 horas
    const vencidas = await Liquidacion.countDocuments({
      ...filtro,
      estado: { $in: ['BORRADOR', 'APROBADA'] },
      fechaCese: { $lt: new Date(Date.now() - C.PLAZO_PAGO_HORAS * 3600000) },
    });

    res.json({
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      resumen: {
        total: await Liquidacion.countDocuments(filtro),
        borradores: await Liquidacion.countDocuments({ ...filtro, estado: 'BORRADOR' }),
        porPagar: await Liquidacion.countDocuments({ ...filtro, estado: 'APROBADA' }),
        fueraDePlazo: vencidas,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), scopeByRole, permit('contracts', 'read'), async (req, res, next) => {
  try {
    // Antes devolvía la liquidación de cualquier persona del país, con su
    // cuenta bancaria, a cualquiera que leyera contratos y supiera el id
    const ve = veRemuneracion(req.usuario.rol);
    const liq = await Liquidacion.findOne({ _id: req.params.id, ...(await employeeScopeFilter(req.scope, Empleado)) })
      .select(proyeccionLiquidacion(req.usuario.rol))
      .populate({
        path: 'empleado',
        select: `nombres apellidos dni fechaIngreso cargoActual localActual${ve ? ' cuentaBancaria' : ''}`,
        populate: [{ path: 'cargoActual', select: 'nombre' }, { path: 'localActual', select: 'nombre' }],
      })
      .populate('calculadaPor aprobadaPor pagadaPor', 'correo');
    if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
    res.json(liq);
  } catch (err) { next(err); }
});

/**
 * Simulación previa.
 *
 * Antes de cesar a alguien conviene saber cuánto cuesta. Esto calcula sin
 * escribir nada: ni crea la liquidación ni toca al empleado.
 */
router.post('/simular', permit('contracts', 'read'), validarCuerpo(esq.liquidacionSimular),
  async (req, res, next) => {
    try {
      const datos = await reunirDatos(req.body);
      if (datos.error) return res.status(datos.estado || 400).json({ error: datos.error });
      res.json({ simulacion: true, ...calcularLiquidacion(datos.empleado, datos.opciones) });
    } catch (err) {
      if (/Causa de cese|fecha de|anterior al ingreso/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  });

/**
 * Reúne del sistema lo que el cálculo necesita, para no pedírselo a mano a
 * quien liquida: los días de vacaciones pendientes, lo ya retenido en el año
 * y los días trabajados del mes del cese salen de los propios registros.
 */
async function reunirDatos(cuerpo) {
  const { employeeId, fechaCese, causa, adelantos = 0, diasTrabajadosDelMes } = cuerpo;

  const empleado = await Empleado.findById(employeeId)
    .populate('cargoActual', 'nombre')
    .populate('localActual', 'nombre');
  if (!empleado) return { error: 'Empleado no encontrado', estado: 404 };
  if (empleado.estado === 'CESADO') {
    return { error: `${empleado.nombres} ya figura como cesado`, estado: 409 };
  }

  const cese = aFechaLocal(fechaCese) || new Date();
  if (cese > finDelDia()) {
    return { error: 'La fecha de cese no puede ser futura' };
  }

  // Vacaciones adquiridas y no gozadas
  let diasPendientes = 0;
  try {
    const saldo = await balanceOf(empleado);
    diasPendientes = Math.max(0, saldo?.diasDisponibles || 0);
  } catch { /* si no se puede calcular, se deja en cero y se avisa */ }

  // Retención de quinta ya practicada en el ejercicio
  const boletasDelAnio = await Boleta.find({
    empleado: empleado._id,
    periodo: new RegExp(`^${cese.getFullYear()}-`),
    estado: { $in: ['APROBADO', 'PAGADO'] },
  }).select('descuentos.rentaQuinta.monto').lean();
  const retenidoEnElAnio = boletasDelAnio.reduce(
    (a, b) => a + (b.descuentos?.rentaQuinta?.monto || 0), 0
  );

  return {
    empleado,
    opciones: {
      fechaCese: cese,
      causa,
      adelantos,
      retenidoEnElAnio: Math.round(retenidoEnElAnio * 100) / 100,
      diasVacacionesPendientes: cuerpo.diasVacacionesPendientes ?? diasPendientes,
      diasTrabajadosDelMes: diasTrabajadosDelMes ?? cese.getDate(),
    },
  };
}

/**
 * Paso 1 · se calcula y se guarda como borrador.
 * El empleado todavía no queda cesado: primero hay que saber qué se le debe.
 */
router.post('/', permit('contracts', 'write'), validarCuerpo(esq.liquidacionCrear),
  async (req, res, next) => {
    try {
      const datos = await reunirDatos(req.body);
      if (datos.error) return res.status(datos.estado || 400).json({ error: datos.error });

      const yaExiste = await Liquidacion.findOne({
        empleado: datos.empleado._id,
        estado: { $ne: 'ANULADA' },
      });
      if (yaExiste) {
        return res.status(409).json({
          error: `${datos.empleado.nombres} ya tiene una liquidación en estado ${yaExiste.estado}`,
          liquidacion: yaExiste._id,
        });
      }

      const calculo = calcularLiquidacion(datos.empleado, datos.opciones);

      /**
       * Un saldo de vacaciones desmedido casi siempre es historial ausente, no
       * una década sin descansar. Se bloquea con el motivo y el importe en
       * juego, y sólo continúa si alguien lo reafirma sabiendo lo que firma.
       */
      if (calculo.requiereConfirmacion && !req.body.confirmarSaldoVacaciones) {
        return res.status(409).json({
          error: calculo.avisos.find((a) => /días de vacaciones/.test(a)) || 'Saldo de vacaciones inusual',
          requiereConfirmacion: calculo.requiereConfirmacion,
          // Se devuelve el cálculo para que se pueda revisar antes de confirmar
          calculo,
        });
      }

      const contrato = await Contrato.findOne({
        empleado: datos.empleado._id,
        estado: { $in: ['VIGENTE', 'POR_VENCER'] },
      }).select('_id');

      const liq = await Liquidacion.create({
        empleado: datos.empleado._id,
        contrato: contrato?._id,
        causa: req.body.causa,
        fechaCese: datos.opciones.fechaCese,
        motivoDetallado: req.body.motivoDetallado,
        tiempoDeServicio: calculo.empleado.tiempoDeServicio,
        mesesDeServicio: calculo.empleado.mesesDeServicio,
        enPeriodoPrueba: calculo.empleado.enPeriodoPrueba,
        remuneracionComputable: {
          basico: calculo.remuneracionComputable.ordinaria.basico,
          asignacionFamiliar: calculo.remuneracionComputable.ordinaria.asignacionFamiliar,
          sextoGratificacion: calculo.remuneracionComputable.paraCTS.sextoGratificacion,
          ordinaria: calculo.remuneracionComputable.ordinaria.total,
          paraCTS: calculo.remuneracionComputable.paraCTS.total,
        },
        conceptos: calculo.conceptos.map((c) => ({
          concepto: c.concepto,
          detalle: c.detalle,
          monto: c.monto,
          base: c.base,
          norma: c.norma,
          afectaPension: c.afectacion.pension,
          afectaRenta: c.afectacion.rentaQuinta,
        })),
        descuentos: calculo.descuentos,
        rentaQuinta: calculo.rentaQuinta,
        totales: calculo.totales,
        // Se congelan: dentro de un año la RMV será otra y el cálculo debe seguir explicándose
        parametrosVigentes: (() => {
          const f = new Date(datos.opciones.fechaCese || Date.now());
          return { rmv: P.rmvVigente(f), uit: P.uitDe(f.getFullYear()), anio: f.getFullYear() };
        })(),
        avisos: calculo.avisos,
        calculadaPor: req.usuario._id,
      });

      res.status(201).json({
        liquidacion: liq,
        calculo,
        mensaje: 'Liquidación calculada en borrador. El empleado seguirá activo hasta que se '
          + 'apruebe y se registre el pago.',
      });
    } catch (err) {
      if (/Causa de cese|fecha de|anterior al ingreso/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  });

/** Paso 2 · la aprueba quien no la calculó */
router.put('/:id/aprobar', validarId(), permit('contracts', 'approve'),
  validarCuerpo(esq.decision), async (req, res, next) => {
    try {
      const liq = await Liquidacion.findById(req.params.id).populate('empleado', 'nombres apellidos');
      if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
      if (liq.estado !== 'BORRADOR') {
        return res.status(400).json({ error: `La liquidación ya está ${liq.estado.toLowerCase()}` });
      }

      // Quien calcula no aprueba: es lo que hace que el control exista
      if (String(liq.calculadaPor) === String(req.usuario._id)) {
        return res.status(409).json({
          error: 'Quien calculó la liquidación no puede aprobarla. Debe revisarla otra persona.',
        });
      }
      if (liq.totales.neto < 0) {
        return res.status(400).json({
          error: 'No se puede aprobar una liquidación con neto negativo. Revise los descuentos.',
        });
      }

      liq.estado = 'APROBADA';
      liq.aprobadaPor = req.usuario._id;
      liq.aprobadaEn = new Date();
      await liq.save();

      res.json({ liquidacion: liq, mensaje: 'Liquidación aprobada. Queda pendiente registrar el pago.' });
    } catch (err) { next(err); }
  });

/**
 * Paso 3 · se registra el pago y recién entonces el empleado queda cesado.
 *
 * Este orden importa: si se cesara primero, se perdería de vista lo que había
 * que pagarle, que es exactamente lo que la ley protege con el plazo de 48
 * horas.
 */
router.put('/:id/pagar', validarId(), permit('contracts', 'approve'),
  validarCuerpo(esq.liquidacionPagar), async (req, res, next) => {
    try {
      const liq = await Liquidacion.findById(req.params.id).populate('empleado');
      if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
      if (liq.estado === 'PAGADA') {
        return res.status(400).json({
          error: `Esta liquidación ya figura pagada el ${comoTexto(liq.pagadaEn)}`,
        });
      }
      if (liq.estado !== 'APROBADA') {
        return res.status(400).json({ error: 'La liquidación debe aprobarse antes de pagarse' });
      }

      const fecha = req.body.fechaPago ? aFechaLocal(req.body.fechaPago) : new Date();
      if (!fecha || fecha > finDelDia()) {
        return res.status(400).json({ error: 'Fecha de pago inválida o posterior a hoy' });
      }

      liq.estado = 'PAGADA';
      liq.pagadaEn = fecha;
      liq.pagadaPor = req.usuario._id;
      liq.medioDePago = req.body.medioDePago || 'TRANSFERENCIA';
      liq.referenciaPago = req.body.referenciaPago;
      liq.certificadoEmitidoEn = new Date();
      await liq.save();

      // Recién ahora se cierra el vínculo
      const empleado = await Empleado.findById(liq.empleado._id);
      empleado.estado = 'CESADO';
      await empleado.save();
      await revocarAccesoPorCese(empleado._id, req.usuario._id);

      if (liq.contrato) {
        await Contrato.findByIdAndUpdate(liq.contrato, {
          estado: 'TERMINADO',
          fechaFin: liq.fechaCese,
          motivoTermino: `${C.CAUSAS[liq.causa].etiqueta}${liq.motivoDetallado ? `: ${liq.motivoDetallado}` : ''}`,
        });
      }

      // Y se le retira el acceso al sistema
      const cuenta = await Usuario.findOne({ empleado: empleado._id });
      if (cuenta && cuenta.activo) {
        cuenta.activo = false;
        cuenta.desactivadoEn = new Date();
        cuenta.desactivadoPor = req.usuario._id;
        // Invalida cualquier sesión abierta, no sólo los futuros ingresos
        cuenta.versionToken = (cuenta.versionToken || 0) + 1;
        await cuenta.save();
      }

      // Las solicitudes de descanso que quedaran en trámite ya no proceden
      await Vacacion.updateMany(
        { empleado: empleado._id, estado: { $in: ['PENDIENTE', 'APROBADO_LOCAL'] } },
        { $set: { estado: 'CANCELADO' } }
      );

      res.json({
        liquidacion: liq,
        mensaje: `Pago registrado. ${empleado.nombres} ${empleado.apellidos} queda cesado y su `
          + 'acceso al sistema ha sido revocado.',
        certificadoDeTrabajo: `Debe entregarse dentro de las ${C.PLAZO_CERTIFICADO_HORAS} horas.`,
      });
    } catch (err) { next(err); }
  });

/** El trabajador deja constancia de haberla recibido; puede observarla */
router.put('/:id/firmar', validarId(), validarCuerpo(esq.liquidacionFirmar),
  async (req, res, next) => {
    try {
      const liq = await Liquidacion.findById(req.params.id);
      if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
      if (!req.usuario.empleado || String(liq.empleado) !== String(req.usuario.empleado)) {
        return res.status(403).json({ error: 'Sólo el interesado puede firmar su liquidación' });
      }
      if (liq.firmadaPorTrabajador) {
        return res.status(400).json({ error: 'Ya dejó constancia de esta liquidación' });
      }

      liq.firmadaPorTrabajador = true;
      liq.firmadaEn = new Date();
      if (req.body.observacion) liq.observacionTrabajador = req.body.observacion;
      await liq.save();

      if (req.body.observacion && liq.aprobadaPor) {
        await Notificacion.create({
          usuario: liq.aprobadaPor,
          tipo: 'CONTRATO',
          titulo: 'Una liquidación fue firmada con observaciones',
          mensaje: String(req.body.observacion).slice(0, 200),
          prioridad: 'ALTA',
          modeloRelacionado: 'Liquidacion',
          idRelacionado: liq._id,
        });
      }

      res.json({
        liquidacion: liq,
        mensaje: req.body.observacion
          ? 'Constancia registrada con su observación'
          : 'Constancia registrada',
      });
    } catch (err) { next(err); }
  });

/** Anular un borrador o una aprobación que no llegó a pagarse */
router.put('/:id/anular', validarId(), permit('contracts', 'approve'),
  validarCuerpo(esq.liquidacionAnular), async (req, res, next) => {
    try {
      const liq = await Liquidacion.findById(req.params.id);
      if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
      if (liq.estado === 'PAGADA') {
        return res.status(400).json({
          error: 'Una liquidación pagada no se anula. Si hubo un error, registre el ajuste que corresponda.',
        });
      }
      if (liq.estado === 'ANULADA') return res.status(400).json({ error: 'Ya está anulada' });

      liq.estado = 'ANULADA';
      liq.anuladaPor = req.usuario._id;
      liq.anuladaEn = new Date();
      liq.motivoAnulacion = req.body.motivo;
      await liq.save();

      res.json({ liquidacion: liq, mensaje: 'Liquidación anulada' });
    } catch (err) { next(err); }
  });

module.exports = router;
