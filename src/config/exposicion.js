const Zona = require('../models/Zona');
const Local = require('../models/Local');
const Empleado = require('../models/Empleado');

/**
 * Modo exposición.
 *
 * El sistema no cambia: este modo sólo decide cómo se entra y qué se ve en una
 * demostración.
 *
 *   MODO_EXPOSICION=completo   todo el sistema; una cuenta por rol, con un clic
 *   MODO_EXPOSICION=junin      Junín y cinco roles: el recorrido guiado corto
 *
 * Nunca funciona con NODE_ENV=production: el cambio de rol sin contraseña de
 * las cuentas de demostración existe sólo aquí.
 */

// El recorrido corto: el colaborador marca y pide vacaciones, su botica avala,
// su zona autoriza, RRHH paga
const CUENTAS_JUNIN = [
  { cuenta: 'tecnico.huancayo', papel: 'Colaborador de botica',
    hace: 'Marca en el terminal, consulta su horario y su asistencia, pide vacaciones y ve su boleta.' },
  { cuenta: 'admin.huancayo', papel: 'Administrador de Botica',
    hace: 'Publica los turnos de su botica con un QF en cada turno y avala las vacaciones de su equipo.' },
  { cuenta: 'zona.huancayo', papel: 'Jefe de Zona',
    hace: 'Autoriza las vacaciones que la botica ya avaló y vigila la cobertura de QF de su zona.' },
  { cuenta: 'gerente.rrhh', papel: 'Gerente de RRHH',
    hace: 'Ve todo Junín, aprueba la planilla del mes y registra su pago.' },
  // Fuera del recorrido: para lo que pidan además (crear empleados y cuentas…)
  { cuenta: 'admin', papel: 'Administrador del Sistema',
    hace: 'Ve el sistema completo: crea empleados y cuentas de acceso, y todo lo que no está en el recorrido.' },
];

