const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcularLiquidacion, remuneracionComputable, tiempoEntre,
  inicioPeriodoCTS, inicioSemestreGratificacion, ultimoAniversario, proporcional,
} = require('../src/services/liquidacion');
const P = require('../src/config/payrollParams');
const C = require('../src/config/ceseParams');

/**
 * La liquidación es el documento que sustenta el último pago a un trabajador y
 * el que revisa SUNAFIL. Un error aquí no es un número mal puesto: es dinero
 * que se le debe a alguien, o una multa.
 */

const trabajador = (extra = {}) => ({
  nombres: 'Ana',
  apellidos: 'Pérez Quispe',
  dni: '45123678',
  sueldoBasico: 2400,
  tieneHijos: false,
  fechaIngreso: new Date(2022, 2, 15),      // 15 de marzo de 2022
  sistemaPensiones: 'ONP',
  ...extra,
});

const CESE = new Date(2026, 7, 31);      // 31 de agosto de 2026

const concepto = (liq, patron) => liq.conceptos.find((c) => patron.test(c.concepto));

// ─── Cómputo del tiempo ──────────────────────────────────────────────────────

test('cuenta meses completos y días sueltos como lo hace la norma', () => {
  assert.deepEqual(
    tiempoEntre(new Date(2026, 0, 15), new Date(2026, 3, 15)),
    { meses: 3, dias: 0, totalDias: 90 }
  );
  const r = tiempoEntre(new Date(2026, 0, 20), new Date(2026, 3, 10));
  assert.equal(r.meses, 2);
  assert.ok(r.dias > 0, 'los días que no completan mes deben contarse aparte');
});

test('un rango invertido o inexistente da cero, no un negativo', () => {
  assert.deepEqual(tiempoEntre(new Date(2026, 5, 1), new Date(2026, 0, 1)),
    { meses: 0, dias: 0, totalDias: 0 });
  assert.deepEqual(tiempoEntre(null, new Date()), { meses: 0, dias: 0, totalDias: 0 });
});

// ─── Remuneración computable ─────────────────────────────────────────────────

test('la asignación familiar entra en la base sólo si tiene hijos', () => {
  const sin = remuneracionComputable(trabajador());
  const con = remuneracionComputable(trabajador({ tieneHijos: true }));
  assert.equal(sin.asignacionFamiliar, 0);
  assert.equal(con.asignacionFamiliar, Math.round(P.RMV * P.ASIGNACION_FAMILIAR.porcentajeRMV * 100) / 100);
  assert.equal(con.total - sin.total, con.asignacionFamiliar);
});

test('la base de CTS añade un sexto de gratificación, la ordinaria no', () => {
  const ordinaria = remuneracionComputable(trabajador());
  const paraCTS = remuneracionComputable(trabajador(), { incluirSextoGratificacion: true });
  assert.equal(ordinaria.sextoGratificacion, 0);
  assert.equal(paraCTS.sextoGratificacion, Math.round(2400 / 6 * 100) / 100);
  assert.ok(paraCTS.total > ordinaria.total);
});

// ─── Períodos de devengo ─────────────────────────────────────────────────────

test('el período de CTS en curso arranca en mayo o en noviembre', () => {
  const ingresoAntiguo = new Date(2015, 0, 1);
  // Cese en agosto → el período empezó el 1 de mayo del mismo año
  assert.equal(inicioPeriodoCTS(new Date(2026, 7, 31), ingresoAntiguo).getMonth(), 4);
  // Cese en febrero → empezó el 1 de noviembre del año anterior
  const febrero = inicioPeriodoCTS(new Date(2026, 1, 15), ingresoAntiguo);
  assert.equal(febrero.getMonth(), 10);
  assert.equal(febrero.getFullYear(), 2025);
  // Cese en diciembre → empezó el 1 de noviembre del mismo año
  assert.equal(inicioPeriodoCTS(new Date(2026, 11, 5), ingresoAntiguo).getFullYear(), 2026);
});

