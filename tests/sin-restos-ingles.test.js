const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Restos de la traducción del modelo al castellano.
 *
 * Los documentos ya no tienen `status`, `employee` ni `location`: tienen
 * `estado`, `empleado` y `localActual`. Leer el nombre viejo no falla, devuelve
 * `undefined` en silencio, y así el tablero del CEDI contaba cero activos y
 * «Mis Vacaciones» mostraba cero solicitudes en trámite. Esta prueba busca esas
 * lecturas en el backend y en el frontend.
 */
const RAICES = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', '..', 'pharmatalent-frontend', 'src'),
];
// Lecturas legítimas de `.status`: respuestas HTTP y Promise.allSettled
const PERMITIDO = /(res|response|r|err|p|a|s|l|z|u|e|t|c|rec|x|v|d)\.status\s*(===\s*'(fulfilled|rejected)'|\(|,|\)|;|$)|\.status\(|response\??\.status|err\.response|statusCode|status:/;

function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : archivos(ruta);
    return /\.(js|jsx)$/.test(e.name) ? [ruta] : [];
  });
}

test('ningún archivo lee un campo con su nombre anterior a la traducción', () => {
  const hallados = [];
  for (const raiz of RAICES.filter((r) => fs.existsSync(r))) {
    for (const archivo of archivos(raiz)) {
      fs.readFileSync(archivo, 'utf8').split('\n').forEach((linea, i) => {
        // Comentarios de línea y de bloque no son lecturas
        if (/^\s*(\*|\/\*)/.test(linea)) return;
        const sinComentario = linea.replace(/\/\/.*$/, '');
        for (const m of sinComentario.matchAll(/\b\w+\??\.(status|employee|currentZone|currentLocation|hireDate|baseSalary)\b[^\w]?/g)) {
          const fragmento = sinComentario.slice(Math.max(0, m.index - 2), m.index + m[0].length + 25);
          if (m[1] === 'status' && PERMITIDO.test(fragmento)) continue;
          if (m[1] === 'status' && /\.status\s*===\s*'(fulfilled|rejected)'/.test(sinComentario)) continue;
          hallados.push(`${path.relative(path.join(__dirname, '..', '..'), archivo)}:${i + 1}  ${linea.trim().slice(0, 90)}`);
        }
      });
    }
  }
  assert.deepEqual(hallados, [], `\n  ${hallados.join('\n  ')}\n`);
});
