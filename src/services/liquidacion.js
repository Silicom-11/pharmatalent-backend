const P = require('../config/payrollParams');
const C = require('../config/ceseParams');
const { aFechaLocal, comoTexto } = require('../utils/fechas');
const { impuestoSobreBase, calcularPension } = require('./payroll');

/**
 * Liquidación de beneficios sociales.
 *
 * Cuando un vínculo laboral termina, el empleador tiene 48 horas para pagar lo
 * que se devengó y no llegó a cobrarse. Sin este cálculo no se puede cesar a
 * nadie legalmente: no es un informe de apoyo, es el documento que sustenta el
 * pago y que SUNAFIL revisa.
 *
 * Cada concepto tiene su propia base, su propio período de devengo y su propio
 * tratamiento tributario. La CTS es intangible y no soporta descuento alguno;
 * las vacaciones truncas sí aportan a pensión y retienen quinta; la
 * gratificación trunca no aporta a pensión pero sí retiene. Tratarlas igual
 * descuadra tanto el pago como la declaración.
 */

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Saldo de vacaciones a partir del cual conviene desconfiar.
 *
 * El D.Leg. 713 no pone tope al devengo —lo que penaliza el no gozarlas es la
 * triple remuneración—, pero en la práctica un saldo de más de dos años señala
 * historial ausente, no a alguien que llevara una década sin vacaciones. Al
 * migrar desde otro sistema es lo primero que ocurre: llegan las fechas de
 * ingreso y no llegan los descansos tomados.
 *
 * No se recorta el saldo: eso sería decidir por el trabajador. Se avisa y se
 * exige que alguien lo confirme.
 */
const DIAS_VACACIONES_VEROSIMILES = 60;

/**
 * Meses y días completos entre dos fechas, contados como lo hace la norma
 * laboral: por mes calendario, y el resto en días sobre base de 30.
 */
function tiempoEntre(desde, hasta) {
  const a = aFechaLocal(desde);
  const b = aFechaLocal(hasta);
  if (!a || !b || b < a) return { meses: 0, dias: 0, totalDias: 0 };

  let meses = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  let dias = b.getDate() - a.getDate();

  if (dias < 0) {
    meses -= 1;
    // Días que faltaron para completar el mes, sobre el mes anterior a `hasta`
    const finMesAnterior = new Date(b.getFullYear(), b.getMonth(), 0).getDate();
    dias += finMesAnterior;
  }

  return {
    meses: Math.max(0, meses),
    dias: Math.max(0, dias),
    totalDias: Math.round((b - a) / 86400000),
  };
}

/**
 * Remuneración computable para beneficios sociales.
 *
 * Es la remuneración ordinaria más lo que tenga carácter regular. Para la CTS
 * se añade un sexto de la última gratificación (art. 9 del D.Leg. 650), porque
 * la gratificación forma parte de la base aunque se pague aparte.
 */
function remuneracionComputable(empleado, { incluirSextoGratificacion = false, rmv = P.RMV } = {}) {
  const basico = Number(empleado.sueldoBasico) || 0;
  const asignacion = empleado.tieneHijos
    ? redondear(rmv * P.ASIGNACION_FAMILIAR.porcentajeRMV)
    : 0;
  const base = basico + asignacion;
  const sexto = incluirSextoGratificacion ? redondear(base * P.CTS.sextoGratificacion) : 0;

  return {
    basico,
    asignacionFamiliar: asignacion,
    sextoGratificacion: sexto,
    total: redondear(base + sexto),
  };
}

/**
 * Inicio del período de CTS en curso.
 * Los períodos van de mayo a octubre (depósito en noviembre) y de noviembre a
 * abril (depósito en mayo). Se toma el más reciente que haya empezado antes
 * del cese, sin retroceder más allá de la fecha de ingreso.
 */