test('quien ingresó dentro del período devenga desde su ingreso', () => {
  const ingresoReciente = new Date(2026, 5, 10);   // 10 de junio
  const inicio = inicioPeriodoCTS(new Date(2026, 7, 31), ingresoReciente);
  assert.equal(inicio.getTime(), ingresoReciente.getTime(),
    'no puede devengar desde antes de entrar a trabajar');
});

test('el semestre de gratificación es enero–junio o julio–diciembre', () => {
  const antiguo = new Date(2015, 0, 1);
  assert.equal(inicioSemestreGratificacion(new Date(2026, 7, 31), antiguo).getMonth(), 6);
  assert.equal(inicioSemestreGratificacion(new Date(2026, 2, 20), antiguo).getMonth(), 0);
});

test('el aniversario de vacaciones se cuenta desde el ingreso', () => {
  const ingreso = new Date(2022, 2, 15);
  const a = ultimoAniversario(new Date(2026, 7, 31), ingreso);
  assert.equal(a.getMonth(), 2);
  assert.equal(a.getDate(), 15);
  assert.equal(a.getFullYear(), 2026);

  // Si el cese es antes del aniversario del año, cuenta el del año anterior
  const b = ultimoAniversario(new Date(2026, 1, 10), ingreso);
  assert.equal(b.getFullYear(), 2025);
});

test('el proporcional usa doceavos y treintavos', () => {
  assert.equal(proporcional(1200, { meses: 6, dias: 0 }), 600);
  assert.equal(proporcional(1200, { meses: 0, dias: 30 }), 100);
  assert.equal(proporcional(1200, { meses: 3, dias: 15 }), 350);
});

// ─── Conceptos de la liquidación ─────────────────────────────────────────────

test('una renuncia devenga CTS, vacaciones y gratificación truncas', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  assert.ok(concepto(l, /tiempo de servicios/i), 'falta la CTS trunca');
  assert.ok(concepto(l, /Vacaciones truncas/), 'faltan las vacaciones truncas');
  assert.ok(concepto(l, /Gratificación trunca/), 'falta la gratificación trunca');
  assert.equal(concepto(l, /Indemnización/), undefined, 'una renuncia no indemniza');
});

test('la bonificación extraordinaria es el 9% de la gratificación trunca', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  const grat = concepto(l, /Gratificación trunca/).monto;
  const bonif = concepto(l, /Bonificación extraordinaria/).monto;
  assert.equal(bonif, Math.round(grat * P.GRATIFICACIONES.bonificacionExtraordinaria * 100) / 100);
});

test('los días trabajados del mes del cese se pagan aparte', () => {
  const sin = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  const con = calcularLiquidacion(trabajador(), {
    fechaCese: CESE, causa: 'RENUNCIA', diasTrabajadosDelMes: 15,
  });
  assert.equal(concepto(sin, /Remuneración pendiente/), undefined);
  assert.equal(concepto(con, /Remuneración pendiente/).monto, Math.round(2400 / 30 * 15 * 100) / 100);
});

test('las vacaciones adquiridas y no gozadas se pagan por día', () => {
  const l = calcularLiquidacion(trabajador(), {
    fechaCese: CESE, causa: 'RENUNCIA', diasVacacionesPendientes: 15,
  });
  assert.equal(concepto(l, /no gozadas/).monto, Math.round(2400 / 30 * 15 * 100) / 100);
});

// ─── Indemnización · art. 38 LPCL ────────────────────────────────────────────

test('el despido arbitrario indemniza 1½ remuneraciones por año', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2022, 7, 31) }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO',
  });
  // Cuatro años exactos: 4 × 1.5 × 2400
  assert.equal(concepto(l, /Indemnización/).monto, 4 * 1.5 * 2400);
});

test('la indemnización se limita a doce remuneraciones', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2000, 0, 1) }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO',
  });
  assert.equal(l.indemnizacion.aplicaTope, true);
  assert.equal(concepto(l, /Indemnización/).monto, 2400 * C.INDEMNIZACION.topeRemuneraciones);
  assert.ok(l.indemnizacion.calculado > l.indemnizacion.tope);
});

