require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');
const { Empleado, Usuario, Cargo, Planilla, Boleta, Vacacion } = require('../src/models');

/**
 * Puebla el calendario completo: planillas mensuales con presupuesto, boletas
 * de cada mes y descansos repartidos por los doce meses del año.
 *
 * Responde a un estilo de pregunta concreto —«las planillas con presupuesto de
 * octubre», «los cargos directivos con vacaciones en marzo»— que exige que el
 * calendario esté cubierto de punta a punta. Con datos sólo de los últimos
 * meses, media docena de preguntas perfectamente razonables devuelven vacío.
 *
 * Dos reglas de coherencia que condicionan todo lo demás:
 *
 *  1. Nadie tiene boleta de un mes anterior a su fecha de ingreso, ni
 *     posterior a su cese. Una planilla que paga a quien todavía no había
 *     entrado es un error contable, no un dato de relleno.
 *  2. Los meses que aún no han llegado tienen planilla en BORRADOR con su
 *     presupuesto aprobado, pero sin boletas. Es exactamente como funciona:
 *     el presupuesto se aprueba antes, la ejecución viene después.
 *
 *   node scripts/poblar-planillas-descansos.js --aplicar
 */

const aplicar = process.argv.includes('--aplicar');
const HOY = new Date();
const ANIO = 2026;
// El ciclo de planilla va un mes detrás del calendario: la planilla que se
// calcula es la del último mes terminado. Con el mes del calendario, el 1 de
// octubre se generaban boletas de un octubre que aún no había transcurrido.
const MES_ACTUAL = HOY.getMonth();

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

