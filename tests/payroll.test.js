const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/config/payrollParams');
const { calcularHorasExtra, calcularPension, rentaQuintaMensual, rangoDelPeriodo } = require('../src/services/payroll');

const cerca = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `esperaba ~${b}, obtuve ${a}`);

test('valor hora se deriva de la jornada de 8 horas sobre mes de 30 días', () => {
  // S/ 2,400 mensuales -> S/ 80 diarios -> S/ 10 la hora
  cerca(P.valorDia(2400), 80);
  cerca(P.valorHora(2400), 10);
});

test('horas extra: las dos primeras al 25% y el resto al 35%', () => {
  const r = calcularHorasExtra(5, 2400);   // valor hora = 10
  assert.equal(r.horasAl25, 2);
  assert.equal(r.horasAl35, 3);
  // 2 * 10 * 1.25 = 25   +   3 * 10 * 1.35 = 40.5
  cerca(r.monto, 65.5);
});

test('horas extra: menos de dos horas no alcanzan el segundo tramo', () => {
  const r = calcularHorasExtra(1.5, 2400);
  assert.equal(r.horasAl25, 1.5);
  assert.equal(r.horasAl35, 0);
  cerca(r.monto, 1.5 * 10 * 1.25);
});

test('sin horas extra el monto es cero', () => {
  const r = calcularHorasExtra(0, 2400);
  assert.equal(r.monto, 0);
});

test('ONP descuenta 13% plano, sin comisión ni prima', () => {
  const r = calcularPension(3000, 'ONP');
  cerca(r.aporte, 390);
  assert.equal(r.comision, 0);
  assert.equal(r.primaSeguro, 0);
  cerca(r.total, 390);
});

test('AFP descuenta aporte, comisión y prima de seguro', () => {
  const cfg = P.PENSIONES.AFP_INTEGRA;
  const r = calcularPension(3000, 'AFP_INTEGRA');
  cerca(r.aporte, 3000 * cfg.aporte);
  cerca(r.comision, 3000 * cfg.comision);
  cerca(r.primaSeguro, 3000 * cfg.primaSeguro);
  cerca(r.total, 3000 * (cfg.aporte + cfg.comision + cfg.primaSeguro));
});

test('la prima de seguro se topa en la remuneración máxima asegurable', () => {
  const sobreTope = P.TOPE_PRIMA_SEGURO + 5000;
  const r = calcularPension(sobreTope, 'AFP_INTEGRA');
  // El aporte sí crece con la remuneración; la prima queda fijada en el tope
  cerca(r.aporte, sobreTope * 0.10);
  cerca(r.primaSeguro, P.TOPE_PRIMA_SEGURO * P.PENSIONES.AFP_INTEGRA.primaSeguro);
});

test('un sistema previsional desconocido cae en ONP y no rompe el cálculo', () => {
  const r = calcularPension(3000, 'INEXISTENTE');
  cerca(r.total, 390);
});

test('renta de quinta: por debajo de 7 UIT no hay retención', () => {
  // 7 UIT anuales / 14 remuneraciones = umbral mensual aproximado
  const umbralMensual = (P.RENTA_QUINTA.deduccionUIT * P.UIT) / 14;
  const r = rentaQuintaMensual(umbralMensual - 100, 1);
  assert.equal(r.mensual, 0);
  assert.equal(r.anual, 0);
});

test('renta de quinta: el primer tramo grava al 8%', () => {
  // Base imponible de exactamente 1 UIT sobre la deducción
  const objetivo = (P.RENTA_QUINTA.deduccionUIT + 1) * P.UIT;
  const mensual = objetivo / 14;
  const r = rentaQuintaMensual(mensual, 1);
  cerca(r.baseImponible, P.UIT, 1);
  cerca(r.anual, P.UIT * 0.08, 1);
});

test('renta de quinta: la escala es progresiva, no un porcentaje plano', () => {
  const bajo = rentaQuintaMensual(4000, 1);
  const alto = rentaQuintaMensual(20000, 1);
  const tasaBaja = bajo.anual / bajo.proyeccionAnual;
  const tasaAlta = alto.anual / alto.proyeccionAnual;
  assert.ok(tasaAlta > tasaBaja, 'la tasa efectiva debe subir con el ingreso');
  assert.ok(tasaAlta < 0.30, 'la tasa efectiva nunca alcanza la marginal máxima');
});

test('renta de quinta: la retención mensual se reparte entre los meses que restan', () => {
  const enero = rentaQuintaMensual(10000, 1);
  const diciembre = rentaQuintaMensual(10000, 12);
  cerca(enero.anual, diciembre.anual, 0.05);
  assert.ok(diciembre.mensual > enero.mensual,
    'con menos meses por delante, la cuota mensual es mayor');
});

test('EsSalud es aporte del empleador y no figura entre los descuentos', () => {
  // La tasa vive en APORTES_EMPLEADOR; no existe como descuento del trabajador
  assert.equal(P.APORTES_EMPLEADOR.esSalud, 0.09);
  const conceptosDescuento = Object.keys(P.PENSIONES.ONP);
  assert.ok(!conceptosDescuento.includes('esSalud'));
});

test('el período YYYY-MM delimita el mes completo', () => {
  const { desde, hasta, year, month } = rangoDelPeriodo('2026-02');
  assert.equal(year, 2026);
  assert.equal(month, 2);
  assert.equal(desde.getDate(), 1);
  assert.equal(hasta.getDate(), 28, 'febrero de 2026 no es bisiesto');
});

test('el período reconoce febrero bisiesto', () => {
  const { hasta } = rangoDelPeriodo('2028-02');
  assert.equal(hasta.getDate(), 29);
});
