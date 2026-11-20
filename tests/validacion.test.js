const test = require('node:test');
const assert = require('node:assert/strict');
const { aplicar, leerSpec, revisar } = require('../src/middleware/validar');

const ID = '6a93956eb626388a57da8e81';

// ─── Lo que no se declara, no pasa ───────────────────────────────────────────

test('descarta los campos que el esquema no declara', () => {
  // La puerta de atrás real: cambiar el estado de una boleta por el PUT genérico
  const { datos } = aplicar(
    { notas: 'Ajuste manual', estado: 'PAGADO', netoAPagar: 999999 },
    { notas: 'texto:0..500' }
  );
  assert.deepEqual(datos, { notas: 'Ajuste manual' });
  assert.equal(datos.estado, undefined);
  assert.equal(datos.netoAPagar, undefined);
});

test('un cuerpo entero de campos no declarados queda vacío', () => {
  const { datos, error } = aplicar({ rol: 'ADMIN', sueldo: 1e9 }, { notas: 'texto' });
  assert.equal(error, undefined);
  assert.deepEqual(datos, {});
});

// ─── Obligatorios y opcionales ───────────────────────────────────────────────

test('exige lo marcado con «!» y nombra el campo que falta', () => {
  const { error } = aplicar({}, { empleado: 'id!' });
  assert.match(error, /Falta «empleado»/);
});

test('un opcional ausente simplemente no aparece', () => {
  const { datos, error } = aplicar({}, { notas: 'texto:0..100' });
  assert.equal(error, undefined);
  assert.equal('notas' in datos, false);
});

test('cadena vacía cuenta como ausente', () => {
  assert.match(aplicar({ empleado: '' }, { empleado: 'id!' }).error, /Falta/);
  assert.equal('notas' in aplicar({ notas: '' }, { notas: 'texto' }).datos, false);
});

// ─── Identificadores ─────────────────────────────────────────────────────────

test('rechaza identificadores mal formados', () => {
  for (const malo of ['abc', '123', 'null', '../../etc/passwd', ID.slice(0, 23)]) {
    assert.match(aplicar({ empleado: malo }, { empleado: 'id!' }).error, /identificador/,
      `debio rechazar ${malo}`);
  }
});

test('convierte el identificador válido a ObjectId', () => {
  const { datos } = aplicar({ empleado: ID }, { empleado: 'id!' });
  assert.equal(String(datos.empleado), ID);
  assert.equal(datos.empleado.constructor.name, 'ObjectId');
});

// ─── Texto ───────────────────────────────────────────────────────────────────

test('recorta espacios y respeta los límites de longitud', () => {
  assert.equal(aplicar({ n: '  Ana  ' }, { n: 'texto' }).datos.n, 'Ana');
  assert.match(aplicar({ n: 'ab' }, { n: 'texto:5..50' }).error, /al menos 5/);
  assert.match(aplicar({ n: 'x'.repeat(60) }, { n: 'texto:0..50' }).error, /superar 50/);
});

test('un texto sin tope declarado no admite una novela', () => {
  assert.match(aplicar({ n: 'x'.repeat(5000) }, { n: 'texto' }).error, /superar/);
});

// ─── Números e importes ──────────────────────────────────────────────────────

test('valida enteros y sus rangos', () => {
  assert.equal(aplicar({ q: '5' }, { q: 'entero:1..10' }).datos.q, 5);
  assert.match(aplicar({ q: 2.5 }, { q: 'entero' }).error, /entero/);
  assert.match(aplicar({ q: 99 }, { q: 'entero:1..10' }).error, /entre 1 y 10/);
});

test('un importe no puede ser negativo y se redondea a céntimos', () => {
  assert.equal(aplicar({ s: 1234.567 }, { s: 'monto' }).datos.s, 1234.57);
  assert.match(aplicar({ s: -1 }, { s: 'monto' }).error, /negativo/);
  assert.match(aplicar({ s: 'mucho' }, { s: 'monto' }).error, /importe/);
});

// ─── Fechas ──────────────────────────────────────────────────────────────────

