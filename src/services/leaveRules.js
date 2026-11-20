const Empleado = require('../models/Empleado');
const Vacacion = require('../models/Vacacion');
const Local = require('../models/Local');
const { requiredRoster, shiftTypesOf, formatOf, substitutionsFor, SHIFT_ROLES } = require('../config/formats');
const { shiftRoleOf } = require('./staffing');

/**
 * Reglas de descanso vacacional (D.L. 713) y su impacto en la cobertura del local.
 *
 * El derecho vacacional es de 30 días por año completo de servicios. El descanso
 * puede fraccionarse, pero no en períodos menores a siete días. Si el trabajador
 * no goza el descanso dentro del año siguiente a haberlo adquirido, el empleador
 * debe pagar una remuneración adicional (la llamada "triple remuneración").
 */

const MS_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const DAY = 86400000;
// Autorizadas: descuentan del saldo aunque aún no se gocen
const GOZADAS = ['APROBADO', 'EN_CURSO', 'COMPLETADO'];
// Sin resolver: comprometen días. Una solicitud avalada por el local todavía
// espera la autorización de la zona; contarla como gozada mostraba al
// trabajador «0 comprometidos» teniendo una solicitud en trámite
const EN_TRAMITE = ['PENDIENTE', 'APROBADO_LOCAL'];
// Para los cruces de fechas cuenta todo lo que reserva el período
const OCUPAN_PLAZA = [...EN_TRAMITE, ...GOZADAS];

/**
 * Período vacacional más antiguo con días sin gozar y su fecha límite.
 *
 * Lo gozado se imputa a los períodos más antiguos primero. El período N se
 * adquiere al cumplir N años y debe gozarse dentro del año siguiente
 * (D.L. 713, art. 23): vence al cumplir N + 1. Antes se tomaba la fecha límite
 * del período más reciente, y alguien con cinco años sin vacaciones figuraba
 * sin riesgo de triple remuneración.
 */
function periodoPendiente(fechaIngreso, anosDeServicio, diasGozados, hoy = new Date()) {
  const periodo = Math.floor(diasGozados / 30) + 1;
  const fechaLimite = new Date(fechaIngreso);
  fechaLimite.setFullYear(fechaLimite.getFullYear() + periodo + 1);
  return { periodo, fechaLimite, vencido: periodo <= anosDeServicio && hoy > fechaLimite };
}

/** Saldo vacacional de un empleado */
async function balanceOf(empleado) {
  const yearsExact = (Date.now() - empleado.fechaIngreso.getTime()) / MS_YEAR;
  const anosDeServicio = Math.floor(yearsExact);
  const diasAcumulados = anosDeServicio * 30;

  const used = await Vacacion.aggregate([
    { $match: { empleado: empleado._id, tipo: 'VACACIONES', estado: { $in: GOZADAS } } },
    { $group: { _id: null, total: { $sum: '$diasTotales' } } },
  ]);
  const diasGozados = used[0]?.total || 0;

  // Días comprometidos en solicitudes aún sin resolver
  const pending = await Vacacion.aggregate([
    { $match: { empleado: empleado._id, tipo: 'VACACIONES', estado: { $in: EN_TRAMITE } } },
    { $group: { _id: null, total: { $sum: '$diasTotales' } } },
  ]);
  const pendingDays = pending[0]?.total || 0;

  const { fechaLimite, vencido } = periodoPendiente(empleado.fechaIngreso, anosDeServicio, diasGozados);
  const diasDisponibles = diasAcumulados - diasGozados;

  return {
    anosDeServicio,
    diasAcumulados,
    diasGozados,
    pendingDays,
    diasDisponibles,
    requestableDays: diasDisponibles - pendingDays,
    fechaLimite,
    daysToDeadline: Math.ceil((fechaLimite - Date.now()) / DAY),
    riesgoTriplePago: vencido,
  };
}