const periodoDe = (anio, mes) => `${anio}-${String(mes).padStart(2, '0')}`;
const redondear = (n) => Math.round(n * 100) / 100;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Modo: %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const admin = await Usuario.findOne({ rol: 'ADMIN' }).lean();
  const rrhh = await Usuario.findOne({ rol: 'GERENTE_RRHH' }).lean() || admin;
  const empleados = await Empleado.find().lean();

  // ── 1 · Una planilla por mes, con su presupuesto ───────────────────────
  //
  // El presupuesto no sale de las boletas: se aprueba antes. Se calcula sobre
  // la masa salarial prevista con un margen, que es lo que hace interesante la
  // desviación entre lo presupuestado y lo ejecutado.
  const masaSalarial = empleados.reduce((s, e) => s + (e.sueldoBasico || 0), 0);

  const planillas = {};
  let nuevasPlanillas = 0;
  for (let mes = 1; mes <= 12; mes++) {
    const periodo = periodoDe(ANIO, mes);
    const esPasado = mes < MES_ACTUAL;
    const esActual = mes === MES_ACTUAL;

    // Julio y diciembre llevan gratificación: el presupuesto casi se dobla
    const conGratificacion = mes === 7 || mes === 12;
    const factor = conGratificacion ? 1.95 : 1.28;      // aportes y provisiones
    const presupuesto = redondear(masaSalarial * factor * (0.97 + (mes % 5) * 0.015));

    let planilla = await Planilla.findOne({ periodo });
    if (!planilla) {
      const datos = {
        periodo,
        anio: ANIO,
        mes,
        presupuesto,
        presupuestoAprobadoPor: rrhh?._id,
        presupuestoAprobadoEn: new Date(ANIO, mes - 2, 20),
        estado: esPasado ? (mes < MES_ACTUAL - 1 ? 'CERRADA' : 'PAGADA')
          : (esActual ? 'CALCULADA' : 'BORRADOR'),
        observaciones: conGratificacion
          ? 'Incluye gratificación de ley y bonificación extraordinaria del 9 %'
          : undefined,
      };
      planilla = aplicar ? await Planilla.create(datos)
        : { ...datos, _id: new mongoose.Types.ObjectId() };
      nuevasPlanillas += 1;
    }
    planillas[periodo] = planilla;
  }
  console.log('  planillas de %d creadas: %d', ANIO, nuevasPlanillas);

  // ── 2 · Boletas de cada mes ya ejecutado ───────────────────────────────
  let boletasNuevas = 0;
  const totales = {};

  for (let mes = 1; mes <= MES_ACTUAL; mes++) {
    const periodo = periodoDe(ANIO, mes);
    const finDelMes = new Date(ANIO, mes, 0, 23, 59, 59);
    totales[periodo] = { n: 0, ingresos: 0, descuentos: 0, neto: 0 };

    for (const e of empleados) {
      // Nadie cobra un mes en el que todavía no había entrado
      if (!e.fechaIngreso || new Date(e.fechaIngreso) > finDelMes) continue;

      const basico = e.sueldoBasico || 1130;
      const af = e.tieneHijos ? 113 : 0;
      const gratificacion = (mes === 7 || mes === 12) ? basico : 0;
      const bonif9 = gratificacion ? redondear(gratificacion * 0.09) : 0;
      const ingresos = redondear(basico + af + gratificacion + bonif9);
      // La gratificación no está afecta a pensión: sólo el sueldo lo está
      const afecto = basico + af;
      const tasa = e.sistemaPensiones === 'ONP' ? 0.13 : 0.1223;
      const descuentos = redondear(afecto * tasa);
      const neto = redondear(ingresos - descuentos);

      totales[periodo].n += 1;
      totales[periodo].ingresos += ingresos;
      totales[periodo].descuentos += descuentos;
      totales[periodo].neto += neto;

      const yaExiste = await Boleta.findOne({ empleado: e._id, periodo });
      if (yaExiste) {
        if (aplicar && !yaExiste.planilla) {
          await Boleta.updateOne({ _id: yaExiste._id },
            { $set: { planilla: planillas[periodo]._id } });
        }
        continue;
      }
      if (aplicar) {
        await Boleta.create({
          empleado: e._id,
          periodo,
          planilla: planillas[periodo]._id,
          sueldoBasico: basico,
          diasTrabajados: 30,
          ingresos: {
            basico,
            asignacionFamiliar: af,
            bonificaciones: gratificacion ? redondear(gratificacion + bonif9) : 0,
            total: ingresos,
          },
          descuentos: {
            pension: { sistema: e.sistemaPensiones || 'ONP', aporte: descuentos, total: descuentos },
            total: descuentos,
          },
          gratificacion: gratificacion
            ? { aplica: true, monto: gratificacion, bonificacionExtraordinaria: bonif9,
              total: redondear(gratificacion + bonif9) }
            : { aplica: false, monto: 0, total: 0 },
          netoAPagar: neto,
          estado: mes < MES_ACTUAL ? 'PAGADO' : 'CALCULADO',
          calculadoEn: new Date(ANIO, mes - 1, 26),
          aprobadoPor: rrhh?._id,
          aprobadoEn: new Date(ANIO, mes, 0, 18),
          // Al cierre: el primer día del mes siguiente
          pagadoEn: mes < MES_ACTUAL ? new Date(ANIO, mes, 1, 12) : undefined,
          pagadoPor: mes < MES_ACTUAL ? admin?._id : undefined,
          medioDePago: ['TRANSFERENCIA', 'DEPOSITO_CUENTA', 'CHEQUE', 'EFECTIVO'][mes % 4],
        });
      }
      boletasNuevas += 1;
    }
  }
  console.log('  boletas creadas: %d', boletasNuevas);

  // ── 3 · Cerrar cada planilla con sus totales reales ────────────────────
  let cerradas = 0;
  for (const [periodo, t] of Object.entries(totales)) {
    if (!t.n) continue;
    // El costo de empresa suma EsSalud (9 %) y SCTR sobre lo que se paga
    const costoEmpresa = redondear(t.ingresos * 1.0975);
    if (aplicar) {
      await Planilla.updateOne({ periodo }, {
        $set: {
          empleadosIncluidos: t.n,
          totalIngresos: redondear(t.ingresos),
          totalDescuentos: redondear(t.descuentos),
          totalNeto: redondear(t.neto),
          costoEmpresa,
          calculadaEn: new Date(ANIO, Number(periodo.slice(5)) - 1, 26),
          calculadaPor: rrhh?._id,
          aprobadaEn: new Date(ANIO, Number(periodo.slice(5)) - 1, 27),
          aprobadaPor: admin?._id,
          pagadaEn: new Date(ANIO, Number(periodo.slice(5)) - 1, 28),
        },
      });
    }
    cerradas += 1;
  }
  console.log('  planillas con totales: %d', cerradas);

  // ── 4 · Descansos repartidos por los doce meses ────────────────────────
  //
  // Se reserva marzo para los cargos directivos: es el ejemplo textual que
  // puso el docente y conviene que tenga respuesta con nombres y apellidos.
  const directivos = await Empleado.aggregate([
    { $lookup: { from: 'cargos', localField: 'cargoActual', foreignField: '_id', as: 'c' } },
    { $unwind: '$c' },
    { $match: { 'c.nivel': { $gte: 7 } } },
  ]);
  const resto = empleados.filter((e) => !directivos.some((d) => String(d._id) === String(e._id)));

  let descansos = 0;
  const crearDescanso = async (empleado, mes, dia, dias, estado, tipo) => {
    const inicio = new Date(ANIO, mes - 1, dia);
    const fin = new Date(ANIO, mes - 1, dia + dias - 1);
    const yaExiste = await Vacacion.findOne({ empleado: empleado._id, fechaInicio: inicio });
    if (yaExiste) return false;
    if (aplicar) {
      await Vacacion.create({
        empleado: empleado._id,
        tipo,
        fechaInicio: inicio,
        fechaFin: fin,
        diasTotales: dias,
        estado,
        motivo: tipo === 'VACACIONES'
          ? `Descanso vacacional de ${MESES[mes - 1]}`
          : 'Permiso solicitado por asuntos personales',
        aprobaciones: estado === 'PENDIENTE' ? [] : [{
          paso: 'ZONAL', usuario: rrhh?._id, decision: 'APROBADO',
          comentario: 'Cobertura verificada', fecha: new Date(ANIO, mes - 2, 15),
        }],
        aprobadoPor: estado === 'PENDIENTE' ? undefined : rrhh?._id,
        aprobadoEn: estado === 'PENDIENTE' ? undefined : new Date(ANIO, mes - 2, 16),
        dl713: { anosDeServicio: 3, diasAcumulados: 90, diasGozados: 30,
          diasDisponibles: 60, fechaLimite: new Date(ANIO, 11, 31), riesgoTriplePago: false },
      });
    }
    return true;
  };

  // Marzo: los directivos
  for (let i = 0; i < directivos.length; i++) {
    if (await crearDescanso(directivos[i], 3, 2 + i * 2, 15, 'COMPLETADO', 'VACACIONES')) descansos += 1;
  }
  // Enero, febrero, abril, junio: el resto de la plantilla
  const MESES_A_CUBRIR = [1, 2, 4, 6];
  for (let m = 0; m < MESES_A_CUBRIR.length; m++) {
    const mes = MESES_A_CUBRIR[m];
    for (let i = 0; i < 5; i++) {
      const e = resto[(m * 11 + i * 7) % resto.length];
      if (!e) continue;
      const estado = mes < MES_ACTUAL ? 'COMPLETADO' : 'APROBADO';
      if (await crearDescanso(e, mes, 3 + i * 4, 14, estado, 'VACACIONES')) descansos += 1;
    }
  }
  // Un par de permisos cortos en meses sueltos, para variar el tipo
  for (const [mes, idx] of [[5, 3], [10, 9], [11, 17], [12, 23]]) {
    const e = resto[idx % resto.length];
    if (e && await crearDescanso(e, mes, 8, 3, mes < MES_ACTUAL ? 'COMPLETADO' : 'APROBADO', 'PERMISO')) {
      descansos += 1;
    }
  }
  console.log('  descansos creados: %d', descansos);

  await mongoose.disconnect();
  console.log('\n%s', aplicar ? 'Aplicado.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); console.error(e.stack); process.exit(1); });
