const router = require('express').Router();
const Empleado = require('../models/Empleado');
const Contrato = require('../models/Contrato');
const Asistencia = require('../models/Asistencia');
const Vacacion = require('../models/Vacacion');
const DescansoMedico = require('../models/DescansoMedico');
const Capacitacion = require('../models/Capacitacion');
const Evaluacion = require('../models/Evaluacion');
const Boleta = require('../models/Boleta');
const Turno = require('../models/Turno');
const { auth } = require('../middleware/auth');
const scopeByRole = require('../middleware/scopeByRole');
const { permit } = require('../middleware/scopeByRole');
const leave = require('../services/leaveRules');
const { shiftRoleOf } = require('../services/staffing');
const { SHIFT_ROLES } = require('../config/formats');
const { validarId } = require('../middleware/validar');
const { proyeccionEmpleado, veRemuneracion } = require('../utils/remuneracion');

/**
 * Ficha del empleado.
 *
 * Reúne en una sola consulta la historia laboral de una persona: su situación
 * contractual, su comportamiento de asistencia, sus descansos, su formación y
 * su remuneración. Es la vista que necesita quien va a tomar una decisión sobre
 * alguien — renovar, promover, evaluar o autorizar una ausencia.
 */

const DIA = 86400000;
const redondear = (n) => Math.round((n || 0) * 100) / 100;

router.use(auth);

