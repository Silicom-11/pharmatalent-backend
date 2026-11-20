const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { patronDeBusqueda } = require('../src/utils/busqueda');

test('el buscador busca el texto literal, sin interpretarlo como patrón', () => {
  assert.equal(patronDeBusqueda(''), null);
  assert.equal(patronDeBusqueda('   '), null);
  assert.equal(patronDeBusqueda(undefined), null);
  // Un paréntesis suelto antes provocaba un error 500
  assert.doesNotThrow(() => patronDeBusqueda('García ('));
  assert.ok(patronDeBusqueda('garcía').test('Rosa García Ponce'));
  assert.ok(!patronDeBusqueda('a.b').test('axb'));
  assert.ok(patronDeBusqueda('a.b').test('a.b'));
  // Un patrón de retroceso catastrófico queda como texto inofensivo
  assert.equal(patronDeBusqueda('(a+)+$').source, '\\(a\\+\\)\\+\\$');
  assert.ok(patronDeBusqueda('x'.repeat(500)).source.length <= 60);
  assert.ok(patronDeBusqueda(['dni', 'otro']).test('dni'));
});

test('ninguna ruta arma una expresión regular con lo que escribe el usuario', () => {
  const RUTAS = path.join(__dirname, '..', 'src', 'routes');
  const crudas = [];
  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    texto.split('\n').forEach((linea, i) => {
      if (/new RegExp\((search|req\.query|q\b)/.test(linea)) crudas.push(`${archivo}:${i + 1}`);
    });
  }
  assert.deepEqual(crudas, []);
});