// Todo el sistema: una cuenta de cada rol, con lo que hace y lo que crea
const CUENTAS_COMPLETO = [
  { nivel: 'Sede corporativa', cuenta: 'admin', papel: 'Administrador del Sistema',
    hace: 'Crea cuentas de acceso, emite la clave del terminal de cada local y revisa la bitácora.' },
  { nivel: 'Sede corporativa', cuenta: 'gerente.rrhh', papel: 'Gerente de RRHH',
    hace: 'Aprueba y paga la planilla, autoriza descansos de sede y CEDI, registra empleados, contratos y ceses.' },
  { nivel: 'Sede corporativa', cuenta: 'planillas', papel: 'Analista de Planillas',
    hace: 'Calcula la planilla del mes y revisa cada boleta. No la aprueba: eso es de la Gerencia.' },
  { nivel: 'Sede corporativa', cuenta: 'seleccion', papel: 'Analista de Selección',
    hace: 'Convoca los requerimientos aprobados, registra candidatos y los lleva por sus etapas hasta contratarlos.' },
  { nivel: 'Sede corporativa', cuenta: 'capacitacion', papel: 'Analista de Capacitación',
    hace: 'Programa capacitaciones (inducción, SST, BPA, DIGEMID) y controla su cumplimiento.' },
  { nivel: 'Sede corporativa', cuenta: 'bienestar', papel: 'Gestor de Bienestar Social',
    hace: 'Registra descansos médicos con su CITT y el subsidio de EsSalud.' },
  { nivel: 'Sede corporativa', cuenta: 'auditor', papel: 'Auditor de Calidad',
    hace: 'Registra visitas DIGEMID con sus hallazgos y mantiene el mapa de riesgo de las boticas.' },
  { nivel: 'Zona', cuenta: 'zona.huancayo', papel: 'Jefe de Zona',
    hace: 'Autoriza vacaciones que la botica avaló, aprueba requerimientos de personal y visa evaluaciones de su zona.' },
  { nivel: 'Centro de distribución', cuenta: 'jefe.cedi', papel: 'Jefe de CEDI',
    hace: 'Arma turnos y controla la asistencia del CEDI, avala descansos, evalúa y pide personal.' },
  { nivel: 'Centro de distribución', cuenta: 'rutas', papel: 'Coordinador de Rutas',
    hace: 'Programa los turnos de despacho y reparto del CEDI.' },
  { nivel: 'Centro de distribución', cuenta: 'operario.cedi', papel: 'Operario de Almacén',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'admin.huancayo', papel: 'Administrador de Botica',
    hace: 'Publica turnos con QF, avala vacaciones, registra marcas manuales, evalúa a su equipo y pide personal.' },
  { nivel: 'Botica', cuenta: 'qf.huancayo', papel: 'Químico Farmacéutico',
    hace: 'Responsable DIGEMID de su turno. Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'qf.asistente', papel: 'QF Asistente',
    hace: 'Cubre la presencia de QF cuando la titular no está. Autoservicio.' },
  { nivel: 'Botica', cuenta: 'tecnico.huancayo', papel: 'Técnico en Farmacia',
    hace: 'Marca en el terminal; ve su horario y sus marcas, pide vacaciones, ve su boleta y firma su evaluación.' },
  { nivel: 'Botica', cuenta: 'trainee', papel: 'Técnico en Entrenamiento',
    hace: 'Personal en inducción. Autoservicio y sus capacitaciones.' },
  { nivel: 'Botica', cuenta: 'cajero', papel: 'Cajero',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'dermoconsultora', papel: 'Dermoconsultora',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'almacen', papel: 'Auxiliar de Almacén',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'prevencionista', papel: 'Prevencionista',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
  { nivel: 'Botica', cuenta: 'motorizado', papel: 'Motorizado (delivery)',
    hace: 'Autoservicio: horario, marcas, vacaciones y boleta.' },
];

const DOMINIO = 'pharmatalent.pe';
/** La botica donde ocurre el recorrido guiado */
const LOCAL_TERMINAL = 'IKF-733';
const correoDe = (cuenta) => `${cuenta}@${DOMINIO}`;

/** 'completo', 'junin' o null (apagado) */
function modo() {
  if (process.env.NODE_ENV === 'production') return null;
  const v = String(process.env.MODO_EXPOSICION || '').trim().toLowerCase();
  if (v === 'completo' || v === 'todo') return 'completo';
  if (/^(1|si|sí|true|junin|junín)$/.test(v)) return 'junin';
  return null;
}
const activo = () => modo() !== null;

/**
 * Por el túnel (cloudflared) el sistema queda en internet: ahí el acceso por
 * rol sin contraseña exige el PIN de EXPOSICION_PIN. En la red local, no.
 * Cloudflare marca cada petición con cf-connecting-ip, y todo proxy con
 * x-forwarded-for; la red local llega directa, sin ninguna de las dos.
 */
function pinRequerido(req) {
  return Boolean(process.env.EXPOSICION_PIN)
    && Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
}

function pinCorrecto(pin) {
  const esperado = Buffer.from(String(process.env.EXPOSICION_PIN || ''));
  const dado = Buffer.from(String(pin || ''));
  return esperado.length > 0 && dado.length === esperado.length && require('node:crypto').timingSafeEqual(dado, esperado);
}
/** Sólo la variante corta reduce lo nacional a Junín */
const soloJunin = () => modo() === 'junin';
const cuentas = () => (modo() === 'completo' ? CUENTAS_COMPLETO : CUENTAS_JUNIN);

// Las boticas de Junín cambian sólo si se corre la carga de datos: un minuto basta
let cache = { hasta: 0, locales: null };
async function localesJunin() {
  if (cache.locales && Date.now() < cache.hasta) return cache.locales;
  const zonas = await Zona.find({ nombre: /^Jun/i }).select('_id').lean();
  const locales = await Local.find({ zona: { $in: zonas.map((z) => z._id) } }).select('_id').lean();
  cache = { hasta: Date.now() + 60000, locales: locales.map((l) => l._id) };
  return cache.locales;
}

async function plantillaJunin() {
  const locales = await localesJunin();
  return (await Empleado.find({ localActual: { $in: locales } }).select('_id').lean()).map((e) => e._id);
}

module.exports = { modo, activo, soloJunin, cuentas, pinRequerido, pinCorrecto, LOCAL_TERMINAL, correoDe, localesJunin, plantillaJunin };