router.get('/:id/dossier', validarId(), scopeByRole, permit('employees', 'read'), async (req, res, next) => {
  try {
    const empleado = await Empleado.findById(req.params.id)
      .select(proyeccionEmpleado(req.usuario.rol))
      .populate('cargoActual')
      .populate('localActual')
      .populate('zona')
      .populate('supervisor', 'nombres apellidos');

    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

    // Nadie consulta fuera de su alcance
    const scope = req.scope;
    if (scope && !scope.isNational) {
      if (scope.scopeType === 'SELF' && String(empleado._id) !== String(scope.employeeId)) {
        return res.status(403).json({ error: 'Sólo puede consultar su propia ficha' });
      }
      if (scope.scopeType !== 'SELF') {
        const permitidos = (scope.locationIds || []).map(String);
        if (!permitidos.includes(String(empleado.localActual?._id))) {
          return res.status(403).json({ error: 'Este empleado no pertenece a su ámbito' });
        }
      }
    }

    // Cada quien puede ver su propia remuneración aunque no administre planilla
    const esPropio = String(empleado._id) === String(req.usuario.empleado || '');
    const veSueldo = veRemuneracion(req.usuario.rol) || esPropio;

    const hoy = new Date();
    const hace90 = new Date(hoy.getTime() - 90 * DIA);

    const [contratos, marcas, ausencias, descansos, capacitaciones, evaluaciones, boletas, turnos] =
      await Promise.all([
        // El sueldo pactado es remuneración: para quien la administra o para el interesado
        Contrato.find({ empleado: empleado._id }).select(veSueldo ? null : '-sueldo -historialRenovaciones.sueldo')
          .populate('cargo', 'nombre codigo').sort({ fechaInicio: -1 }),
        Asistencia.find({ empleado: empleado._id, fecha: { $gte: hace90 } })
          .populate('local', 'nombre codigo').sort({ fecha: -1 }),
        Vacacion.find({ empleado: empleado._id })
          .populate('aprobadoPor', 'correo rol').sort({ fechaInicio: -1 }),
        DescansoMedico.find({ empleado: empleado._id }).sort({ fechaInicio: -1 }),
        Capacitacion.find({ empleado: empleado._id }).sort({ fechaProgramada: -1 }),
        Evaluacion.find({ empleado: empleado._id })
          .populate('evaluador', 'nombres apellidos').sort({ 'periodo.fechaFin': -1 }),
        // Los borradores sólo los ve Planillas; el interesado, lo ya emitido
        Boleta.find(veRemuneracion(req.usuario.rol)
          ? { empleado: empleado._id }
          : { empleado: empleado._id, estado: { $in: ['APROBADO', 'PAGADO'] } })
          .sort({ periodo: -1 }).limit(6),
        Turno.find({ 'asignaciones.empleado': empleado._id, fecha: { $gte: new Date(hoy.setHours(0, 0, 0, 0)) } })
          .populate('local', 'nombre codigo marca').sort({ fecha: 1 }).limit(14),
      ]);

    // ── Situación contractual ──
    const contratoVigente = contratos.find((c) => ['VIGENTE', 'POR_VENCER'].includes(c.estado)) || contratos[0] || null;
    const diasParaVencer = contratoVigente?.fechaFin
      ? Math.ceil((new Date(contratoVigente.fechaFin) - Date.now()) / DIA)
      : null;

    // ── Comportamiento de asistencia (90 días) ──
    const conMarca = marcas.filter((m) => ['PRESENTE', 'TARDANZA'].includes(m.estado));
    const tardanzas = marcas.filter((m) => m.estado === 'TARDANZA');
    const faltas = marcas.filter((m) => m.estado === 'AUSENTE');
    // El rango real de los datos, que puede ser menor que la ventana consultada
    const fechas = marcas.map((m) => new Date(m.fecha)).sort((a, b) => a - b);
    const asistencia = {
      ventanaDias: 90,
      desde: fechas[0] || null,
      hasta: fechas[fechas.length - 1] || null,
      diasConDatos: fechas.length
        ? Math.floor((fechas[fechas.length - 1] - fechas[0]) / DIA) + 1
        : 0,
      registros: marcas.length,
      presentes: conMarca.length,
      tardanzas: tardanzas.length,
      faltas: faltas.length,
      minutosTardanzaTotal: marcas.reduce((a, m) => a + (m.minutosTardanza || 0), 0),
      horasTrabajadas: redondear(marcas.reduce((a, m) => a + (m.horasTrabajadas || 0), 0)),
      horasExtra: redondear(marcas.reduce((a, m) => a + (m.horasExtra || 0), 0)),
      puntualidad: conMarca.length ? Math.round(((conMarca.length - tardanzas.length) / conMarca.length) * 100) : null,
      recientes: marcas.slice(0, 10),
    };

    // ── Descanso vacacional ──
    const balance = await leave.balanceOf(empleado);

    // ── Formación y habilitación ──
    const completadas = capacitaciones.filter((t) => t.estado === 'COMPLETADA');
    const certificacionDigemid = completadas
      .filter((t) => t.tipo === 'DIGEMID')
      .sort((a, b) => new Date(b.fechaCompletado || 0) - new Date(a.fechaCompletado || 0))[0] || null;

    let colegiatura = null;
    if (empleado.numeroCQF) {
      const dias = empleado.vencimientoCQF ? Math.ceil((new Date(empleado.vencimientoCQF) - Date.now()) / DIA) : null;
      colegiatura = {
        numero: empleado.numeroCQF,
        vence: empleado.vencimientoCQF,
        diasParaVencer: dias,
        estado: dias == null ? 'SIN_DATO' : dias < 0 ? 'VENCIDA' : dias <= 90 ? 'POR_VENCER' : 'VIGENTE',
      };
    }

    // ── Desempeño ──
    const ultimaEvaluacion = evaluaciones[0] || null;
    const puntajeEvaluacion = ultimaEvaluacion?.kpis?.length
      ? Math.round(ultimaEvaluacion.kpis.reduce((a, k) => a + (k.real * k.peso) / 100, 0))
      : null;

    // ── Línea de tiempo: la historia de la persona en un solo hilo ──
    const linea = [];
    const evento = (fecha, tipo, titulo, detalle) => {
      if (fecha) linea.push({ fecha: new Date(fecha), tipo, titulo, detalle });
    };

    evento(empleado.fechaIngreso, 'INGRESO', 'Ingreso a la empresa',
      `${empleado.cargoActual?.nombre || 'Sin puesto'} en ${empleado.localActual?.nombre || 'sin centro asignado'}`);

    for (const c of contratos) {
      evento(c.fechaInicio, 'CONTRATO', `Contrato ${c.tipo.replace('_', ' ').toLowerCase()}`,
        [c.fechaFin ? `Hasta ${new Date(c.fechaFin).toISOString().slice(0, 10)}` : 'Sin plazo', veSueldo && c.sueldo != null ? `S/ ${c.sueldo}` : null]
          .filter(Boolean).join(' · '));
      for (const r of c.historialRenovaciones || []) {
        evento(r.renovadoEn, 'CONTRATO', 'Renovación de contrato',
          `Nuevo término ${new Date(r.nuevaFechaFin).toISOString().slice(0, 10)}`);
      }
    }

    for (const t of completadas) {
      evento(t.fechaCompletado || t.fechaProgramada, 'CAPACITACION', t.nombre,
        `${t.tipo}${t.puntaje != null ? ` · nota ${t.puntaje}` : ''}${t.proveedor ? ` · ${t.proveedor}` : ''}`);
    }

    for (const v of ausencias.filter((x) => ['APROBADO', 'EN_CURSO', 'COMPLETADO'].includes(x.estado))) {
      evento(v.fechaInicio, 'AUSENCIA', v.tipo.replace('_', ' ').toLowerCase(),
        `${v.diasTotales} días hasta ${new Date(v.fechaFin).toISOString().slice(0, 10)}`);
    }

    for (const d of descansos) {
      evento(d.fechaInicio, 'SALUD', 'Descanso médico',
        `${d.diasTotales} días · ${d.diagnostico || d.tipo}${d.subsidio?.aplica ? ' · con subsidio EsSalud' : ''}`);
    }

    for (const e of evaluaciones) {
      evento(e.periodo?.fechaFin, 'EVALUACION', `Evaluación ${e.periodo?.nombre || ''}`.trim(),
        e.fortalezas || e.estado);
    }

    for (const h of empleado.historialCargos || []) {
      evento(h.fechaInicio, 'PUESTO', 'Cambio de puesto', h.motivo || '');
    }
    for (const s of empleado.historialSueldos || []) {
      evento(s.fechaVigencia, 'SUELDO', 'Ajuste de remuneración', `S/ ${s.monto}${s.motivo ? ` · ${s.motivo}` : ''}`);
    }

    linea.sort((a, b) => b.fecha - a.fecha);

    // ── Señales que exigen atención ──
    const alertas = [];
    if (colegiatura?.estado === 'VENCIDA') {
      alertas.push({ nivel: 'CRITICA', mensaje: 'Colegiatura CQF vencida: no puede ejercer la dirección técnica.' });
    } else if (colegiatura?.estado === 'POR_VENCER') {
      alertas.push({ nivel: 'ALTA', mensaje: `Colegiatura CQF vence en ${colegiatura.diasParaVencer} días.` });
    }
    if (diasParaVencer != null && diasParaVencer <= 30 && diasParaVencer >= 0) {
      alertas.push({ nivel: 'ALTA', mensaje: `Contrato vence en ${diasParaVencer} días. Requiere decisión de renovación.` });
    } else if (diasParaVencer != null && diasParaVencer < 0) {
      alertas.push({ nivel: 'CRITICA', mensaje: `Contrato vencido hace ${Math.abs(diasParaVencer)} días.` });
    }
    if (balance.riesgoTriplePago) {
      alertas.push({ nivel: 'ALTA', mensaje: 'Vacaciones vencidas sin gozar: riesgo de triple remuneración.' });
    }
    if (asistencia.puntualidad != null && asistencia.puntualidad < 80) {
      alertas.push({ nivel: 'MEDIA', mensaje: `Puntualidad de ${asistencia.puntualidad}% sobre ${asistencia.registros} marcas registradas.` });
    }
    if (empleado.tipoProfesional === 'QF' && !certificacionDigemid) {
      alertas.push({ nivel: 'MEDIA', mensaje: 'Sin certificación DIGEMID vigente registrada.' });
    }
    if (empleado.esPracticante && empleado.fechaFinPracticas) {
      const restan = Math.ceil((new Date(empleado.fechaFinPracticas) - Date.now()) / DIA);
      alertas.push({
        nivel: restan <= 15 ? 'ALTA' : 'MEDIA',
        mensaje: restan >= 0 ? `Período de inducción termina en ${restan} días.` : 'Período de inducción vencido.',
      });
    }

    const puestoTurno = shiftRoleOf(empleado);

    res.json({
      empleado,
      puestoTurno: { codigo: puestoTurno, etiqueta: SHIFT_ROLES[puestoTurno]?.etiqueta || puestoTurno },
      antiguedad: {
        anios: balance.anosDeServicio,
        dias: Math.floor((Date.now() - empleado.fechaIngreso.getTime()) / DIA),
      },
      contrato: { vigente: contratoVigente, historial: contratos, diasParaVencer },
      asistencia,
      vacaciones: { balance, solicitudes: ausencias },
      salud: {
        descansos,
        diasAcumuladosAnio: descansos
          .filter((d) => new Date(d.fechaInicio).getFullYear() === new Date().getFullYear())
          .reduce((a, d) => a + d.diasTotales, 0),
      },
      formacion: {
        capacitaciones,
        completadas: completadas.length,
        certificacionDigemid,
        colegiatura,
      },
      desempeno: { evaluaciones, ultima: ultimaEvaluacion, puntaje: puntajeEvaluacion },
      // La remuneración sólo viaja hacia quien administra planilla o hacia el
      // propio interesado. Un Jefe de Local abre el expediente para ver
      // asistencia y formación de su gente, no para saber cuánto cobra.
      remuneracion: (veRemuneracion(req.usuario.rol) || esPropio)
        ? {
          boletas,
          ultimoNeto: boletas[0]?.netoAPagar ?? null,
          sueldoBase: contratoVigente?.sueldo ?? empleado.sueldoBasico,
        }
        : null,
      proximosTurnos: turnos,
      lineaDeTiempo: linea.slice(0, 40),
      alertas,
    });
  } catch (err) { next(err); }
});

module.exports = router;
