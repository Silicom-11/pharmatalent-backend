require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');

/**
 * Comprueba que la base de datos pueda responder a cualquier pregunta.
 *
 * Recorre todos los enumerados declarados en los esquemas y cuenta cuántos
 * documentos tiene cada valor. Un valor con cero documentos es una consulta
 * que devuelve la lista vacía: el sistema funciona, pero delante de un
 * examinador parece que no.
 *
 * También revisa las condiciones que dependen de la fecha —quién está de
 * vacaciones hoy, qué contratos vencen este mes—, que no se ven mirando
 * enumerados y son justo las que se preguntan en una demostración.
 */

const models = require('../src/models');
const Bitacora = require('../src/models/Bitacora');

const HOY = new Date();

/** Recorre un esquema y devuelve [ruta, valores] de cada campo enumerado */
function enumerados(schema, prefijo = '') {
  const salida = [];
  schema.eachPath((ruta, tipo) => {
    if (ruta === '_id' || ruta === '__v') return;
    const completa = prefijo ? `${prefijo}.${ruta}` : ruta;

    const valores = tipo.options?.enum
      || tipo.caster?.options?.enum
      || (Array.isArray(tipo.options?.type) ? tipo.options.type[0]?.enum : null);
    if (Array.isArray(valores) && valores.length) {
      salida.push([completa, valores.filter((v) => v !== null)]);
    }
    if (tipo.schema) salida.push(...enumerados(tipo.schema, completa));
  });
  return salida;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const huecos = [];
  let revisados = 0;

  console.log('COBERTURA DE VALORES ENUMERADOS\n');
  for (const [nombre, M] of Object.entries({ ...models, Bitacora })) {
    const total = await M.countDocuments();
    const campos = enumerados(M.schema);
    if (!campos.length) continue;

    const lineas = [];
    for (const [ruta, valores] of campos) {
      const vacios = [];
      for (const v of valores) {
        revisados += 1;
        const n = await M.countDocuments({ [ruta]: v });
        if (n === 0) vacios.push(v);
      }
      if (vacios.length) {
        lineas.push(`    ${ruta.padEnd(28)} sin datos: ${vacios.join(', ')}`);
        huecos.push([nombre, ruta, vacios]);
      }
    }
    if (lineas.length) {
      console.log(`  ${nombre} (${total} documentos)`);
      lineas.forEach((l) => console.log(l));
    }
  }

  // ─── Preguntas que dependen de la fecha ────────────────────────────────────
  const { Empleado, Vacacion, Contrato, Asistencia, Boleta } = models;
  const en30 = new Date(HOY.getTime() + 30 * 86400000);
  const mesActual = `${HOY.getFullYear()}-${String(HOY.getMonth() + 1).padStart(2, '0')}`;
  const inicioMes = new Date(HOY.getFullYear(), HOY.getMonth(), 1);
  const finMes = new Date(HOY.getFullYear(), HOY.getMonth() + 1, 0, 23, 59, 59);
  const cerrado = new Date(HOY.getFullYear(), HOY.getMonth() - 1, 1);
  const periodoCerrado = `${cerrado.getFullYear()}-${String(cerrado.getMonth() + 1).padStart(2, '0')}`;

  const temporales = [
    ['Empleados contratados este mes',
      await Empleado.countDocuments({ fechaIngreso: { $gte: inicioMes, $lte: finMes } })],
    ['Empleados de vacaciones hoy (estado)',
      await Empleado.countDocuments({ estado: 'VACACIONES' })],
    ['Descansos vigentes hoy (fechas)',
      await Vacacion.countDocuments({ fechaInicio: { $lte: HOY }, fechaFin: { $gte: HOY } })],
    ['Contratos que vencen en 30 días',
      await Contrato.countDocuments({ fechaFin: { $gte: HOY, $lte: en30 } })],
    ['Contratos ya vencidos',
      await Contrato.countDocuments({ fechaFin: { $lt: HOY }, estado: { $ne: 'TERMINADO' } })],
    ['Asistencias de hoy',
      await Asistencia.countDocuments({ fecha: { $gte: new Date(HOY.toDateString()) } })],
    // La planilla que existe es la del último mes terminado: la del mes en
    // curso se calcula al cerrarlo. Preguntar por las boletas de un mes que
    // recién empieza tiene que devolver cero, y eso es lo correcto.
    [`Boletas del último período cerrado (${periodoCerrado})`,
      await Boleta.countDocuments({ periodo: periodoCerrado })],
    ['Empleados con más de 5 años de servicio',
      await Empleado.countDocuments({ fechaIngreso: { $lte: new Date(HOY.getFullYear() - 5, HOY.getMonth(), HOY.getDate()) } })],
    ['Empleados con asignación familiar',
      await Empleado.countDocuments({ tieneHijos: true })],
    ['Practicantes vigentes',
      await Empleado.countDocuments({ esPracticante: true })],
    ['Directores técnicos designados',
      await Empleado.countDocuments({ esDirectorTecnico: true })],
  ];

  console.log('\nPREGUNTAS QUE DEPENDEN DE LA FECHA\n');
  for (const [pregunta, n] of temporales) {
    console.log('  %s %s %s', n === 0 ? '✗' : '·', String(n).padStart(5), pregunta);
    if (n === 0) huecos.push(['(temporal)', pregunta, []]);
  }

  console.log('\n%d combinaciones revisadas · %d sin un solo documento',
    revisados + temporales.length, huecos.length);

  await mongoose.disconnect();
  process.exit(huecos.length ? 1 : 0);
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(2); });