test('la fecha se ancla al día local y no retrocede', () => {
  const { datos } = aplicar({ f: '2026-08-29' }, { f: 'fecha!' });
  assert.equal(datos.f.getDate(), 29);
  assert.equal(datos.f.getMonth(), 7);
});

test('la fecha de ingreso no puede ser futura', () => {
  // Defecto hallado en la revisión de pruebas: se registró a alguien ACTIVO con
  // ingreso el 12/12/2026
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.match(aplicar({ f: iso(manana) }, { f: 'fechaPasada!' }).error, /futura/);
  assert.equal(aplicar({ f: iso(new Date()) }, { f: 'fechaPasada!' }).error, undefined);
  assert.equal(aplicar({ f: '2026-08-29' }, { f: 'fechaPasada!' }).datos.f.getDate(), 29);
  assert.match(aplicar({ f: '2026-02-30' }, { f: 'fechaPasada!' }).error, /fecha real/);
});

test('rechaza fechas inexistentes y formatos ajenos', () => {
  assert.match(aplicar({ f: '2026-02-30' }, { f: 'fecha' }).error, /fecha real/);
  assert.match(aplicar({ f: '29/08/2026' }, { f: 'fecha' }).error, /AAAA-MM-DD/);
  assert.match(aplicar({ f: '2026-13-01' }, { f: 'fecha' }).error, /fecha real/);
});

test('valida el período de planilla', () => {
  assert.equal(aplicar({ p: '2026-08' }, { p: 'periodo!' }).datos.p, '2026-08');
  assert.match(aplicar({ p: '2026-13' }, { p: 'periodo' }).error, /AAAA-MM/);
  assert.match(aplicar({ p: '2026-8' }, { p: 'periodo' }).error, /AAAA-MM/);
});

test('valida la hora de un turno', () => {
  assert.equal(aplicar({ h: '08:00' }, { h: 'hora!' }).datos.h, '08:00');
  assert.equal(aplicar({ h: '23:59' }, { h: 'hora' }).datos.h, '23:59');
  assert.match(aplicar({ h: '24:00' }, { h: 'hora' }).error, /HH:MM/);
  assert.match(aplicar({ h: '8:00' }, { h: 'hora' }).error, /HH:MM/);
});

// ─── Documentos peruanos ─────────────────────────────────────────────────────

test('valida DNI, RUC y celular con las reglas del país', () => {
  assert.equal(aplicar({ d: '45123678' }, { d: 'dni!' }).datos.d, '45123678');
  assert.match(aplicar({ d: '1234567' }, { d: 'dni' }).error, /8 dígitos/);

  assert.equal(aplicar({ r: '20100128056' }, { r: 'ruc!' }).datos.r, '20100128056');
  assert.match(aplicar({ r: '30100128056' }, { r: 'ruc' }).error, /RUC/);

  assert.equal(aplicar({ c: '964 888 076' }, { c: 'celular' }).datos.c, '964888076');
  assert.match(aplicar({ c: '164888076' }, { c: 'celular' }).error, /empiece en 9/);
});

test('normaliza el correo a minúsculas', () => {
  assert.equal(aplicar({ e: '  Ana.Perez@InRetail.PE ' }, { e: 'correo!' }).datos.e, 'ana.perez@inretail.pe');
  assert.match(aplicar({ e: 'sin arroba' }, { e: 'correo' }).error, /correo válido/);
});

// ─── Enumerados y listas ─────────────────────────────────────────────────────

test('el enumerado sólo admite los valores declarados y los enumera al fallar', () => {
  const esquema = { t: ['enum!', ['INDEFINIDO', 'PLAZO_FIJO']] };
  assert.equal(aplicar({ t: 'PLAZO_FIJO' }, esquema).datos.t, 'PLAZO_FIJO');
  const { error } = aplicar({ t: 'INVENTADO' }, esquema);
  assert.match(error, /INDEFINIDO, PLAZO_FIJO/);
});

