const { comoTexto } = require('../utils/fechas');
const { rmvDelPeriodo } = require('../config/payrollParams');

/**
 * Armado de la boleta de pago.
 *
 * El contenido no es una elección de diseño: el D.S. 001-98-TR (arts. 18 y 19) fija qué debe
 * figurar en una boleta —identificación del empleador y del trabajador, días
 * y horas trabajadas, cada concepto remunerativo y cada descuento por
 * separado, y los aportes que asume el empleador— y obliga a conservarla. Aquí se produce esa estructura una sola vez, para que la
 * pantalla, el PDF y una eventual exportación al PLAME digan lo mismo.
 *
 * La firma digital con certificado es el paso que falta para prescindir del
 * papel; mientras tanto la boleta se imprime y se firma a mano, que es lo que
 * la norma admite.
 */

const EMPLEADOR = {
  razonSocial: 'InRetail Pharma S.A.',
  ruc: '20331066703',
  domicilio: 'Av. Defensores del Morro 1277, Chorrillos, Lima',
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const soles = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** «2026-08» → «agosto de 2026» */
function nombreDelPeriodo(periodo) {
  const [a, m] = String(periodo).split('-').map(Number);
  return `${MESES[m - 1] || '—'} de ${a}`;
}

/**
 * Importe en letras, como exige el formato de boleta.
 * Se acota a millones: una remuneración mensual no llega más lejos.
 */
const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE',
  'DIECIOCHO', 'DIECINUEVE', 'VEINTE'];
const DECENAS = ['', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function menoresDeMil(n) {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  if (n <= 20) return UNIDADES[n];

  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    if (d === 2) return u ? `VEINTI${UNIDADES[u]}` : 'VEINTE';
    return u ? `${DECENAS[d]} Y ${UNIDADES[u]}` : DECENAS[d];
  }

  const c = Math.floor(n / 100);
  const resto = n % 100;
  return resto ? `${CENTENAS[c]} ${menoresDeMil(resto)}` : CENTENAS[c];
}

function enLetras(monto) {
  const entero = Math.floor(Math.abs(monto));
  const centimos = Math.round((Math.abs(monto) - entero) * 100);

  let texto;
  if (entero === 0) {
    texto = 'CERO';
  } else if (entero < 1000) {
    texto = menoresDeMil(entero);
  } else {
    const miles = Math.floor(entero / 1000);
    const resto = entero % 1000;
    const parteMiles = miles === 1 ? 'MIL' : `${menoresDeMil(miles)} MIL`;
    texto = resto ? `${parteMiles} ${menoresDeMil(resto)}` : parteMiles;
  }

  return `${texto} CON ${String(centimos).padStart(2, '0')}/100 SOLES`;
}

/**
 * Convierte una boleta calculada en el documento que se entrega.
 * Recibe el registro con `empleado` poblado.
 */
