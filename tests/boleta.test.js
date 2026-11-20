const test = require('node:test');
const assert = require('node:assert/strict');
const { armarBoleta, enLetras, nombreDelPeriodo } = require('../src/services/boleta');

/** Boleta de referencia, con los mismos datos que produce el motor de cálculo */
const ejemplo = () => ({
  periodo: '2026-07',
  netoAPagar: 9054.36,
  estado: 'PAGADO',
  pagadoEn: new Date(2026, 6, 29),
  medioDePago: 'TRANSFERENCIA',
  empleado: {
    nombres: 'Ana', apellidos: 'Pérez Quispe', dni: '45123678',
    fechaIngreso: new Date(2018, 2, 14),
    cuentaBancaria: { cci: '00219100123456789012', banco: 'BCP' },
    cargoActual: { nombre: 'Química Farmacéutica' },
    localActual: { nombre: 'Inkafarma San Miguel' },
  },
  dias: { calendario: 30, remunerados: 30, faltas: 0 },
  ingresos: {
    basico: 15000,
    asignacionFamiliar: 113,
    horasExtra: { horas: 6, horasAl25: 4, horasAl35: 2, monto: 0 },
    total: 15113,
  },
  descuentos: {
    pension: { etiqueta: 'AFP Profuturo', aporte: 1500, comision: 253.5, primaSeguro: 218.72, total: 1972.22 },
    rentaQuinta: { monto: 4086.42, proyeccionAnual: 210000 },
    total: 6058.64,
  },
  aportesEmpleador: { esSalud: 1350, sctr: 0, total: 1350 },
  gratificacion: { monto: 15000, bonificacionExtraordinaria: 1350 },
  cts: { monto: 8750 },
});

// ─── Aritmética que debe cuadrar ─────────────────────────────────────────────

test('las líneas declaradas suman exactamente el total declarado', () => {
  const b = armarBoleta(ejemplo());
  const sumaIngresos = b.ingresos.reduce((a, l) => a + l.monto, 0);
  const sumaDescuentos = b.descuentos.reduce((a, l) => a + l.monto, 0);
  assert.equal(Math.round(sumaIngresos * 100) / 100, b.totales.ingresos);
  assert.equal(Math.round(sumaDescuentos * 100) / 100, b.totales.descuentos);
});

test('ingresos menos descuentos da el neto', () => {
  const b = armarBoleta(ejemplo());
  assert.equal(
    Math.round((b.totales.ingresos - b.totales.descuentos) * 100) / 100,
    b.totales.neto
  );
});

test('la gratificación y la CTS van aparte, no dentro del neto del mes', () => {
  // Se pagan en otra fecha: incluirlas en los ingresos mostraría un total
  // que no coincide con lo que el trabajador recibe ese mes
  const b = armarBoleta(ejemplo());
  const enIngresos = b.ingresos.map((l) => l.concepto).join(' ');
  assert.doesNotMatch(enIngresos, /Gratificación|tiempo de servicios/);

  const aparte = b.conceptosAparte.map((l) => l.concepto).join(' ');
  assert.match(aparte, /Gratificación/);
  assert.match(aparte, /tiempo de servicios/);
  assert.equal(b.totales.conceptosAparte, 25100);
});

test('EsSalud figura como aporte del empleador y nunca como descuento', () => {
  const b = armarBoleta(ejemplo());
  assert.doesNotMatch(b.descuentos.map((l) => l.concepto).join(' '), /EsSalud/);
  assert.match(b.aportesEmpleador.map((l) => l.concepto).join(' '), /EsSalud/);
  // Y no reduce el neto
  assert.equal(b.totales.neto, 9054.36);
});

// ─── Contenido que la norma exige ────────────────────────────────────────────

test('identifica al empleador con su RUC', () => {
  const b = armarBoleta(ejemplo());
  assert.match(b.empleador.ruc, /^20\d{9}$/);
  assert.ok(b.empleador.razonSocial.length > 3);
});

test('identifica al trabajador, su puesto y su fecha de ingreso', () => {
  const b = armarBoleta(ejemplo());
  assert.equal(b.trabajador.dni, '45123678');
  assert.match(b.trabajador.nombre, /Pérez Quispe, Ana/);
  assert.equal(b.trabajador.cargo, 'Química Farmacéutica');
  assert.equal(b.trabajador.fechaIngreso, '14/03/2018');
});

