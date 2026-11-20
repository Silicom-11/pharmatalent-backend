/**
 * Parámetros del cese y la liquidación de beneficios sociales.
 *
 * Al terminar un vínculo laboral el empleador debe pagar, dentro de las 48
 * horas siguientes, lo que se devengó y no se llegó a cobrar. No es un cálculo
 * discrecional: cada concepto tiene su norma, su base de cálculo y su
 * tratamiento tributario propio, y equivocarse expone a una multa de SUNAFIL y
 * a intereses.
 *
 * Este archivo reúne lo que cambia por decreto o por criterio, para que
 * actualizarlo no obligue a rastrear el cálculo entero.
 */

/**
 * Causas de cese, con lo que cada una implica.
 *
 * `indemniza` marca las que dan derecho a indemnización por despido arbitrario
 * (art. 34 y 38 de la LPCL). Renunciar, jubilarse o que venza el plazo pactado
 * no la generan; despedir sin causa demostrable, sí.
 */
const CAUSAS = {
  RENUNCIA: {
    etiqueta: 'Renuncia voluntaria',
    indemniza: false,
    requierePreaviso: true,      // 30 días, salvo exoneración del empleador
    nota: 'El trabajador comunica su decisión con 30 días de anticipación (art. 18 LPCL).',
  },
  DESPIDO_JUSTIFICADO: {
    etiqueta: 'Despido por causa justa',
    indemniza: false,
    requiereProcedimiento: true,
    nota: 'Exige carta de preaviso, plazo de descargo y carta de despido (art. 31 LPCL). '
      + 'Sin ese procedimiento el despido se reputa arbitrario.',
  },
  DESPIDO_ARBITRARIO: {
    etiqueta: 'Despido arbitrario',
    indemniza: true,
    nota: 'Indemnización de 1½ remuneraciones por año, con tope de 12 (art. 38 LPCL).',
  },
  VENCIMIENTO_CONTRATO: {
    etiqueta: 'Vencimiento del plazo contratado',
    indemniza: false,
    nota: 'Sólo aplica si el contrato modal llegó a su término pactado.',
  },
  MUTUO_ACUERDO: {
    etiqueta: 'Mutuo disenso',
    indemniza: false,
    nota: 'Acuerdo de partes, que debe constar por escrito (art. 16 LPCL).',
  },
  JUBILACION: {
    etiqueta: 'Jubilación',
    indemniza: false,
    nota: 'Cese por edad o por acogimiento voluntario a pensión.',
  },
  FALLECIMIENTO: {
    etiqueta: 'Fallecimiento del trabajador',
    indemniza: false,
    pagaHerederos: true,
    nota: 'La liquidación se entrega a los herederos acreditados.',
  },
  PERIODO_PRUEBA: {
    etiqueta: 'Cese dentro del período de prueba',
    indemniza: false,
    nota: 'Durante los 3 primeros meses no hay derecho a indemnización (art. 10 LPCL).',
  },
};

/** Indemnización por despido arbitrario · art. 38 LPCL */
const INDEMNIZACION = {
  remuneracionesPorAnio: 1.5,
  // Se paga por dozavos y treintavos las fracciones
  topeRemuneraciones: 12,
  nota: 'Una remuneración y media por cada año completo, con las fracciones en dozavos '
    + 'y treintavos. Tope de doce remuneraciones.',
};

/**
 * Período de prueba · art. 10 LPCL.
 * Se extiende para puestos de confianza o de dirección, pero requiere pacto escrito.
 */
const PERIODO_PRUEBA_MESES = 3;

/**
 * Tratamiento tributario de cada concepto de la liquidación.
 *
 * Importa mucho: la CTS es intangible e inafecta a todo, mientras que las
 * vacaciones truncas sí pagan pensión y renta. Tratarlas igual descuadra la
 * liquidación y la declaración.
 */
const AFECTACION = {
  ctsTrunca: {
    pension: false, rentaQuinta: false,
    nota: 'La CTS es un beneficio social intangible: no soporta aportes ni retención (D.Leg. 650).',
  },
  vacacionesTruncas: {
    pension: true, rentaQuinta: true,
    nota: 'Tienen naturaleza remunerativa: aportan a pensión y retienen quinta categoría.',
  },
  vacacionesNoGozadas: {
    pension: true, rentaQuinta: true,
    nota: 'Remuneración vacacional pendiente de goce.',
  },
  gratificacionTrunca: {
    pension: false, rentaQuinta: true,
    nota: 'Inafecta a aportes previsionales por la Ley 30334; sí retiene quinta categoría.',
  },
  bonificacionExtraordinaria: {
    pension: false, rentaQuinta: true,
    nota: 'El 9% que sustituye al aporte a EsSalud sobre la gratificación (Ley 30334).',
  },
  indemnizacion: {
    pension: false, rentaQuinta: false,
    nota: 'La indemnización por despido arbitrario es inafecta al impuesto a la renta '
      + '(art. 18 inc. a de la Ley del Impuesto a la Renta).',
  },
  remuneracionPendiente: {
    pension: true, rentaQuinta: true,
    nota: 'Días efectivamente trabajados en el mes del cese.',
  },
};

/** Plazo legal para pagar la liquidación */
const PLAZO_PAGO_HORAS = 48;

/**
 * Certificado de trabajo · art. 45 del D.S. 001-96-TR.
 * El empleador debe entregarlo dentro de las 48 horas del cese.
 */
const PLAZO_CERTIFICADO_HORAS = 48;

module.exports = {
  CAUSAS,
  INDEMNIZACION,
  PERIODO_PRUEBA_MESES,
  AFECTACION,
  PLAZO_PAGO_HORAS,
  PLAZO_CERTIFICADO_HORAS,
  CAUSAS_CODIGOS: Object.keys(CAUSAS),
};