function armarBoleta(payroll, opciones = {}) {
  const emp = payroll.empleado || {};
  const cargo = emp.cargoActual || {};
  const centro = emp.localActual || {};
  const ing = payroll.ingresos || {};
  const des = payroll.descuentos || {};
  const ap = payroll.aportesEmpleador || {};
  const dias = payroll.dias || {};

  // Cada línea se declara por separado: la norma no admite un total agregado
  const ingresos = [
    { concepto: 'Remuneración básica', monto: soles(ing.basico) },
    { concepto: 'Asignación familiar', monto: soles(ing.asignacionFamiliar), nota: `10% de la RMV (S/ ${rmvDelPeriodo(payroll.periodo)})` },
    {
      concepto: 'Horas extra',
      monto: soles(ing.horasExtra?.monto),
      nota: ing.horasExtra?.horas
        ? `${ing.horasExtra.horas} h · ${ing.horasExtra.horasAl25 || 0} al 25% y ${ing.horasExtra.horasAl35 || 0} al 35%`
        : undefined,
    },
    { concepto: 'Subsidio por incapacidad temporal', monto: soles(ing.subsidioEsSalud), nota: 'A cargo de EsSalud' },
    { concepto: 'Bonificaciones', monto: soles(ing.bonificaciones) },
  ].filter((l) => l.monto > 0);

  /**
   * Conceptos que se pagan aparte, no dentro del neto del mes.
   *
   * La gratificación se abona en los primeros quince días de julio y diciembre
   * (Ley 27735) y la CTS se deposita en la cuenta del trabajador en mayo y
   * noviembre (D.Leg. 650): no los cobra con su sueldo. Mezclarlos con los
   * ingresos del mes haría que la boleta mostrara un total que no coincide con
   * lo que efectivamente se recibe.
   */
  const aparte = [
    {
      concepto: 'Gratificación',
      monto: soles(payroll.gratificacion?.monto),
      nota: 'Se abona por separado en la primera quincena del mes',
    },
    {
      concepto: 'Bonificación extraordinaria (Ley 30334)',
      monto: soles(payroll.gratificacion?.bonificacionExtraordinaria),
      nota: '9% que se entrega en lugar del aporte a EsSalud sobre la gratificación',
    },
    {
      concepto: 'Compensación por tiempo de servicios',
      monto: soles(payroll.cts?.monto),
      nota: 'Se deposita en su cuenta CTS, no se cobra con el sueldo',
    },
  ].filter((l) => l.monto > 0);

  const pension = des.pension || {};
  const descuentos = [
    {
      concepto: pension.etiqueta || pension.sistema || 'Sistema pensionario',
      monto: soles(pension.total),
      nota: pension.comision
        ? `Aporte S/ ${soles(pension.aporte)} · comisión S/ ${soles(pension.comision)} · prima S/ ${soles(pension.primaSeguro)}`
        : undefined,
    },
    {
      concepto: 'Renta de quinta categoría',
      monto: soles(des.rentaQuinta?.monto),
      nota: des.rentaQuinta?.proyeccionAnual
        ? `Proyección anual S/ ${soles(des.rentaQuinta.proyeccionAnual)}`
        : undefined,
    },
    {
      concepto: 'Descuento por tardanza',
      monto: soles(des.tardanza?.monto),
      nota: des.tardanza?.minutosDescontados ? `${des.tardanza.minutosDescontados} minutos` : undefined,
    },
    { concepto: 'Otros descuentos', monto: soles(des.otros) },
  ].filter((l) => l.monto > 0);

  // Los aportes del empleador figuran en la boleta pero no reducen el neto
  const aportes = [
    { concepto: 'EsSalud (9%)', monto: soles(ap.esSalud) },
    { concepto: 'SCTR', monto: soles(ap.sctr) },
    { concepto: 'Senati', monto: soles(ap.senati) },
  ].filter((l) => l.monto > 0);

  const totalIngresos = soles(ing.total ?? ingresos.reduce((a, l) => a + l.monto, 0));
  const totalDescuentos = soles(des.total ?? descuentos.reduce((a, l) => a + l.monto, 0));
  const neto = soles(payroll.netoAPagar);

  return {
    empleador: opciones.empleador || EMPLEADOR,

    trabajador: {
      nombre: `${emp.apellidos || ''}, ${emp.nombres || ''}`.replace(/^, |, $/, ''),
      dni: emp.dni,
      cargo: cargo.nombre,
      centroDeTrabajo: centro.nombre,
      fechaIngreso: comoTexto(emp.fechaIngreso),
      sistemaPensionario: pension.etiqueta || pension.sistema || emp.sistemaPensiones,
      cuspp: emp.cuspp || undefined,
      // La cuenta se muestra parcialmente: la boleta circula en papel
      cuentaAbono: emp.cuentaBancaria?.cci
        ? `${emp.cuentaBancaria.banco || 'Cuenta'} ···${String(emp.cuentaBancaria.cci).slice(-4)}`
        : undefined,
    },

    periodo: {
      codigo: payroll.periodo,
      nombre: nombreDelPeriodo(payroll.periodo),
      diasCalendario: dias.calendario,
      diasRemunerados: dias.remunerados,
      diasNoLaborados: soles((dias.faltas || 0) + (dias.licenciaSinGoce || 0)) || 0,
      diasVacaciones: dias.vacaciones || 0,
      diasDescansoMedico: (dias.descansoMedicoEmpleador || 0) + (dias.descansoMedicoSubsidiado || 0),
      horasExtra: ing.horasExtra?.horas || 0,
    },

    ingresos,
    descuentos,
    aportesEmpleador: aportes,
    conceptosAparte: aparte,

    totales: {
      ingresos: totalIngresos,
      descuentos: totalDescuentos,
      aportesEmpleador: soles(ap.total ?? aportes.reduce((a, l) => a + l.monto, 0)),
      conceptosAparte: soles(aparte.reduce((a, l) => a + l.monto, 0)),
      neto,
      netoEnLetras: enLetras(neto),
    },

    estado: {
      situacion: payroll.estado,
      calculadaEl: payroll.calculadoEn ? comoTexto(payroll.calculadoEn) : undefined,
      aprobadaEl: payroll.aprobadoEn ? comoTexto(payroll.aprobadoEn) : undefined,
      pagadaEl: payroll.pagadoEn ? comoTexto(payroll.pagadoEn) : undefined,
      medioDePago: payroll.medioDePago,
      referencia: payroll.referenciaPago,
    },

    observacion: payroll.notas || undefined,

    /**
     * Mientras no haya firma digital con certificado, la boleta impresa
     * necesita la firma manuscrita del trabajador para acreditar la entrega.
     */
    constancia: payroll.estado === 'PAGADO'
      ? 'Firme al recibirla. Conserve una copia: la ley obliga al empleador a conservarla cinco años.'
      : 'Documento provisional: la boleta definitiva se emite al registrarse el pago.',
  };
}

module.exports = { armarBoleta, enLetras, nombreDelPeriodo, EMPLEADOR };