test('declara los días y las horas del período', () => {
  const b = armarBoleta(ejemplo());
  assert.equal(b.periodo.diasRemunerados, 30);
  assert.equal(b.periodo.diasCalendario, 30);
  assert.equal(b.periodo.horasExtra, 6);
  assert.equal(b.periodo.nombre, 'julio de 2026');
});

test('cada descuento se detalla por separado, no agregado', () => {
  const b = armarBoleta(ejemplo());
  const conceptos = b.descuentos.map((l) => l.concepto);
  assert.ok(conceptos.some((c) => /AFP|ONP|pension/i.test(c)));
  assert.ok(conceptos.some((c) => /quinta/i.test(c)));
  // Y el desglose de la AFP se explica en la nota
  const afp = b.descuentos.find((l) => /AFP/.test(l.concepto));
  assert.match(afp.nota, /comisión/);
  assert.match(afp.nota, /prima/);
});

test('la cuenta bancaria se muestra parcialmente', () => {
  const b = armarBoleta(ejemplo());
  assert.equal(b.trabajador.cuentaAbono, 'BCP ···9012');
  assert.doesNotMatch(b.trabajador.cuentaAbono, /00219100/);
});

test('sin cuenta registrada no inventa un texto', () => {
  const datos = ejemplo();
  delete datos.empleado.cuentaBancaria;
  assert.equal(armarBoleta(datos).trabajador.cuentaAbono, undefined);
});

// ─── Estado y constancia ─────────────────────────────────────────────────────

test('una boleta no pagada se marca como provisional', () => {
  const datos = { ...ejemplo(), estado: 'CALCULADO', pagadoEn: undefined };
  assert.match(armarBoleta(datos).constancia, /provisional/i);
});

test('una boleta pagada recuerda el deber de conservarla', () => {
  const b = armarBoleta(ejemplo());
  assert.match(b.constancia, /cinco años/);
  assert.equal(b.estado.pagadaEl, '29/07/2026');
});

// ─── Importe en letras ───────────────────────────────────────────────────────

test('escribe el neto en letras', () => {
  assert.equal(armarBoleta(ejemplo()).totales.netoEnLetras,
    'NUEVE MIL CINCUENTA Y CUATRO CON 36/100 SOLES');
});

test('los casos irregulares del castellano salen bien', () => {
  assert.equal(enLetras(100), 'CIEN CON 00/100 SOLES');
  assert.equal(enLetras(101), 'CIENTO UNO CON 00/100 SOLES');
  assert.equal(enLetras(21), 'VEINTIUNO CON 00/100 SOLES');
  assert.equal(enLetras(1000), 'MIL CON 00/100 SOLES');
  assert.equal(enLetras(2000), 'DOS MIL CON 00/100 SOLES');
  assert.equal(enLetras(16), 'DIECISÉIS CON 00/100 SOLES');
  assert.equal(enLetras(0), 'CERO CON 00/100 SOLES');
});

test('los céntimos nunca se pierden', () => {
  for (const [monto, esperado] of [[1130.5, '50'], [1130.05, '05'], [1130.99, '99'], [1130, '00']]) {
    assert.match(enLetras(monto), new RegExp(`CON ${esperado}/100`), `falló con ${monto}`);
  }
});

test('nombra correctamente cualquier mes', () => {
  assert.equal(nombreDelPeriodo('2026-01'), 'enero de 2026');
  assert.equal(nombreDelPeriodo('2026-12'), 'diciembre de 2026');
});

// ─── Robustez ────────────────────────────────────────────────────────────────

test('no se rompe con una boleta a medio calcular', () => {
  assert.doesNotThrow(() => armarBoleta({ periodo: '2026-01', empleado: {} }));
  const b = armarBoleta({ periodo: '2026-01', empleado: {} });
  assert.equal(b.totales.neto, 0);
  assert.deepEqual(b.ingresos, []);
});

test('omite las líneas en cero en vez de listarlas vacías', () => {
  const datos = ejemplo();
  datos.ingresos.asignacionFamiliar = 0;
  const b = armarBoleta(datos);
  assert.doesNotMatch(b.ingresos.map((l) => l.concepto).join(' '), /Asignación familiar/);
});