test('dentro del período de prueba no hay indemnización', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2026, 6, 1) }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO',
  });
  assert.equal(l.empleado.enPeriodoPrueba, true);
  assert.equal(l.indemnizacion.aplica, false);
  assert.equal(concepto(l, /Indemnización/), undefined);
  assert.match(l.indemnizacion.motivo, /período de prueba/);
});

test('sólo el despido arbitrario indemniza', () => {
  for (const causa of ['RENUNCIA', 'DESPIDO_JUSTIFICADO', 'VENCIMIENTO_CONTRATO',
    'MUTUO_ACUERDO', 'JUBILACION', 'PERIODO_PRUEBA']) {
    const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2018, 0, 1) }), {
      fechaCese: CESE, causa,
    });
    assert.equal(concepto(l, /Indemnización/), undefined, `${causa} no debería indemnizar`);
  }
});

// ─── Tratamiento tributario ──────────────────────────────────────────────────

test('la CTS es intangible: no aporta a pensión ni retiene renta', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  const cts = concepto(l, /tiempo de servicios/i);
  assert.equal(cts.afectacion.pension, false);
  assert.equal(cts.afectacion.rentaQuinta, false);
  // Y por tanto no engrosa ninguna de las dos bases
  assert.ok(l.totales.afectoPension < l.totales.bruto);
  assert.ok(!String(l.totales.afectoRenta).includes(String(cts.monto)));
});

test('la gratificación trunca retiene renta pero no aporta a pensión', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  const grat = concepto(l, /Gratificación trunca/);
  assert.equal(grat.afectacion.pension, false);
  assert.equal(grat.afectacion.rentaQuinta, true);
});

test('las vacaciones truncas aportan a pensión y retienen renta', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  const vac = concepto(l, /Vacaciones truncas/);
  assert.equal(vac.afectacion.pension, true);
  assert.equal(vac.afectacion.rentaQuinta, true);
});

test('la indemnización por despido es inafecta a todo', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2018, 0, 1) }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO',
  });
  const ind = concepto(l, /Indemnización/);
  assert.equal(ind.afectacion.pension, false);
  assert.equal(ind.afectacion.rentaQuinta, false);
});

test('la base afecta a pensión suma exactamente los conceptos afectos', () => {
  const l = calcularLiquidacion(trabajador({ tieneHijos: true }), {
    fechaCese: CESE, causa: 'RENUNCIA', diasTrabajadosDelMes: 20, diasVacacionesPendientes: 10,
  });
  const suma = l.conceptos.filter((c) => c.afectacion.pension).reduce((a, c) => a + c.monto, 0);
  assert.equal(Math.round(suma * 100) / 100, l.totales.afectoPension);
});

// ─── Retención de quinta categoría ───────────────────────────────────────────

test('la renta se calcula sobre el ejercicio, no proyectando la liquidación', () => {
  // Proyectar un pago único como si fuera mensual multiplicaría por doce algo
  // que ocurre una sola vez
  const l = calcularLiquidacion(trabajador({ sueldoBasico: 9000 }), {
    fechaCese: CESE, causa: 'RENUNCIA', retenidoEnElAnio: 0,
  });
  assert.ok(l.rentaQuinta.percibidoRegular > 0);
  assert.equal(
    l.rentaQuinta.totalDelEjercicio,
    Math.round((l.rentaQuinta.percibidoRegular + l.rentaQuinta.liquidacionAfecta) * 100) / 100
  );
});

test('descuenta lo ya retenido en el año', () => {
  const base = { fechaCese: CESE, causa: 'RENUNCIA' };
  const sinRetener = calcularLiquidacion(trabajador({ sueldoBasico: 9000 }), { ...base, retenidoEnElAnio: 0 });
  const conRetenido = calcularLiquidacion(trabajador({ sueldoBasico: 9000 }), { ...base, retenidoEnElAnio: 3000 });
  assert.equal(
    Math.round((sinRetener.rentaQuinta.aRetenerAhora - conRetenido.rentaQuinta.aRetenerAhora) * 100) / 100,
    3000
  );
});

