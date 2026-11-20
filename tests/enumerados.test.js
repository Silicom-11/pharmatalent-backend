const test = require('node:test');
const assert = require('node:assert/strict');

const esq = require('../src/validators/esquemas');
const Vacacion = require('../src/models/Vacacion');
const Capacitacion = require('../src/models/Capacitacion');
const Requerimiento = require('../src/models/Requerimiento');
const Candidato = require('../src/models/Candidato');
const VisitaAuditoria = require('../src/models/VisitaAuditoria');

/**
 * Un validador que acepta valores que el modelo rechaza deja pasar peticiones
 * que fallan al guardar; uno que rechaza valores del modelo bloquea flujos
 * enteros. Las dos cosas pasaron: «Mis Vacaciones» no podía pedir un permiso y
 * ninguna capacitación BPA o DIGEMID se podía crear desde la pantalla.
 */
const casos = [
  ['vacacionPropia.tipo', esq.vacacionPropia.tipo, Vacacion],
  ['vacacionCrear.tipo', esq.vacacionCrear.tipo, Vacacion],
  ['capacitacionCrear.tipo', esq.capacitacionCrear.tipo, Capacitacion],
  ['capacitacionCrear.estado', esq.capacitacionCrear.estado, Capacitacion],
  ['requerimientoCrear.motivo', esq.requerimientoCrear.motivo, Requerimiento],
  ['candidatoEtapa.etapa', esq.candidatoEtapa.etapa, Candidato],
  ['candidatoCrear.tipoProfesional', esq.candidatoCrear.tipoProfesional, Candidato],
  ['auditoriaCrear.estado', esq.auditoriaCrear.estado, VisitaAuditoria],
];

for (const [nombre, regla, Modelo] of casos) {
  test(`${nombre} acepta exactamente los valores del modelo`, () => {
    const campo = nombre.split('.')[1];
    const delModelo = Modelo.schema.path(campo).enumValues;
    assert.deepEqual([...regla[1]].sort(), [...delModelo].sort());
  });
}
