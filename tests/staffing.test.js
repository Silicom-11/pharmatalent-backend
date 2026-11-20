const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FORMATS, LEGAL, requiredRoster, shiftTypesOf, formatOf,
  substitutionsFor, weeklyStaffNeed,
} = require('../src/config/formats');
const { shiftRoleOf, coverableRoles, evaluateCoverage } = require('../src/services/staffing');

const botica = (formato, extra = {}) => ({ _id: 'x', tipo: 'BOTICA', formato, ...extra });
const persona = (rolPorDefecto, extra = {}) => ({
  cargoActual: { rolPorDefecto },
  tipoProfesional: 'TECNICO',
  ...extra,
});

// ─── Dotación por formato ────────────────────────────────────────────────────

test('el Químico Farmacéutico es obligatorio en todo formato de botica', () => {
  for (const codigo of Object.keys(FORMATS)) {
    if (FORMATS[codigo].esLogistico) continue;   // un almacén no dispensa
    for (const turno of FORMATS[codigo].shiftTypes) {
      const roster = requiredRoster(botica(codigo), turno);
      assert.ok(roster.QF >= 1, `${codigo} / ${turno} debe exigir al menos un QF`);
    }
  }
});

test('el centro de distribución no exige Químico Farmacéutico', () => {
  const almacen = { _id: 'c', tipo: 'CEDI', formato: 'CEDI' };
  for (const turno of FORMATS.CEDI.shiftTypes) {
    const roster = requiredRoster(almacen, turno);
    assert.equal(roster.QF, undefined, 'un almacén no dispensa medicamentos');
    assert.ok(roster.OPERARIO_CEDI >= 1, 'debe exigir operarios de almacén');
  }
});

test('un centro de tipo CEDI cae en el formato logístico aunque no lo declare', () => {
  assert.equal(formatOf({ tipo: 'CEDI' }).etiqueta, FORMATS.CEDI.etiqueta);
  assert.equal(formatOf({ tipo: 'BOTICA' }).etiqueta, FORMATS.ESTANDAR.etiqueta);
});

test('cada formato de botica exige más dotación conforme crece el local', () => {
  const total = (c) => Object.values(FORMATS[c].roster).reduce((a, n) => a + n, 0);
  assert.ok(total('EXPRESS') < total('ESTANDAR'));
  assert.ok(total('ESTANDAR') < total('FLAGSHIP'));
});

test('el formato 24 horas opera tres turnos con madrugada reducida', () => {
  const local = botica('H24');
  assert.deepEqual(shiftTypesOf(local), ['MANANA', 'TARDE', 'NOCHE']);

  const dia = requiredRoster(local, 'MANANA');
  const noche = requiredRoster(local, 'NOCHE');
  const suma = (r) => Object.values(r).reduce((a, n) => a + n, 0);

  assert.ok(suma(noche) < suma(dia), 'la madrugada opera con menos gente');
  assert.equal(noche.QF, 1, 'la madrugada nunca queda sin Director Técnico');
});

test('la dotación del local puede sobreescribir la del formato', () => {
  const local = botica('ESTANDAR', { dotacionRequerida: { qfPorTurno: 1, tecnicosPorTurno: 4 } });
  assert.equal(requiredRoster(local, 'MANANA').TECNICO, 4);
});

test('la madrugada nunca amplía su dotación por encima del formato', () => {
  const local = botica('H24', { dotacionRequerida: { qfPorTurno: 1, tecnicosPorTurno: 9 } });
  const noche = requiredRoster(local, 'NOCHE');
  assert.ok(noche.TECNICO <= FORMATS.H24.nightRoster.TECNICO);
});

test('el Administrador de Botica no forma parte de la dotación por turno', () => {
  // Es un puesto del local en horario comercial, no de cada turno
  for (const codigo of Object.keys(FORMATS)) {
    const roster = requiredRoster(botica(codigo), 'MANANA');
    assert.equal(roster.ADMIN_BOTICA, undefined);
  }
});

