const P = require('../config/payrollParams');

/**
 * Ninguna remuneración de jornada completa por debajo de la RMV.
 *
 * Mantenimiento adaptativo MNT-2026-014: con la RMV en S/ 1,230 desde el
 * 01/10/2026 (D.S. 015-2026-TR), el sistema seguía aceptando sueldos de
 * S/ 1,130. La comparación se hace contra la RMV que rige en la fecha desde la
 * que vale el sueldo, no contra la de hoy: un contrato de agosto de 2026 con
 * S/ 1,130 era legal.
 *
 * El tiempo parcial (menos de cuatro horas diarias) se paga en proporción y
 * queda fuera. Las prácticas sí entran: su subvención mínima es la RMV
 * (Ley 28518, de modalidades formativas).
 *
 * @returns {string|null} el motivo del rechazo, o null si el monto es legal
 */
function revisarSueldoMinimo(monto, { fecha = new Date(), tipoContrato } = {}) {
  if (monto === undefined || monto === null || monto === '') return null;
  if (tipoContrato === 'PART_TIME') return null;
  const valor = Number(monto);
  if (!Number.isFinite(valor)) return null;
  const rmv = P.rmvVigenteDetalle(fecha);
  if (valor >= rmv.valor) return null;
  return `La remuneración (S/ ${valor.toFixed(2)}) no puede ser menor que la Remuneración Mínima Vital `
    + `vigente: S/ ${rmv.valor.toFixed(2)} desde el ${rmv.desde.split('-').reverse().join('/')} (${rmv.norma}).`;
}

module.exports = { revisarSueldoMinimo };
