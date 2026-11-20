/**
 * Tope de página.
 *
 * Sin límite, `?limit=999999` devuelve la planilla entera en una sola
 * respuesta. Eso es dos cosas a la vez: una forma barata de tumbar el proceso
 * —o de agotar la memoria del servidor— y un acelerador para quien quiera
 * llevarse los datos, porque convierte 400 peticiones paginadas en una.
 *
 * A escala de InRetail, un solo `limit=20000` sobre empleados traería
 * varios megabytes de datos personales en una respuesta.
 */

const TOPE = 200;
const POR_DEFECTO = 20;

/**
 * Devuelve `page`, `limit` y `skip` ya acotados.
 * Nunca confía en lo que venga: un límite absurdo se recorta al tope, y uno
 * ilegible cae al valor por defecto.
 */
function paginacionDe(query = {}, { tope = TOPE, porDefecto = POR_DEFECTO } = {}) {
  const pedido = Number(query.limit);
  const limit = Number.isFinite(pedido) && pedido > 0
    ? Math.min(Math.floor(pedido), tope)
    : porDefecto;

  const paginaPedida = Number(query.page);
  const page = Number.isFinite(paginaPedida) && paginaPedida > 0
    ? Math.floor(paginaPedida)
    : 1;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    // Para que la respuesta pueda avisar de que se recortó
    recortado: Number.isFinite(pedido) && pedido > tope ? tope : null,
  };
}

/** Arma el bloque `pagination` de la respuesta */
function respuestaPaginada({ page, limit }, total) {
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = { paginacionDe, respuestaPaginada, TOPE, POR_DEFECTO };
