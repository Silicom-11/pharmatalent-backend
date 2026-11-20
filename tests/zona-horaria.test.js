const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/**
 * El sistema debe comportarse igual se despliegue donde se despliegue.
 *
 * Estas pruebas arrancan procesos hijos con la zona del sistema forzada a otras
 * —lo que hace un servidor en la nube— y comprueban que el resultado no cambia.
 * Se hace en procesos aparte porque Node fija la zona al construir la primera
 * fecha: cambiarla dentro de la misma prueba no probaría nada.
 */

const RAIZ = path.join(__dirname, '..');
const ZONAS_DE_SERVIDOR = ['UTC', 'America/New_York', 'Europe/Madrid', 'Asia/Tokyo'];

/**
 * Ejecuta un fragmento con la zona indicada y devuelve su última línea.
 * Se descarta el resto porque dotenv escribe un aviso propio antes.
 */
function enZona(zona, codigo, extra = {}) {
  const salida = execFileSync(process.execPath, ['-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, TZ: zona, ...extra },
    encoding: 'utf8',
  });
  const lineas = salida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lineas[lineas.length - 1] || '';
}

test('la zona se impone aunque el servidor arranque en otra', () => {
  for (const zona of ZONAS_DE_SERVIDOR) {
    const salida = enZona(zona, `
      const { fijarZonaHoraria } = require('./src/config/zonaHoraria');
      const r = fijarZonaHoraria('America/Lima');
      console.log(r.efectiva + '|' + r.desfase);
    `);
    const [efectiva, desfase] = salida.split('|');
    assert.equal(efectiva, 'America/Lima', `no se impuso viniendo de ${zona}`);
    assert.equal(Number(desfase), -5, `desfase incorrecto viniendo de ${zona}`);
  }
});

test('una marca de las 22:00 no salta al día siguiente', () => {
  // El turno TARDE cierra a las 22:00 y el NOCHE abre a esa hora: en un proceso
  // en UTC ese instante ya cae en el día siguiente, y la marca se registra mal
  const codigo = `
    require('./src/config/zonaHoraria').fijarZonaHoraria('America/Lima');
    const { comoYMD } = require('./src/utils/fechas');
    console.log(comoYMD(new Date('2026-08-30T03:00:00.000Z')));
  `;
  for (const zona of ZONAS_DE_SERVIDOR) {
    assert.equal(enZona(zona, codigo), '2026-08-29',
      `la marca de las 22:00 se desplazó arrancando en ${zona}`);
  }
});

test('la zona del alojamiento no gana a la que declara la aplicación', () => {
  // El caso real: un servidor en la nube con TZ=UTC en su entorno. dotenv no
  // pisa una variable ya definida, así que si la zona se leyera de TZ sería el
  // alojamiento quien decidiera en qué día vive la planilla
  const codigo = `
    require('dotenv').config();
    require('./src/config/zonaHoraria').fijarZonaHoraria();
    const { comoYMD } = require('./src/utils/fechas');
    console.log(Intl.DateTimeFormat().resolvedOptions().timeZone
      + '|' + comoYMD(new Date('2026-08-30T03:00:00.000Z')));
  `;
  for (const zona of ZONAS_DE_SERVIDOR) {
    const [efectiva, dia] = enZona(zona, codigo).split('|');
    assert.equal(efectiva, 'America/Lima', `el alojamiento ${zona} impuso su zona`);
    assert.equal(dia, '2026-08-29', `la marca se desplazó en un servidor ${zona}`);
  }
});

test('ZONA_HORARIA sí permite cambiarla deliberadamente', () => {
  // Quien despliegue en otro país debe poder declararlo
  const salida = enZona('UTC', `
    require('./src/config/zonaHoraria').fijarZonaHoraria();
    console.log(Intl.DateTimeFormat().resolvedOptions().timeZone);
  `, { ZONA_HORARIA: 'America/Bogota' });
  assert.equal(salida, 'America/Bogota');
});

test('una fecha escrita como texto significa el mismo día en cualquier servidor', () => {
  const codigo = `
    require('./src/config/zonaHoraria').fijarZonaHoraria('America/Lima');
    const { aFechaLocal, comoYMD, comoTexto } = require('./src/utils/fechas');
    const f = aFechaLocal('2026-08-29');
    console.log(comoYMD(f) + '|' + comoTexto(f) + '|' + f.toISOString());
  `;
  const referencia = enZona('America/Lima', codigo);
  for (const zona of ZONAS_DE_SERVIDOR) {
    assert.equal(enZona(zona, codigo), referencia,
      `«2026-08-29» se interpretó distinto arrancando en ${zona}`);
  }
  assert.match(referencia, /^2026-08-29\|29\/08\/2026\|2026-08-29T05:00:00/);
});

test('el inicio y el fin del día son los mismos instantes en todo servidor', () => {
  const codigo = `
    require('./src/config/zonaHoraria').fijarZonaHoraria('America/Lima');
    const { inicioDelDia, finDelDia } = require('./src/utils/fechas');
    console.log(inicioDelDia('2026-08-29').toISOString() + '|' + finDelDia('2026-08-29').toISOString());
  `;
  const referencia = enZona('America/Lima', codigo);
  for (const zona of ZONAS_DE_SERVIDOR) {
    assert.equal(enZona(zona, codigo), referencia, `el día se delimitó distinto en ${zona}`);
  }
  // Medianoche en Lima son las 05:00 UTC
  assert.match(referencia, /^2026-08-29T05:00:00/);
});

test('el período de planilla abarca los mismos días en cualquier servidor', () => {
  const codigo = `
    require('./src/config/zonaHoraria').fijarZonaHoraria('America/Lima');
    const { rangoDelPeriodo } = require('./src/services/payroll');
    console.log(JSON.stringify(rangoDelPeriodo('2026-08')));
  `;
  const referencia = enZona('America/Lima', codigo);
  for (const zona of ZONAS_DE_SERVIDOR) {
    assert.equal(enZona(zona, codigo), referencia,
      `el período de agosto abarcó otros días en ${zona}`);
  }
});

test('una zona inexistente no tumba el arranque: avisa y usa la de casa', () => {
  const salida = enZona('UTC', `
    const { fijarZonaHoraria } = require('./src/config/zonaHoraria');
    console.log(fijarZonaHoraria('Marte/Olimpo').efectiva);
  `);
  assert.equal(salida, 'America/Lima');
});

test('reconoce si una zona existe antes de imponerla', () => {
  const { zonaValida } = require('../src/config/zonaHoraria');
  assert.equal(zonaValida('America/Lima'), true);
  assert.equal(zonaValida('UTC'), true);
  assert.equal(zonaValida('Marte/Olimpo'), false);
  assert.equal(zonaValida(''), false);
});

test('todo punto de entrada fija la zona antes de trabajar', () => {
  const sinFijar = [];
  const entradas = ['src/app.js'].concat(
    fs.readdirSync(path.join(RAIZ, 'scripts'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `scripts/${f}`)
  );

  for (const archivo of entradas) {
    const texto = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
    if (!texto.includes('zonaHoraria')) sinFijar.push(archivo);
  }

  assert.deepEqual(sinFijar, [],
    `estos puntos de entrada heredarían la zona del servidor:\n  ${sinFijar.join('\n  ')}`);
});
