/**
 * Fechas sin sorpresas de huso horario.
 *
 * `new Date('2026-08-29')` se interpreta como medianoche UTC. Al mostrarla en
 * Perú (UTC-5) aparece el 28: un día antes del que se escribió. En una boleta
 * eso mueve la fecha de pago declarada; en un contrato, el día de cese. Aquí se
 * parsea siempre por componentes, anclando al día local que se quiso decir.
 */

const SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Convierte una fecha a Date anclada al día local.
 * Un texto `YYYY-MM-DD` se toma como ese día aquí, no en UTC.
 * Devuelve null si no es interpretable.
 */
function aFechaLocal(valor) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor !== 'string') return null;

  const m = valor.trim().match(SOLO_FECHA);
  if (m) {
    const [, a, mes, d] = m;
    const fecha = new Date(Number(a), Number(mes) - 1, Number(d));
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }

  // Con hora explícita se respeta lo que venga (suele ser un ISO completo)
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Medianoche local del día indicado, útil para comparar «es hoy o antes» */
function inicioDelDia(valor = new Date()) {
  const f = aFechaLocal(valor) || new Date();
  return new Date(f.getFullYear(), f.getMonth(), f.getDate());
}

/** Último instante del día local */
function finDelDia(valor = new Date()) {
  const f = inicioDelDia(valor);
  return new Date(f.getFullYear(), f.getMonth(), f.getDate(), 23, 59, 59, 999);
}

/** `YYYY-MM-DD` del día local, sin pasar por UTC */
function comoYMD(valor = new Date()) {
  const f = aFechaLocal(valor);
  if (!f) return null;
  const dos = (n) => String(n).padStart(2, '0');
  return `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
}

/** Formato legible peruano: 29/08/2026 */
function comoTexto(valor) {
  const f = aFechaLocal(valor);
  if (!f) return '—';
  const dos = (n) => String(n).padStart(2, '0');
  return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()}`;
}

module.exports = { aFechaLocal, inicioDelDia, finDelDia, comoYMD, comoTexto };