/** ¿Se cruza el rango solicitado con otra ausencia ya registrada? */
async function findOverlap(employeeId, inicio, fin, excludeId = null) {
  const filter = {
    empleado: employeeId,
    estado: { $in: OCUPAN_PLAZA },
    fechaInicio: { $lte: fin },
    fechaFin: { $gte: inicio },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Vacacion.findOne(filter);
}

/**
 * Impacto de la ausencia sobre la dotación del centro de trabajo.
 *
 * Se evalúa cualquier puesto de turno —químico, técnico, caja, dermoconsultoría,
 * almacén, prevención o reparto— contra la dotación que exige el formato del
 * local, y se descuenta la cobertura que la polivalencia permita: en formatos
 * pequeños el técnico también atiende caja y recibe mercadería, mientras que en
 * un Flagship cada puesto necesita titular propio.
 *
 * La ausencia del Químico Farmacéutico es el único caso con efecto legal: sin
 * Director Técnico presente el local no puede operar por norma DIGEMID.
 */
async function coverageImpact(empleado, inicio, fin, excludeVacationId = null) {
  const locationId = empleado.localActual?._id || empleado.localActual;
  if (!locationId) return null;

  const local = await Local.findById(locationId)
    .select('nombre formato dotacionRequerida turnos tipo');
  if (!local) return null;

  const fmt = formatOf(local);
  const subs = substitutionsFor(fmt);
  const evaluatesRoster = local.tipo === 'BOTICA';

  // Dotación exigida por día: se suman todos los turnos que el local opera,
  // porque una persona sólo cubre un turno diario.
  const requiredPerDay = {};
  if (evaluatesRoster) {
    for (const tipoTurno of shiftTypesOf(local)) {
      for (const [rol, count] of Object.entries(requiredRoster(local, tipoTurno))) {
        requiredPerDay[rol] = (requiredPerDay[rol] || 0) + count;
      }
    }
  }

  // Plantilla completa del centro con su puesto de turno resuelto
  const staff = await Empleado.find({
    localActual: local._id,
    estado: { $ne: 'CESADO' },
  })
    .populate('cargoActual', 'nombre rolPorDefecto')
    .select('nombres apellidos tipoProfesional esPracticante cargoActual');

  // Quiénes estarán ausentes durante la ventana solicitada
  const filtroAusencias = {
    empleado: { $in: staff.map((e) => e._id) },
    estado: { $in: OCUPAN_PLAZA },
    fechaInicio: { $lte: fin },
    fechaFin: { $gte: inicio },
  };
  if (excludeVacationId) filtroAusencias._id = { $ne: excludeVacationId };
  const ausentes = await Vacacion.find(filtroAusencias).distinct('empleado');

  const ausenteSet = new Set(ausentes.map(String));
  ausenteSet.add(String(empleado._id));   // el solicitante también estará fuera

  // El puesto del solicitante se toma de la plantilla ya poblada: quien llama
  // puede haber consultado al empleado sin traer `cargoActual`, y en ese
  // caso el puesto caería al genérico de su tipo profesional.
  const enPlantilla = staff.find((e) => String(e._id) === String(empleado._id));
  const rol = shiftRoleOf(enPlantilla || empleado);
  const meta = SHIFT_ROLES[rol] || {};

  const total = {};
  for (const e of staff) {
    const r = shiftRoleOf(e);
    total[r] = (total[r] || 0) + 1;
  }

  const prioridad = Object.keys(requiredPerDay).sort((a, b) => {
    const legalA = SHIFT_ROLES[a]?.legal ? 0 : 1;
    const legalB = SHIFT_ROLES[b]?.legal ? 0 : 1;
    if (legalA !== legalB) return legalA - legalB;
    return (SHIFT_ROLES[a]?.order || 99) - (SHIFT_ROLES[b]?.order || 99);
  });

  /**
   * Reparte la polivalencia en todo el local para un conjunto dado de ausentes.
   * Los huecos se resuelven con quien sobra, y cada excedente se presta una
   * sola vez: se atiende primero lo exigido por ley y luego el orden operativo,
   * de modo que un técnico de más cubra la caja antes que el almacén.
   */
  const evaluar = (fuera) => {
    const disp = {};
    for (const e of staff) {
      const r = shiftRoleOf(e);
      if (!fuera.has(String(e._id))) disp[r] = (disp[r] || 0) + 1;
    }

    const huecos = {};
    const sobrantes = {};
    for (const r of new Set([...Object.keys(requiredPerDay), ...Object.keys(total)])) {
      huecos[r] = Math.max(0, (requiredPerDay[r] || 0) - (disp[r] || 0));
      sobrantes[r] = Math.max(0, (disp[r] || 0) - (requiredPerDay[r] || 0));
    }

    const cubiertoPor = {};
    for (const r of prioridad) {
      for (const origen of subs[r] || []) {
        if (huecos[r] <= 0) break;
        const take = Math.min(sobrantes[origen] || 0, huecos[r]);
        if (take > 0) {
          huecos[r] -= take;
          sobrantes[origen] -= take;
          (cubiertoPor[r] ||= []).push({ rol: origen, etiqueta: SHIFT_ROLES[origen]?.etiqueta || origen, count: take });
        }
      }
    }
    return { disponible: disp, huecos, cubiertoPor };
  };

  // Se compara el local con y sin el solicitante: así se distingue el hueco que
  // esta ausencia provoca del que el local ya arrastra por otras ausencias.
  const sinSolicitante = new Set(ausenteSet);
  const conSolicitante = new Set(ausenteSet);
  conSolicitante.delete(String(empleado._id));

  const previo = evaluar(conSolicitante);
  const resultado = evaluar(sinSolicitante);
  const { disponible, huecos, cubiertoPor } = resultado;

  const requerido = requiredPerDay[rol] || 0;
  const availableNow = disponible[rol] || 0;
  const deficit = Math.max(0, requerido - availableNow);
  const substitutes = cubiertoPor[rol] || [];
  const coveredBySubstitution = substitutes.reduce((a, s) => a + s.count, 0);
  const residualGap = huecos[rol] || 0;

  // Foto de la dotación completa del local durante la ventana
  const roster = Object.entries(requiredPerDay)
    .map(([r, req]) => ({
      rol: r,
      etiqueta: SHIFT_ROLES[r]?.etiqueta || r,
      legal: !!SHIFT_ROLES[r]?.legal,
      requerido: req,
      available: disponible[r] || 0,
      sustituidos: (cubiertoPor[r] || []).reduce((a, s) => a + s.count, 0),
      coveredBy: cubiertoPor[r] || [],
      brecha: huecos[r] || 0,
      isRequesterRole: r === rol,
    }))
    .sort((a, b) => (SHIFT_ROLES[a.rol]?.order || 99) - (SHIFT_ROLES[b.rol]?.order || 99));

  // Un puesto sin exigencia propia igual puede romper la cobertura de otro:
  // si se ausenta el QF Asistente, el Director Técnico pierde su relevo.
  const huecosLegales = roster.filter((r) => r.legal && r.brecha > 0);
  const huecosOtros = roster.filter((r) => !r.legal && r.brecha > 0);

  // Sólo se atribuye a esta solicitud el hueco que ella misma abre o agrava.
  const causados = roster.filter((r) => r.brecha > (previo.huecos[r.rol] || 0));
  const preexistentes = roster.filter((r) => (previo.huecos[r.rol] || 0) > 0);
  const legalesCausados = causados.filter((r) => r.legal);
  const legalesPreexistentes = preexistentes.filter((r) => r.legal);

  // Colegas del mismo puesto, con su estado durante el período
  const peers = staff
    .filter((e) => shiftRoleOf(e) === rol && String(e._id) !== String(empleado._id))
    .map((e) => ({
      _id: e._id,
      nombre: `${e.nombres} ${e.apellidos}`,
      absent: ausenteSet.has(String(e._id)),
      esPracticante: !!e.esPracticante,
    }));

  const severidad = legalesCausados.length ? 'CRITICA'
    : causados.some((r) => r.rol === 'TECNICO') ? 'MAYOR'
      : causados.length ? 'MENOR' : null;

  return {
    local: local.nombre,
    locationType: local.tipo,
    formato: local.formato,
    evaluatesRoster,

    rol,
    roleLabel: meta.etiqueta || rol,
    legal: !!meta.legal,

    requiredPerDay: requerido,
    holdersTotal: total[rol] || 0,
    holdersAvailable: availableNow,
    deficit,
    coveredBySubstitution,
    residualGap,
    substitutes,
    allowsSubstitution: !!fmt.allowSubstitution,

    // `blocking` sólo se activa si esta ausencia abre o agrava un hueco legal.
    // Un descubierto que el local ya arrastra se informa aparte, para no
    // atribuirle a quien solicita una situación que no provocó.
    blocking: legalesCausados.length > 0,
    uncovered: causados.length > 0,
    causedGaps: causados.map((r) => ({ rol: r.rol, etiqueta: r.etiqueta, brecha: r.brecha, legal: r.legal, available: r.available, requerido: r.requerido })),
    legalGaps: legalesCausados.map((r) => ({ rol: r.rol, etiqueta: r.etiqueta, brecha: r.brecha })),
    otherGaps: causados.filter((r) => !r.legal).map((r) => ({ rol: r.rol, etiqueta: r.etiqueta, brecha: r.brecha, available: r.available, requerido: r.requerido })),
    preexistingGaps: preexistentes.map((r) => ({ rol: r.rol, etiqueta: r.etiqueta, brecha: previo.huecos[r.rol] || 0, legal: r.legal })),
    hasPreexistingLegalGap: legalesPreexistentes.length > 0,
    severidad,

    peers,
    roster,

    // Campos que conserva la interfaz existente
    peersTotal: peers.length,
    peersAbsent: peers.filter((p) => p.absent).length,
    availablePeers: availableNow,
    minimumNeeded: requerido,
    leavesUncovered: roster.some((r) => r.brecha > 0),
    allGaps: roster.filter((r) => r.brecha > 0).map((r) => ({ rol: r.rol, etiqueta: r.etiqueta, brecha: r.brecha, legal: r.legal })),
  };
}

/**
 * Valida una solicitud completa y devuelve los motivos de rechazo y las
 * advertencias que el aprobador debe conocer antes de decidir.
 */
async function validateRequest({ empleado, tipo, fechaInicio, fechaFin, excludeId = null }) {
  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);
  const errors = [];
  const warnings = [];

  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) {
    return { ok: false, errors: ['Fechas inválidas'], warnings: [], diasTotales: 0 };
  }
  if (fin < inicio) {
    return { ok: false, errors: ['La fecha de término no puede ser anterior al inicio'], warnings: [], diasTotales: 0 };
  }

  const diasTotales = Math.floor((fin - inicio) / DAY) + 1;
  const balance = await balanceOf(empleado);

  if (tipo === 'VACACIONES') {
    if (diasTotales < 7) {
      errors.push('D.L. 713: el descanso vacacional no puede fraccionarse en períodos menores a siete días');
    }
    if (diasTotales > balance.requestableDays) {
      errors.push(
        `Solicita ${diasTotales} días y dispone de ${Math.max(0, balance.requestableDays)}` +
        (balance.pendingDays ? ` (${balance.pendingDays} ya comprometidos en solicitudes pendientes)` : '')
      );
    }
  }

  if (inicio < new Date(Date.now() - DAY)) {
    warnings.push('La solicitud comienza en una fecha pasada');
  }

  const overlap = await findOverlap(empleado._id, inicio, fin, excludeId);
  if (overlap) {
    errors.push(
      `Se cruza con otra ausencia registrada del ${overlap.fechaInicio.toISOString().slice(0, 10)} al ${overlap.fechaFin.toISOString().slice(0, 10)}`
    );
  }

  const impact = await coverageImpact(empleado, inicio, fin, excludeId);

  if (impact?.blocking) {
    const faltan = impact.legalGaps
      .map((g) => `${g.etiqueta.toLowerCase()}${g.brecha > 1 ? ` (faltarían ${g.brecha})` : ''}`)
      .join(' y ');
    warnings.push(
      `Esta ausencia dejaría a ${impact.local} sin cobertura de ${faltan}. El local no puede operar sin Director Técnico presente: designe cobertura de otro local antes de autorizar.`
    );
  } else if (impact?.hasPreexistingLegalGap) {
    const faltan = impact.preexistingGaps.filter((g) => g.legal).map((g) => g.etiqueta).join(', ');
    warnings.push(
      `${impact.local} ya arrastra un descubierto de ${faltan} por otras ausencias del período. Esta solicitud no lo agrava, pero conviene resolverlo.`
    );
  }

  // Huecos que esta ausencia sí provoca en puestos no exigidos por ley
  const causadosNoLegales = (impact?.otherGaps || []);
  if (causadosNoLegales.length) {
    warnings.push(
      `Con esta ausencia ${impact.local} queda por debajo del mínimo del formato ${impact.formato} en: ` +
      causadosNoLegales.map((g) => `${g.etiqueta} (${g.available} de ${g.requerido})`).join(', ') + '.'
    );
  }

  // Un local que ya opera por debajo del mínimo en varios puestos es un
  // problema de dotación, no de esta solicitud: se informa como contexto.
  const previosNoLegales = (impact?.preexistingGaps || []).filter((g) => !g.legal);
  if (previosNoLegales.length >= 2) {
    warnings.push(
      `${impact.local} ya opera por debajo del mínimo del formato ${impact.formato} en ${previosNoLegales.length} puestos, con independencia de esta solicitud. Conviene revisar su dotación.`
    );
  }

  if (!impact?.uncovered && impact?.coveredBySubstitution > 0) {
    const quienes = impact.substitutes.map((s) => `${s.count} ${s.etiqueta}`).join(', ');
    warnings.push(
      `La ausencia se cubre por polivalencia: ${quienes} asumirá${impact.coveredBySubstitution > 1 ? 'n' : ''} el puesto de ${impact.roleLabel}.`
    );
  }

  if (balance.riesgoTriplePago && tipo === 'VACACIONES') {
    warnings.push('El empleado acumula vacaciones vencidas: existe riesgo de triple remuneración.');
  }

  return { ok: errors.length === 0, errors, warnings, diasTotales, balance, impact };
}

module.exports = { balanceOf, periodoPendiente, findOverlap, coverageImpact, validateRequest };