test('no retiene de más si ya se retuvo todo el impuesto del año', () => {
  const l = calcularLiquidacion(trabajador({ sueldoBasico: 9000 }), {
    fechaCese: CESE, causa: 'RENUNCIA', retenidoEnElAnio: 999999,
  });
  assert.equal(l.rentaQuinta.aRetenerAhora, 0, 'la retención nunca puede ser negativa');
});

test('un sueldo bajo no llega a las 7 UIT y no retiene nada', () => {
  const l = calcularLiquidacion(trabajador({ sueldoBasico: P.RMV }), { fechaCese: CESE, causa: 'RENUNCIA' });
  assert.equal(l.rentaQuinta.aRetenerAhora, 0);
  assert.equal(l.descuentos.find((d) => /quinta/i.test(d.concepto)), undefined);
});

// ─── Totales y coherencia ────────────────────────────────────────────────────

test('bruto menos descuentos da el neto', () => {
  const l = calcularLiquidacion(trabajador({ sueldoBasico: 9000, tieneHijos: true }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO', diasTrabajadosDelMes: 31,
    diasVacacionesPendientes: 8, adelantos: 500,
  });
  assert.equal(
    Math.round((l.totales.bruto - l.totales.descuentos) * 100) / 100,
    l.totales.neto
  );
});

test('los adelantos se descuentan', () => {
  const base = { fechaCese: CESE, causa: 'RENUNCIA' };
  const sin = calcularLiquidacion(trabajador(), base);
  const con = calcularLiquidacion(trabajador(), { ...base, adelantos: 300 });
  assert.equal(Math.round((sin.totales.neto - con.totales.neto) * 100) / 100, 300);
  assert.ok(con.descuentos.some((d) => /Adelantos/.test(d.concepto)));
});

test('cada concepto cita la norma que lo sustenta', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2018, 0, 1) }), {
    fechaCese: CESE, causa: 'DESPIDO_ARBITRARIO', diasVacacionesPendientes: 5,
  });
  for (const c of l.conceptos) {
    assert.ok(c.norma && c.norma.length > 5, `«${c.concepto}» no cita su norma`);
    assert.ok(c.detalle && c.detalle.length > 5, `«${c.concepto}» no explica su cálculo`);
  }
});

// ─── Avisos que quien liquida debe leer ──────────────────────────────────────

test('avisa del procedimiento que exige un despido justificado', () => {
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2018, 0, 1) }), {
    fechaCese: CESE, causa: 'DESPIDO_JUSTIFICADO',
  });
  assert.ok(l.avisos.some((a) => /carta de preaviso/i.test(a)));
});

test('avisa del preaviso de treinta días en una renuncia', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  assert.ok(l.avisos.some((a) => /30 días de preaviso/i.test(a)));
});

test('avisa cuando la liquidación se entrega a herederos', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'FALLECIMIENTO' });
  assert.ok(l.avisos.some((a) => /herederos/i.test(a)));
});

test('avisa si los descuentos superan lo devengado', () => {
  const l = calcularLiquidacion(trabajador(), {
    fechaCese: CESE, causa: 'RENUNCIA', adelantos: 999999,
  });
  assert.ok(l.totales.neto < 0);
  assert.ok(l.avisos.some((a) => /superan lo devengado/i.test(a)));
});

test('recuerda el plazo de 48 horas', () => {
  const l = calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'RENUNCIA' });
  assert.equal(l.plazo.horas, 48);
  assert.match(l.plazo.aviso, /48 horas/);
});

// ─── Datos incompletos o incoherentes ────────────────────────────────────────

test('rechaza una causa de cese que no existe', () => {
  assert.throws(
    () => calcularLiquidacion(trabajador(), { fechaCese: CESE, causa: 'PORQUE_SI' }),
    /Causa de cese desconocida/
  );
});

