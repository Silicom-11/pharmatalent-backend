/**
 * Patrón de búsqueda a partir de lo que una persona escribe en un buscador.
 *
 * El texto se usaba tal cual como expresión regular: escribir «(» en el
 * buscador de empleados devolvía un error 500, y un patrón como «(a+)+$»
 * deja a MongoDB evaluando combinaciones durante segundos. Aquí el texto se
 * busca literalmente, sin distinguir mayúsculas, y con un largo acotado.
 *
 * @param {unknown} texto  valor de req.query (puede no ser una cadena)
 * @returns {RegExp|null}  null si no hay nada que buscar
 */
function patronDeBusqueda(texto) {
  const limpio = String(Array.isArray(texto) ? texto[0] : texto ?? '').trim().slice(0, 60);
  if (!limpio) return null;
  return new RegExp(limpio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

module.exports = { patronDeBusqueda };
