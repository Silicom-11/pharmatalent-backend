const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Los $lookup nombran la colección con un texto, y la traducción dejó uno
 * apuntando a «puestos» cuando la colección se llama «cargos»: el organigrama
 * mostraba la dotación por puesto sin el nombre de ningún puesto. Mongo no
 * avisa; esta prueba sí.
 */
test('todo $lookup apunta a la colección de un modelo', () => {
  const MODELOS = path.join(__dirname, '..', 'src', 'models');
  const colecciones = new Set();
  for (const f of fs.readdirSync(MODELOS).filter((x) => x.endsWith('.js') && x !== 'index.js')) {
    const modelo = require(path.join(MODELOS, f));
    if (modelo?.collection?.collectionName) colecciones.add(modelo.collection.collectionName);
  }
  const huerfanos = [];
  for (const dir of ['src/routes', 'src/services', 'scripts']) {
    const base = path.join(__dirname, '..', dir);
    for (const f of fs.readdirSync(base).filter((x) => x.endsWith('.js'))) {
      const texto = fs.readFileSync(path.join(base, f), 'utf8');
      for (const m of texto.matchAll(/\$lookup:\s*\{\s*from:\s*'([^']+)'/g)) {
        if (!colecciones.has(m[1])) huerfanos.push(`${dir}/${f}: from '${m[1]}'`);
      }
    }
  }
  assert.ok(colecciones.has('cargos') && colecciones.has('empleados'), 'no se leyeron los modelos');
  assert.deepEqual(huerfanos, []);
});
