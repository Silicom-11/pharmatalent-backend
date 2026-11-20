require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');
const { Empleado } = require('../src/models');

/**
 * Rellena los datos de ficha que quedaron vacíos en la carga inicial.
 *
 * Correo corporativo, fecha de nacimiento y cuenta de abono. No son adorno:
 * sin fecha de nacimiento no se puede responder «quién cumple años este mes»
 * ni «cuántos superan los 50», y sin cuenta bancaria la pregunta «¿a qué
 * cuenta se le paga a esta persona?» no tiene respuesta aunque la boleta
 * exista.
 *
 * Todo lo que genera es único y determinista: el correo se deriva del nombre y
 * del DNI, y el CCI del DNI. Ejecutarlo dos veces no cambia nada.
 *
 *   node scripts/completar-fichas.js --aplicar
 */

const aplicar = process.argv.includes('--aplicar');

const BANCOS = ['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'BanBif', 'Pichincha'];
/** Código de entidad en el CCI, para que el número sea verosímil */
const CODIGO_BANCO = { BCP: '002', BBVA: '011', Interbank: '003', Scotiabank: '009', BanBif: '038', Pichincha: '049' };

const sinTildes = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function correoDe(e, tomados) {
  const nombre = sinTildes(e.nombres.split(' ')[0]);
  const apellido = sinTildes(e.apellidos.split(' ')[0]);
  let base = `${nombre}.${apellido}`;
  if (tomados.has(`${base}@pharmatalent.pe`)) {
    // Homónimos: se desempata con la inicial del segundo apellido y, si aún
    // choca, con los últimos dígitos del DNI. Nunca dos personas con el mismo.
    const segundo = sinTildes(e.apellidos.split(' ')[1] || '');
    base = segundo ? `${base}${segundo[0]}` : base;
    if (tomados.has(`${base}@pharmatalent.pe`)) base = `${base}${e.dni.slice(-3)}`;
  }
  return `${base}@pharmatalent.pe`;
}

/**
 * Fecha de nacimiento verosímil y repartida por los doce meses.
 *
 * Se deriva del DNI para que sea estable entre ejecuciones. No se fuerza
 * ningún mes: con 182 personas, el reparto uniforme ya deja unas quince por
 * mes, suficientes para que «quién cumple años este mes» tenga respuesta sin
 * que la distribución delate que los datos son inventados.
 */
function nacimientoDe(dni, indice, _mesActual) {
  // Mezcla de todos los dígitos del DNI: tomar sólo los últimos cuatro
  // agrupaba cuarenta personas en el mismo mes, porque los DNI de la carga
  // inicial comparten terminación.
  let h = indice * 2654435761;
  for (const c of dni) h = ((h * 31) + c.charCodeAt(0)) >>> 0;

  const edad = 21 + (h % 39);                       // entre 21 y 59 años
  const anio = 2026 - edad;
  const mes = (Math.floor(h / 39) % 12) + 1;
  const dia = (Math.floor(h / 468) % 28) + 1;
  return new Date(anio, mes - 1, dia);
}

function cuentaDe(dni, indice) {
  const banco = BANCOS[indice % BANCOS.length];
  // CCI peruano: 20 dígitos (entidad + oficina + cuenta + control)
  const cci = `${CODIGO_BANCO[banco]}${String(190 + (indice % 60))}`
    + `${dni}${String((parseInt(dni, 10) % 97) + 10).padStart(2, '0')}`.padEnd(14, '0').slice(0, 14);
  return { cci: cci.slice(0, 20), banco };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Modo: %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const mesActual = new Date().getMonth() + 1;
  const empleados = await Empleado.find().sort({ dni: 1 }).lean();
  const tomados = new Set(empleados.map((e) => e.correo).filter(Boolean));

  let correos = 0;
  let nacimientos = 0;
  let cuentas = 0;

  for (let i = 0; i < empleados.length; i++) {
    const e = empleados[i];
    const cambios = {};

    if (!e.correo) {
      const c = correoDe(e, tomados);
      tomados.add(c);
      cambios.correo = c;
      correos += 1;
    }
    if (!e.fechaNacimiento) {
      cambios.fechaNacimiento = nacimientoDe(e.dni, i, mesActual);
      nacimientos += 1;
    }
    if (!e.cuentaBancaria?.cci) {
      cambios.cuentaBancaria = cuentaDe(e.dni, i);
      cuentas += 1;
    }

    if (Object.keys(cambios).length && aplicar) {
      await Empleado.updateOne({ _id: e._id }, { $set: cambios });
    }
  }

  console.log('  correos corporativos    %d', correos);
  console.log('  fechas de nacimiento    %d', nacimientos);
  console.log('  cuentas de abono        %d', cuentas);

  if (aplicar) {
    const total = await Empleado.countDocuments();
    const unicos = (await Empleado.distinct('correo')).filter(Boolean).length;
    const cci = (await Empleado.distinct('cuentaBancaria.cci')).filter(Boolean).length;
    console.log('\n  %d empleados · %d correos distintos · %d cuentas distintas',
      total, unicos, cci);
    const desde = new Date(2026, mesActual - 1, 1);
    const hasta = new Date(2026, mesActual, 0, 23, 59, 59);
    const cumplen = await Empleado.countDocuments({
      $expr: { $eq: [{ $month: '$fechaNacimiento' }, mesActual] },
    });
    console.log('  cumpleaños en el mes en curso: %d', cumplen);
  }

  await mongoose.disconnect();
  console.log('\n%s', aplicar ? 'Aplicado.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