test('un formato desconocido cae en Estándar', () => {
  assert.equal(formatOf({ formato: 'INEXISTENTE' }).etiqueta, FORMATS.ESTANDAR.etiqueta);
});

// ─── Puesto de turno ─────────────────────────────────────────────────────────

test('el puesto de turno sale del cargo, no del tipo profesional', () => {
  assert.equal(shiftRoleOf(persona('MOTORIZADO', { tipoProfesional: 'OPERARIO' })), 'MOTORIZADO');
  assert.equal(shiftRoleOf(persona('DERMOCONSULTOR', { tipoProfesional: 'OPERARIO' })), 'DERMOCONSULTOR');
});

test('sin cargo asignado se recurre al tipo profesional', () => {
  assert.equal(shiftRoleOf({ tipoProfesional: 'QF' }), 'QF');
  assert.equal(shiftRoleOf({ tipoProfesional: 'TECNICO' }), 'TECNICO');
});

test('quien está en inducción cuenta como trainee, sea cual sea su cargo', () => {
  assert.equal(shiftRoleOf(persona('TECNICO', { esPracticante: true })), 'TRAINEE');
});

// ─── Polivalencia ────────────────────────────────────────────────────────────

test('el QF Asistente releva al Director Técnico en cualquier formato', () => {
  for (const codigo of Object.keys(FORMATS)) {
    const puede = coverableRoles(persona('QF_ASISTENTE'), FORMATS[codigo]);
    assert.ok(puede.includes('QF'), `en ${codigo} el asistente debe poder cubrir al titular`);
  }
});

test('el técnico atiende caja sólo donde el formato admite polivalencia', () => {
  assert.ok(coverableRoles(persona('TECNICO'), FORMATS.ESTANDAR).includes('CAJERO'));
  assert.ok(!coverableRoles(persona('TECNICO'), FORMATS.FLAGSHIP).includes('CAJERO'),
    'en Flagship cada puesto tiene titular propio');
});

test('el cajero no puede cubrir al Químico Farmacéutico en ningún formato', () => {
  for (const codigo of Object.keys(FORMATS)) {
    assert.ok(!coverableRoles(persona('CAJERO'), FORMATS[codigo]).includes('QF'));
  }
});

test('la tabla de sustituciones crece sólo en formatos flexibles', () => {
  const flexibles = Object.keys(substitutionsFor(FORMATS.ESTANDAR));
  const rigidos = Object.keys(substitutionsFor(FORMATS.FLAGSHIP));
  assert.ok(flexibles.length > rigidos.length);
  assert.ok(rigidos.includes('QF'), 'el relevo del Director Técnico es estructural');
});

// ─── Evaluación de cobertura ─────────────────────────────────────────────────

test('un turno sin Químico Farmacéutico es incumplimiento crítico', () => {
  const c = evaluateCoverage([{ rol: 'TECNICO' }, { rol: 'TECNICO' }], botica('ESTANDAR'), 'MANANA');
  assert.equal(c.severidad, 'CRITICA');
  assert.ok(c.hasLegalGap);
  assert.ok(!c.cumpleNormativa);
});

test('un turno completo no arroja incumplimientos', () => {
  const c = evaluateCoverage(
    [{ rol: 'QF' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }, { rol: 'CAJERO' }],
    botica('ESTANDAR'), 'MANANA'
  );
  assert.ok(c.cumpleNormativa);
  assert.equal(c.porcentajeCobertura, 100);
  assert.equal(c.conflictos.length, 0);
});

test('un técnico de sobra cubre la caja donde el formato lo permite', () => {
  const c = evaluateCoverage(
    [{ rol: 'QF' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }],
    botica('ESTANDAR'), 'MANANA'
  );
  assert.ok(c.cumpleNormativa, 'el tercer técnico asume la caja');
  assert.ok(c.sustitucionesUsadas > 0);
});

