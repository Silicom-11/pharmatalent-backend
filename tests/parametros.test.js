const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RUTAS = path.join(__dirname, '..', 'src', 'routes');

/**
 * Cada ruta lee de req.params sólo lo que declara en su camino.
 *
 * La traducción dejó rutas que declaraban «:period» y leían
 * `req.params.periodo`: el valor llegaba vacío, Mongoose descartaba el filtro
 * y «pagar el período» pagaba las boletas aprobadas de todos los meses.
 */
test('ninguna ruta lee un parámetro que su camino no declara', () => {
  const huerfanos = [];
  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    for (const bloque of texto.split(/router\.(?=get\(|post\(|put\(|patch\(|delete\()/).slice(1)) {
      const camino = bloque.match(/^\w+\(\s*'([^']*)'/)?.[1];
      if (camino === undefined) continue;
      const declarados = new Set([...camino.matchAll(/:(\w+)/g)].map((m) => m[1]));
      // Hasta la siguiente ruta: el bloque puede incluir funciones auxiliares
      // que reciben los parámetros de otra forma; sólo cuenta el uso directo
      const usados = new Set([...bloque.matchAll(/req\.params\.(\w+)/g)].map((m) => m[1]));
      const { groups } = bloque.match(/const \{ (?<campos>[\w, ]+) \} = req\.params/) || { groups: null };
      for (const c of groups?.campos.split(',').map((x) => x.trim()) || []) usados.add(c);
      for (const u of usados) {
        if (!declarados.has(u)) huerfanos.push(`${archivo} ${camino}: lee req.params.${u}`);
      }
    }
  }
  assert.deepEqual(huerfanos, [], `\n  ${huerfanos.join('\n  ')}\n`);
});