function inicioPeriodoCTS(fechaCese, fechaIngreso) {
  const cese = aFechaLocal(fechaCese);
  const ingreso = aFechaLocal(fechaIngreso);
  const mes = cese.getMonth();   // 0 = enero

  // Mayo (4) a octubre (9) → el período empezó el 1 de mayo de ese año
  // Noviembre (10) a abril (3) → empezó el 1 de noviembre
  let inicio;
  if (mes >= 4 && mes <= 9) {
    inicio = new Date(cese.getFullYear(), 4, 1);
  } else {
    inicio = mes >= 10
      ? new Date(cese.getFullYear(), 10, 1)
      : new Date(cese.getFullYear() - 1, 10, 1);
  }

  // Quien ingresó dentro del período devenga desde su ingreso, no desde antes
  return ingreso > inicio ? ingreso : inicio;
}

/** Inicio del semestre de gratificación (enero–junio o julio–diciembre) */
function inicioSemestreGratificacion(fechaCese, fechaIngreso) {
  const cese = aFechaLocal(fechaCese);
  const ingreso = aFechaLocal(fechaIngreso);
  const inicio = cese.getMonth() < 6
    ? new Date(cese.getFullYear(), 0, 1)
    : new Date(cese.getFullYear(), 6, 1);
  return ingreso > inicio ? ingreso : inicio;
}

/**
 * Último aniversario de vacaciones cumplido.
 * El derecho se devenga por año de servicios contado desde el ingreso.
 */
function ultimoAniversario(fechaCese, fechaIngreso) {
  const cese = aFechaLocal(fechaCese);
  const ingreso = aFechaLocal(fechaIngreso);
  const aniversario = new Date(ingreso);
  aniversario.setFullYear(cese.getFullYear());
  if (aniversario > cese) aniversario.setFullYear(cese.getFullYear() - 1);
  return aniversario < ingreso ? ingreso : aniversario;
}

/** Proporcional por meses y días completos, sobre base de 12 meses y 360 días */
function proporcional(base, { meses, dias }) {
  return redondear((base / 12) * meses + (base / 360) * dias);
}

/**
 * Calcula la liquidación completa.
 *
 * @param employee   empleado con baseSalary, hireDate, hasChildren, pensionSystem
 * @param opciones   { fechaCese, causa, diasVacacionesPendientes, diasTrabajadosDelMes,
 *                     ultimoDepositoCTS, adelantos }
 */