test('rechaza cesar antes de la fecha de ingreso', () => {
  assert.throws(
    () => calcularLiquidacion(trabajador(), { fechaCese: new Date(2020, 0, 1), causa: 'RENUNCIA' }),
    /anterior al ingreso/
  );
});

test('rechaza calcular sin fecha de ingreso', () => {
  assert.throws(
    () => calcularLiquidacion(trabajador({ fechaIngreso: null }), { fechaCese: CESE, causa: 'RENUNCIA' }),
    /fecha de ingreso/
  );
});

test('un cese el mismo día del ingreso no revienta', () => {
  const ingreso = new Date(2026, 7, 1);
  const l = calcularLiquidacion(trabajador({ fechaIngreso: ingreso }), {
    fechaCese: ingreso, causa: 'PERIODO_PRUEBA',
  });
  assert.equal(l.totales.bruto, 0);
  assert.equal(l.totales.neto, 0);
});

// ─── Catálogo de causas ──────────────────────────────────────────────────────

test('toda causa declara su etiqueta y si indemniza', () => {
  for (const [codigo, meta] of Object.entries(C.CAUSAS)) {
    assert.ok(meta.etiqueta, `${codigo} sin etiqueta`);
    assert.equal(typeof meta.indemniza, 'boolean', `${codigo} no dice si indemniza`);
    assert.ok(meta.nota && meta.nota.length > 10, `${codigo} sin explicación`);
  }
});

test('sólo una causa indemniza, y es el despido arbitrario', () => {
  const indemnizan = Object.entries(C.CAUSAS).filter(([, m]) => m.indemniza).map(([c]) => c);
  assert.deepEqual(indemnizan, ['DESPIDO_ARBITRARIO']);
});

// ─── Saldo de vacaciones fuera de lo verosímil ───────────────────────────────

test('un saldo de vacaciones desmedido se avisa y exige confirmación', () => {
  // Al migrar desde otro sistema llegan las fechas de ingreso sin los descansos
  // ya tomados, y la liquidación pagaría años de vacaciones que sí se gozaron
  const l = calcularLiquidacion(trabajador({ fechaIngreso: new Date(2016, 0, 10) }), {
    fechaCese: CESE, causa: 'RENUNCIA', diasVacacionesPendientes: 300,
  });
  assert.ok(l.requiereConfirmacion, 'debería exigir confirmación');
  assert.equal(l.requiereConfirmacion.motivo, 'SALDO_VACACIONES_INVEROSIMIL');
  assert.equal(l.requiereConfirmacion.dias, 300);
  assert.ok(l.avisos.some((a) => /historial de\s+descansos/.test(a)));
});

test('el aviso dice cuánto dinero está en juego', () => {
  const l = calcularLiquidacion(trabajador({ sueldoBasico: 3000 }), {
    fechaCese: CESE, causa: 'RENUNCIA', diasVacacionesPendientes: 300,
  });
  const aviso = l.avisos.find((a) => /días de vacaciones/.test(a));
  assert.match(aviso, /S\/ 30000/, 'el importe debe figurar para que se entienda lo que se firma');
});

test('un saldo normal no molesta con confirmaciones', () => {
  for (const dias of [0, 15, 30, 60]) {
    const l = calcularLiquidacion(trabajador(), {
      fechaCese: CESE, causa: 'RENUNCIA', diasVacacionesPendientes: dias,
    });
    assert.equal(l.requiereConfirmacion, null, `${dias} días no deberían exigir confirmación`);
  }
});

test('avisar no recorta el saldo: se paga lo que se debe', () => {
  const l = calcularLiquidacion(trabajador(), {
    fechaCese: CESE, causa: 'RENUNCIA', diasVacacionesPendientes: 300,
  });
  const vac = concepto(l, /no gozadas/);
  assert.equal(vac.monto, Math.round(2400 / 30 * 300 * 100) / 100,
    'recortar el saldo sería decidir por el trabajador');
});