test('en Flagship los mismos números dejan puestos descubiertos', () => {
  const c = evaluateCoverage(
    [{ rol: 'QF' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }],
    botica('FLAGSHIP'), 'MANANA'
  );
  assert.ok(!c.cumpleNormativa);
  assert.equal(c.sustitucionesUsadas, 0, 'este formato no admite polivalencia');
  const descubiertos = c.conflictos.map((x) => x.rol);
  assert.ok(descubiertos.includes('CAJERO'));
});

test('el trainee no cubre dotación por sí solo y requiere supervisión', () => {
  const c = evaluateCoverage([{ rol: 'TRAINEE' }], botica('ESTANDAR'), 'MANANA');
  const motivos = c.conflictos.map((x) => x.hallazgo).join(' ');
  assert.match(motivos, /supervisión/i);
});

test('el formato limita cuántos trainees admite un turno', () => {
  const asignaciones = [{ rol: 'QF' }, { rol: 'TECNICO' }, { rol: 'TECNICO' }, { rol: 'CAJERO' },
    { rol: 'TRAINEE' }, { rol: 'TRAINEE' }];
  const c = evaluateCoverage(asignaciones, botica('ESTANDAR'), 'MANANA');
  const motivos = c.conflictos.map((x) => x.hallazgo).join(' ');
  assert.match(motivos, /trainee/i);
});

test('el turno vacío arroja cobertura cero', () => {
  const c = evaluateCoverage([], botica('EXPRESS'), 'MANANA');
  assert.equal(c.porcentajeCobertura, 0);
  assert.ok(c.hasLegalGap);
});

// ─── Dotación semanal mínima ─────────────────────────────────────────────────

test('la dotación semanal respeta la jornada máxima y el descanso', () => {
  const turnosPorPersona = Math.min(
    LEGAL.maxConsecutiveDays,
    Math.floor(LEGAL.maxWeeklyHours / LEGAL.maxDailyHours)
  );
  const need = weeklyStaffNeed(botica('ESTANDAR'));
  // Dos turnos diarios durante siete días exigen catorce coberturas de QF
  assert.equal(need.QF.shiftsPerWeek, 14);
  assert.equal(need.QF.minStaff, Math.ceil(14 / turnosPorPersona));
});

test('un local de 24 horas necesita más personal que uno estándar', () => {
  const total = (c) => Object.values(weeklyStaffNeed(botica(c))).reduce((a, n) => a + n.minStaff, 0);
  assert.ok(total('H24') > total('ESTANDAR'));
  assert.ok(total('ESTANDAR') > total('EXPRESS'));
});

test('los turnos generados llevan calculada la presencia de QF (se insertan en lote)', () => {
  const { generateWeek } = require('../src/services/staffing');
  const { presenciaQF } = require('../src/models/Turno');
  const local = { _id: 'L1', formato: 'ESTANDAR', tipo: 'BOTICA' };
  const persona = (id, rol) => ({ _id: id, estado: 'ACTIVO', cargoActual: { rolPorDefecto: rol }, tipoProfesional: rol === 'QF' ? 'QF' : 'TECNICO' });
  const staff = [persona('q1', 'QF'), persona('q2', 'QF'), persona('q3', 'QF'), ...[1, 2, 3, 4, 5, 6].map((n) => persona('t' + n, 'TECNICO'))];
  const turnos = generateWeek(local, staff, new Date(2026, 9, 4));
  assert.ok(turnos.length > 0);
  for (const t of turnos) {
    // insertMany no corre el hook: el valor tiene que venir del motor y coincidir con la regla del modelo
    assert.deepEqual({ conteoQF: t.conteoQF, tieneQF: t.tieneQF }, presenciaQF(t.asignaciones));
  }
  assert.ok(turnos.some((t) => t.tieneQF), 'con tres QF algún turno tiene que tener QF');
});
