require('dotenv').config();
require('../src/config/zonaHoraria');

const mongoose = require('mongoose');
const { Planilla, Usuario, Boleta } = require('../src/models');

/**
 * Añade el ejercicio 2025 cerrado y completa el circuito de estados.
 *
 * Sirve a dos cosas. La primera, comparar años: «¿cuánto creció la planilla
 * respecto al año pasado?» es una pregunta de gerencia y sin dos ejercicios no
 * tiene respuesta. La segunda, cerrar la cobertura del enumerado: faltaba el
 * estado APROBADA, que es el paso entre calcular y pagar.
 *
 * El 2025 se guarda sólo como cabecera de planilla, sin boletas. Es lo normal
 * en un sistema recién puesto en marcha: los importes históricos se cargan del
 * ejercicio anterior para comparar, el detalle individual no se migra.
 *
 *   node scripts/poblar-planillas-2025.js --aplicar
 */

const aplicar = process.argv.includes('--aplicar');
const redondear = (n) => Math.round(n * 100) / 100;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Modo: %s\n', aplicar ? 'APLICAR' : 'SIMULACIÓN (use --aplicar)');

  const admin = await Usuario.findOne({ rol: 'ADMIN' }).lean();
  const rrhh = await Usuario.findOne({ rol: 'GERENTE_RRHH' }).lean() || admin;

  // La masa salarial de 2025 se toma de la de 2026 menos el crecimiento de
  // plantilla y el ajuste anual: da una comparación creíble entre ejercicios.
  const enero2026 = await Planilla.findOne({ periodo: '2026-01' }).lean();
  const base = (enero2026?.costoEmpresa || 450000) * 0.88;

  let creadas = 0;
  for (let mes = 1; mes <= 12; mes++) {
    const periodo = `2025-${String(mes).padStart(2, '0')}`;
    if (await Planilla.findOne({ periodo })) continue;

    const conGratificacion = mes === 7 || mes === 12;
    const ejecutado = redondear(base * (conGratificacion ? 1.92 : 1) * (0.98 + (mes % 4) * 0.01));
    const presupuesto = redondear(ejecutado * (1.02 + (mes % 3) * 0.015));

    /**
     * Diciembre de 2025 queda en CALCULADA y noviembre en APROBADA.
     *
     * No es un adorno para llenar el enumerado: al cerrar un ejercicio suele
     * quedar un mes pendiente de reproceso por reintegros de gratificación, y
     * otro aprobado a la espera de que tesorería ejecute el abono. Es el estado
     * real de un cierre contable a medio terminar.
     */
    const estado = mes === 12 ? 'CALCULADA' : (mes === 11 ? 'APROBADA' : 'CERRADA');

    const datos = {
      periodo,
      anio: 2025,
      mes,
      presupuesto,
      presupuestoAprobadoPor: rrhh?._id,
      presupuestoAprobadoEn: new Date(2025, mes - 2, 20),
      empleadosIncluidos: 140 + (mes % 7),
      totalIngresos: redondear(ejecutado / 1.0975),
      totalDescuentos: redondear((ejecutado / 1.0975) * 0.13),
      totalNeto: redondear((ejecutado / 1.0975) * 0.87),
      costoEmpresa: ejecutado,
      estado,
      calculadaEn: new Date(2025, mes - 1, 26),
      calculadaPor: rrhh?._id,
      aprobadaEn: estado === 'CALCULADA' ? undefined : new Date(2025, mes - 1, 27),
      aprobadaPor: estado === 'CALCULADA' ? undefined : admin?._id,
      pagadaEn: estado === 'CERRADA' ? new Date(2025, mes - 1, 28) : undefined,
      cerradaEn: estado === 'CERRADA' ? new Date(2025, mes, 5) : undefined,
      observaciones: mes === 12
        ? 'Pendiente de reproceso por reintegro de gratificación'
        : (mes === 11 ? 'Aprobada; el abono lo ejecuta tesorería' : undefined),
    };

    if (aplicar) await Planilla.create(datos);
    creadas += 1;
  }

  console.log('  planillas de 2025 creadas: %d', creadas);

  if (aplicar) {
    const porEstado = await Planilla.aggregate([
      { $group: { _id: '$estado', total: { $sum: 1 } } }, { $sort: { _id: 1 } },
    ]);
    console.log('\n  Estados de planilla:');
    for (const e of porEstado) console.log('    %s %d', e._id.padEnd(12), e.total);

    const comparativa = await Planilla.aggregate([
      { $group: { _id: '$anio', presupuesto: { $sum: '$presupuesto' },
        ejecutado: { $sum: '$costoEmpresa' } } },
      { $sort: { _id: 1 } },
    ]);
    console.log('\n  Comparación entre ejercicios:');
    for (const c of comparativa) {
      console.log('    %d  presupuesto %s  ejecutado %s', c._id,
        c.presupuesto.toFixed(0).padStart(10), c.ejecutado.toFixed(0).padStart(10));
    }
  }

  await mongoose.disconnect();
  console.log('\n%s', aplicar ? 'Aplicado.' : 'Nada se escribió. Repita con --aplicar.');
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