function calcularLiquidacion(empleado, opciones = {}) {
  const {
    fechaCese = new Date(),
    causa = 'RENUNCIA',
    diasVacacionesPendientes = 0,
    diasTrabajadosDelMes = 0,
    ultimoDepositoCTS = null,
    adelantos = 0,
  } = opciones;

  const causaMeta = C.CAUSAS[causa];
  if (!causaMeta) throw new Error(`Causa de cese desconocida: ${causa}`);

  const ingreso = aFechaLocal(empleado.fechaIngreso);
  const cese = aFechaLocal(fechaCese);
  if (!ingreso) throw new Error('El empleado no tiene fecha de ingreso registrada');
  if (!cese || cese < ingreso) throw new Error('La fecha de cese no puede ser anterior al ingreso');

  const servicio = tiempoEntre(ingreso, cese);
  const enPeriodoPrueba = servicio.meses < C.PERIODO_PRUEBA_MESES;

  // La RMV y la UIT que regían en la fecha de cese (MNT-2026-014)
  const rmvCese = P.rmvVigente(cese);
  const uitCese = P.uitDe(cese.getFullYear());
  const remCTS = remuneracionComputable(empleado, { incluirSextoGratificacion: true, rmv: rmvCese });
  const remOrdinaria = remuneracionComputable(empleado, { rmv: rmvCese });
  const base = remOrdinaria.total;

  const conceptos = [];

  // ─── Remuneración de los días trabajados del mes del cese ───
  if (diasTrabajadosDelMes > 0) {
    const monto = redondear((base / 30) * diasTrabajadosDelMes);
    conceptos.push({
      concepto: 'Remuneración pendiente',
      detalle: `${diasTrabajadosDelMes} día(s) trabajados en el mes del cese`,
      monto,
      afectacion: C.AFECTACION.remuneracionPendiente,
      norma: 'Días efectivamente laborados',
    });
  }

  // ─── CTS trunca · D.Leg. 650 ───
  const desdeCTS = ultimoDepositoCTS
    ? aFechaLocal(ultimoDepositoCTS)
    : inicioPeriodoCTS(cese, ingreso);
  const tiempoCTS = tiempoEntre(desdeCTS, cese);
  if (tiempoCTS.meses > 0 || tiempoCTS.dias > 0) {
    const monto = proporcional(remCTS.total, tiempoCTS);
    conceptos.push({
      concepto: 'Compensación por tiempo de servicios (trunca)',
      detalle: `${tiempoCTS.meses} mes(es) y ${tiempoCTS.dias} día(s) desde ${comoTexto(desdeCTS)}`,
      monto,
      base: remCTS.total,
      afectacion: C.AFECTACION.ctsTrunca,
      norma: 'D.Leg. 650, art. 21 — incluye 1/6 de gratificación en la base',
    });
  }

  // ─── Vacaciones truncas · D.Leg. 713 ───
  const desdeVac = ultimoAniversario(cese, ingreso);
  const tiempoVac = tiempoEntre(desdeVac, cese);
  if (tiempoVac.meses > 0 || tiempoVac.dias > 0) {
    const monto = proporcional(base, tiempoVac);
    conceptos.push({
      concepto: 'Vacaciones truncas',
      detalle: `${tiempoVac.meses} mes(es) y ${tiempoVac.dias} día(s) desde ${comoTexto(desdeVac)}`,
      monto,
      base,
      afectacion: C.AFECTACION.vacacionesTruncas,
      norma: 'D.Leg. 713 — récord vacacional incompleto',
    });
  }

  // ─── Vacaciones adquiridas y no gozadas ───
  const saldoInverosimil = diasVacacionesPendientes > DIAS_VACACIONES_VEROSIMILES;
  if (diasVacacionesPendientes > 0) {
    const monto = redondear((base / 30) * diasVacacionesPendientes);
    conceptos.push({
      concepto: 'Vacaciones no gozadas',
      detalle: `${diasVacacionesPendientes} día(s) adquiridos y pendientes de goce`,
      monto,
      base,
      afectacion: C.AFECTACION.vacacionesNoGozadas,
      norma: 'D.Leg. 713 — descanso adquirido no disfrutado',
    });
  }

  // ─── Gratificación trunca · Ley 27735 ───
  const desdeGrat = inicioSemestreGratificacion(cese, ingreso);
  const tiempoGrat = tiempoEntre(desdeGrat, cese);
  if (tiempoGrat.meses > 0) {
    // Sólo cuentan los meses completos del semestre
    const monto = redondear((base / 6) * tiempoGrat.meses);
    conceptos.push({
      concepto: 'Gratificación trunca',
      detalle: `${tiempoGrat.meses} mes(es) completo(s) del semestre, desde ${comoTexto(desdeGrat)}`,
      monto,
      base,
      afectacion: C.AFECTACION.gratificacionTrunca,
      norma: 'Ley 27735 — un sexto por mes completo',
    });

    const bonif = redondear(monto * P.GRATIFICACIONES.bonificacionExtraordinaria);
    if (bonif > 0) {
      conceptos.push({
        concepto: 'Bonificación extraordinaria',
        detalle: '9% sobre la gratificación trunca',
        monto: bonif,
        afectacion: C.AFECTACION.bonificacionExtraordinaria,
        norma: 'Ley 30334 — sustituye al aporte a EsSalud sobre la gratificación',
      });
    }
  }

  // ─── Indemnización por despido arbitrario · art. 38 LPCL ───
  let indemnizacion = null;
  if (causaMeta.indemniza) {
    if (enPeriodoPrueba) {
      indemnizacion = {
        aplica: false,
        motivo: `El cese ocurre dentro del período de prueba (${servicio.meses} mes(es) de servicio). `
          + 'No genera derecho a indemnización.',
      };
    } else {
      const porAnio = base * C.INDEMNIZACION.remuneracionesPorAnio;
      const bruto = redondear((porAnio / 12) * (servicio.meses % 12)
        + porAnio * Math.floor(servicio.meses / 12)
        + (porAnio / 360) * servicio.dias);
      const tope = redondear(base * C.INDEMNIZACION.topeRemuneraciones);
      const monto = Math.min(bruto, tope);

      indemnizacion = {
        aplica: true,
        calculado: bruto,
        tope,
        aplicaTope: bruto > tope,
      };
      conceptos.push({
        concepto: 'Indemnización por despido arbitrario',
        detalle: `${Math.floor(servicio.meses / 12)} año(s), ${servicio.meses % 12} mes(es) y `
          + `${servicio.dias} día(s) a razón de 1½ remuneraciones por año`
          + (bruto > tope ? ' — limitada al tope de 12 remuneraciones' : ''),
        monto,
        base,
        afectacion: C.AFECTACION.indemnizacion,
        norma: 'LPCL art. 38 — inafecta al impuesto a la renta',
      });
    }
  }

  // ─── Descuentos sobre lo afecto ───
  const afectoPension = conceptos
    .filter((c) => c.afectacion.pension)
    .reduce((a, c) => a + c.monto, 0);
  const afectoRenta = conceptos
    .filter((c) => c.afectacion.rentaQuinta)
    .reduce((a, c) => a + c.monto, 0);

  const pension = afectoPension > 0
    ? calcularPension(redondear(afectoPension), empleado.sistemaPensiones || 'ONP')
    : { total: 0, etiqueta: 'Sin base afecta', sistema: empleado.sistemaPensiones || 'ONP' };

  /**
   * Retención de quinta categoría sobre un pago extraordinario.
   *
   * No se calcula proyectando la liquidación como si fuera un sueldo mensual:
   * eso proyectaría doce veces un pago que ocurre una sola. El reglamento del
   * impuesto a la renta manda sumar el extraordinario a lo percibido en el
   * ejercicio, calcular el impuesto del año completo y retener la diferencia
   * frente a lo ya retenido.
   */
  const mesesTrabajadosDelAnio = cese.getMonth() + 1;
  const percibidoRegular = base * mesesTrabajadosDelAnio
    + base * (cese.getMonth() >= 6 ? 1 : 0);   // gratificación de julio, si la alcanzó
  const totalDelEjercicio = percibidoRegular + afectoRenta;
  const baseImponibleAnual = totalDelEjercicio - P.RENTA_QUINTA.deduccionUIT * uitCese;

  const impuestoDelEjercicio = redondear(impuestoSobreBase(baseImponibleAnual, uitCese));
  const yaRetenido = redondear(opciones.retenidoEnElAnio || 0);
  const renta = Math.max(0, redondear(impuestoDelEjercicio - yaRetenido));

  const detalleRenta = {
    percibidoRegular: redondear(percibidoRegular),
    liquidacionAfecta: redondear(afectoRenta),
    totalDelEjercicio: redondear(totalDelEjercicio),
    deduccion7UIT: redondear(P.RENTA_QUINTA.deduccionUIT * uitCese),
    baseImponible: redondear(Math.max(0, baseImponibleAnual)),
    impuestoDelEjercicio,
    yaRetenido,
    aRetenerAhora: renta,
  };

  const descuentos = [];
  if (pension.total > 0) {
    descuentos.push({
      concepto: pension.etiqueta || pension.sistema,
      detalle: `Sobre S/ ${redondear(afectoPension)} de base afecta`,
      monto: redondear(pension.total),
    });
  }
  if (renta > 0) {
    descuentos.push({
      concepto: 'Renta de quinta categoría',
      detalle: `Impuesto del ejercicio S/ ${detalleRenta.impuestoDelEjercicio} `
        + `menos S/ ${detalleRenta.yaRetenido} ya retenidos`,
      monto: renta,
    });
  }
  if (adelantos > 0) {
    descuentos.push({
      concepto: 'Adelantos y préstamos pendientes',
      detalle: 'Descuento autorizado por el trabajador',
      monto: redondear(adelantos),
    });
  }

  const totalBruto = redondear(conceptos.reduce((a, c) => a + c.monto, 0));
  const totalDescuentos = redondear(descuentos.reduce((a, d) => a + d.monto, 0));
  const neto = redondear(totalBruto - totalDescuentos);

  // ─── Avisos que quien liquida necesita leer antes de firmar ───
  const avisos = [];
  if (saldoInverosimil) {
    const importe = redondear((base / 30) * diasVacacionesPendientes);
    avisos.push(
      `El saldo de ${diasVacacionesPendientes} días de vacaciones equivale a más de `
      + `${Math.floor(diasVacacionesPendientes / 30)} años sin gozar descanso y supone `
      + `S/ ${importe} de esta liquidación. Antes de aprobarla, confirme que el historial de `
      + 'descansos del empleado está completo: al migrar desde otro sistema suelen llegar '
      + 'las fechas de ingreso sin los descansos ya tomados.'
    );
  }
  if (enPeriodoPrueba) {
    avisos.push(`El cese ocurre dentro del período de prueba (${C.PERIODO_PRUEBA_MESES} meses).`);
  }
  if (causaMeta.requiereProcedimiento) {
    avisos.push('Un despido por causa justa exige carta de preaviso, plazo de descargo y carta '
      + 'de despido. Sin ese procedimiento se reputa arbitrario y genera indemnización.');
  }
  if (causaMeta.requierePreaviso) {
    avisos.push('La renuncia requiere 30 días de preaviso, salvo exoneración escrita del empleador.');
  }
  if (causaMeta.pagaHerederos) {
    avisos.push('La liquidación se entrega a los herederos, previa acreditación de su condición.');
  }
  if (neto < 0) {
    avisos.push('Los descuentos superan lo devengado. Revise los adelantos antes de emitir.');
  }

  return {
    empleado: {
      nombre: `${empleado.apellidos || ''}, ${empleado.nombres || ''}`.replace(/^, |, $/, ''),
      dni: empleado.dni,
      fechaIngreso: comoTexto(ingreso),
      fechaCese: comoTexto(cese),
      tiempoDeServicio: `${Math.floor(servicio.meses / 12)} año(s), ${servicio.meses % 12} mes(es) `
        + `y ${servicio.dias} día(s)`,
      mesesDeServicio: servicio.meses,
      enPeriodoPrueba,
    },

    causa: { codigo: causa, ...causaMeta },

    remuneracionComputable: {
      ordinaria: remOrdinaria,
      paraCTS: remCTS,
    },

    conceptos,
    descuentos,
    indemnizacion,

    rentaQuinta: detalleRenta,

    totales: {
      bruto: totalBruto,
      descuentos: totalDescuentos,
      neto,
      afectoPension: redondear(afectoPension),
      afectoRenta: redondear(afectoRenta),
    },

    avisos,

    /** Lo que exige confirmación explícita antes de aprobar */
    requiereConfirmacion: saldoInverosimil
      ? {
        motivo: 'SALDO_VACACIONES_INVEROSIMIL',
        dias: diasVacacionesPendientes,
        umbral: DIAS_VACACIONES_VEROSIMILES,
      }
      : null,

    plazo: {
      horas: C.PLAZO_PAGO_HORAS,
      aviso: `El pago debe efectuarse dentro de las ${C.PLAZO_PAGO_HORAS} horas siguientes al cese. `
        + `El certificado de trabajo también, en el mismo plazo.`,
    },
  };
}

module.exports = {
  calcularLiquidacion,
  remuneracionComputable,
  tiempoEntre,
  inicioPeriodoCTS,
  inicioSemestreGratificacion,
  ultimoAniversario,
  proporcional,
};