test('la lista valida cada elemento y acota su tamaño', () => {
  const { datos } = aplicar({ ids: [ID, ID] }, { ids: ['lista!:1..10', 'id'] });
  assert.equal(datos.ids.length, 2);
  assert.match(aplicar({ ids: [ID, 'basura'] }, { ids: ['lista', 'id'] }).error, /ids\[1\]/);
  assert.match(aplicar({ ids: [] }, { ids: ['lista!:1..10', 'id'] }).error, /al menos 1/);
  assert.match(aplicar({ ids: 'no es lista' }, { ids: ['lista', 'id'] }).error, /debe ser una lista/);
});

test('una lista enorme no pasa aunque cada elemento sea válido', () => {
  const muchos = Array(600).fill(ID);
  assert.match(aplicar({ ids: muchos }, { ids: ['lista', 'id'] }).error, /más de 500/);
});

// ─── Objetos anidados ────────────────────────────────────────────────────────

test('valida en profundidad y descarta lo no declarado dentro del objeto', () => {
  const { datos } = aplicar(
    { direccion: { distrito: 'Huancayo', secreto: 'x' } },
    { direccion: ['objeto', { distrito: 'texto!:1..80', ciudad: 'texto:0..80' }] }
  );
  assert.deepEqual(datos.direccion, { distrito: 'Huancayo' });
});

test('el error del objeto anidado dice qué campo falla', () => {
  const { error } = aplicar(
    { direccion: {} },
    { direccion: ['objeto', { distrito: 'texto!:1..80' }] }
  );
  assert.match(error, /direccion\.distrito/);
});

// ─── Booleanos y forma del esquema ───────────────────────────────────────────

test('acepta booleanos escritos como texto', () => {
  assert.equal(aplicar({ b: 'true' }, { b: 'booleano' }).datos.b, true);
  assert.equal(aplicar({ b: false }, { b: 'booleano' }).datos.b, false);
  assert.match(aplicar({ b: 'quizá' }, { b: 'booleano' }).error, /verdadero o falso/);
});

test('una especificación mal escrita se detecta al arrancar, no en producción', () => {
  assert.throws(() => leerSpec('inventado!!'), /no reconocida/);
  assert.throws(() => revisar('x', 'v', { tipo: 'marciano' }), /desconocido/);
});

test('no se rompe con cuerpos ausentes o que no son objetos', () => {
  assert.deepEqual(aplicar(undefined, { n: 'texto' }).datos, {});
  assert.deepEqual(aplicar('cadena suelta', { n: 'texto' }).datos, {});
  assert.match(aplicar(null, { n: 'texto!' }).error, /Falta/);
});

// ─── Lo que mandan las pantallas tiene que pasar ─────────────────────────────
// El validador de Bienestar descartaba `tipo` y el de Auditoría esperaba otra
// forma: ninguno de los dos formularios podía guardar nada.
const esq = require('../src/validators/esquemas');

test('el formulario de descanso médico pasa con su tipo', () => {
  const { datos, error } = aplicar({
    empleado: ID, tipo: 'ENFERMEDAD_COMUN', diagnostico: 'Faringitis', centroMedico: 'EsSalud',
    nombreMedico: 'Dra. Pérez', cmpMedico: '12345', fechaInicio: '2026-11-10', fechaFin: '2026-11-12',
  }, esq.descansoMedicoCrear);
  assert.equal(error, undefined);
  assert.equal(datos.tipo, 'ENFERMEDAD_COMUN');
  assert.equal(datos.centroMedico, 'EsSalud');
});

test('el formulario de auditoría pasa con sus hallazgos', () => {
  const { datos, error } = aplicar({
    local: ID, fechaVisita: '2026-11-06', directorTecnicoPresente: true, resumen: 'Visita inopinada',
    hallazgos: [{ categoria: 'CADENA_FRIO', severidad: 'MENOR', descripcion: 'Registro de temperatura incompleto', accionCorrectiva: '', fechaVencimiento: '' }],
  }, esq.auditoriaCrear);
  assert.equal(error, undefined);
  assert.equal(datos.hallazgos[0].severidad, 'MENOR');
  assert.equal(datos.directorTecnicoPresente, true);
});
