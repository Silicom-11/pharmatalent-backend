const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esq = require('../src/validators/esquemas');
const { leerSpec } = require('../src/middleware/validar');

const RUTAS = path.join(__dirname, '..', 'src', 'routes');

/**
 * La lista blanca de campos tiene un riesgo propio: descarta en silencio.
 *
 * Si una ruta lee `req.body.acknowledgeLegalCap` y el esquema no lo declara,
 * el campo nunca llega y la confirmación del tope de 5 años deja de funcionar
 * sin que nada falle a la vista. Estas pruebas comparan lo que cada ruta lee
 * contra lo que su esquema declara.
 */

function bloquesDeRuta() {
  const bloques = [];
  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    for (const bloque of texto.split(/router\.(?=get|post|put|patch|delete)/)) {
      const m = bloque.match(/validarCuerpo\(esq\.(\w+)\)/);
      if (m) bloques.push({ archivo, esquema: m[1], bloque });
    }
  }
  return bloques;
}

/** Campos que el código de la ruta espera encontrar en el cuerpo */
function camposLeidos(bloque) {
  const usados = new Set();
  for (const m of bloque.matchAll(/req\.body\.(\w+)/g)) usados.add(m[1]);
  const desestructurado = bloque.match(/const \{([^}]*)\} = req\.body/);
  if (desestructurado) {
    desestructurado[1]
      .split(',')
      // `= valor` es un predeterminado y `: otroNombre` un renombrado. En
      // ambos casos el campo que se lee del cuerpo es el de la izquierda:
      // en `{ correo: correoCrudo }` lo que llega por la petición es `correo`.
      .map((x) => x.split('=')[0].split(':')[0].trim())
      .filter(Boolean)
      .forEach((x) => usados.add(x));
  }
  return usados;
}

test('ninguna ruta lee un campo que su esquema descarta', () => {
  const huecos = [];
  for (const { archivo, esquema, bloque } of bloquesDeRuta()) {
    const declarados = new Set(Object.keys(esq[esquema] || {}));
    for (const campo of camposLeidos(bloque)) {
      if (!declarados.has(campo)) {
        huecos.push(`${archivo}: la ruta usa req.body.${campo} pero esq.${esquema} no lo declara`);
      }
    }
  }
  assert.deepEqual(huecos, [], `\n  ${huecos.join('\n  ')}\n`);
});

test('todo esquema referenciado por una ruta existe', () => {
  const inexistentes = [];
  for (const { archivo, esquema } of bloquesDeRuta()) {
    if (!esq[esquema]) inexistentes.push(`${archivo} referencia esq.${esquema}, que no existe`);
  }
  assert.deepEqual(inexistentes, []);
});

test('todas las especificaciones están bien escritas', () => {
  const malas = [];
  for (const [nombre, esquema] of Object.entries(esq)) {
    if (nombre === 'catalogos') continue;
    for (const [campo, spec] of Object.entries(esquema)) {
      try { leerSpec(spec); } catch (err) { malas.push(`${nombre}.${campo}: ${err.message}`); }
    }
  }
  assert.deepEqual(malas, []);
});

test('toda ruta de escritura valida su cuerpo o no lo usa', () => {
  // Una ruta que escribe sin declarar esquema deja la puerta abierta
  const sinValidar = [];
  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    for (const bloque of texto.split(/router\.(?=get|post|put|patch|delete)/)) {
      const cabecera = bloque.split('\n')[0];
      const esEscritura = /^(post|put|patch|delete)\(/.test(bloque);
      if (!esEscritura) continue;
      const usaCuerpo = camposLeidos(bloque).size > 0;
      const valida = /validarCuerpo\(/.test(bloque);
      if (usaCuerpo && !valida) {
        sinValidar.push(`${archivo}: ${cabecera.trim().slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(sinValidar, [], `\n  ${sinValidar.join('\n  ')}\n`);
});

test('ninguna ruta vuelca el cuerpo entero sobre un documento sin filtrarlo', () => {
  // Object.assign(doc, req.body) sin lista blanca deja fijar cualquier campo:
  // así se pudo marcar una boleta como PAGADA saltándose la aprobación
  const sueltas = [];
  const VUELCO = /(Object\.assign\([^,]+,\s*req\.body|\.create\(req\.body|findByIdAndUpdate\([^,]+,\s*req\.body|new [A-Z]\w*\(req\.body)/;

  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    for (const bloque of texto.split(/router\.(?=get|post|put|patch|delete)/)) {
      if (!/^(post|put|patch|delete)\(/.test(bloque)) continue;
      if (VUELCO.test(bloque) && !/validarCuerpo\(/.test(bloque)) {
        sueltas.push(`${archivo}: ${bloque.split('\n')[0].trim().slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(sueltas, [], `\n  ${sueltas.join('\n  ')}\n`);
});

test('toda ruta con :id comprueba el identificador antes de consultar', () => {
  const sinComprobar = [];
  for (const archivo of fs.readdirSync(RUTAS).filter((f) => f.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(RUTAS, archivo), 'utf8');
    texto.split('\n').forEach((linea, i) => {
      if (!/router\.(get|post|put|patch|delete)\('[^']*\/:id/.test(linea)) return;
      if (!linea.includes('validarId(')) {
        sinComprobar.push(`${archivo}:${i + 1}  ${linea.trim().slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(sinComprobar, [], `\n  ${sinComprobar.join('\n  ')}\n`);
});
