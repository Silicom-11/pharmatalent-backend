const Usuario = require('../models/Usuario');
const Empleado = require('../models/Empleado');
const Local = require('../models/Local');

/**
 * Quién autoriza el descanso de quién.
 *
 * Antes la cadena estaba implícita en los permisos: avalar exigía `vacations:
 * write` y autorizar `vacations: approve`. Pero `write` lo tenía todo el
 * personal —para poder pedir sus propias vacaciones—, de modo que un técnico
 * podía avalar la solicitud de cualquiera, incluida la suya; y un Jefe de Zona
 * podía autorizar la de una botica de otra zona. El permiso dice qué clase de
 * acción se puede hacer; quién decide sobre quién lo dice la estructura.
 *
 * La cadena se fija al crear la solicitud y depende de dónde trabaja quien pide:
 *
 *   Personal de botica          Administrador de su botica → Jefe de su zona
 *   Personal de botica Express  Jefe de su zona (no hay administrador que avale)
 *   Administrador de Botica     Jefe de su zona
 *   Personal de CEDI            Jefe de CEDI → Gerencia de RRHH
 *   Jefe de CEDI, zonal o sede  Gerencia de RRHH
 *   Gerencia de RRHH            Dirección (Administrador del Sistema)
 *
 * La Gerencia de RRHH y la Dirección pueden actuar en cualquier paso que no sea
 * el suyo propio: si el administrador de un local está de licencia, alguien
 * tiene que poder destrabar la solicitud. Queda anotado quién lo hizo.
 *
 * Nadie decide sobre su propia solicitud, en ningún paso.
 */

const PASOS = {
  LOCAL: { etiqueta: 'Aval del centro de trabajo', roles: ['ADMIN_BOTICA', 'JEFE_LOCAL', 'JEFE_CEDI'] },
  ZONAL: { etiqueta: 'Autorización zonal', roles: ['JEFE_ZONA'] },
  RRHH: { etiqueta: 'Autorización de Recursos Humanos', roles: ['GERENTE_RRHH'] },
  DIRECCION: { etiqueta: 'Autorización de Dirección', roles: ['ADMIN'] },
};

/** Quienes pueden destrabar un paso ajeno */
const SUPLENTES = ['GERENTE_RRHH', 'ADMIN'];

const ADMIN_LOCAL = ['ADMIN_BOTICA', 'JEFE_LOCAL'];

/** Rol, local y zona de un empleado: lo necesario para resolver su cadena */
async function contextoDe(empleadoId) {
  const empleado = await Empleado.findById(empleadoId)
    .select('nombres apellidos localActual zona')
    .populate('localActual', 'tipo zona nombre responsable')
    .lean();
  if (!empleado) return null;
  const cuenta = await Usuario.findOne({ empleado: empleadoId, activo: true }).select('rol').lean();
  const localId = empleado.localActual?._id || null;

  // ¿Hay en su centro alguien que pueda avalar? Las boticas Express no tienen
  // Administrador —el QF asume la gestión—, y sin este dato la solicitud de su
  // personal esperaba un aval que nadie podía dar
  let jefaturaLocal = false;
  if (localId) {
    const colegas = await Empleado.find({ localActual: localId, _id: { $ne: empleadoId } }).select('_id').lean();
    jefaturaLocal = !!(await Usuario.exists({
      empleado: { $in: colegas.map((c) => c._id) },
      rol: { $in: PASOS.LOCAL.roles },
      activo: true,
    }));
  }

  return {
    empleado,
    rol: cuenta?.rol || null,
    localId,
    tipoLocal: empleado.localActual?.tipo || null,
    zonaId: empleado.localActual?.zona || empleado.zona || null,
    jefaturaLocal,
  };
}

function cadenaDe({ rol, tipoLocal, jefaturaLocal = true }) {
  if (rol === 'GERENTE_RRHH') return ['DIRECCION'];
  if (rol === 'ADMIN') return ['RRHH'];
  if (ADMIN_LOCAL.includes(rol)) return ['ZONAL'];
  if (rol === 'JEFE_CEDI') return ['RRHH'];
  if (tipoLocal === 'BOTICA') return jefaturaLocal ? ['LOCAL', 'ZONAL'] : ['ZONAL'];
  if (tipoLocal === 'CEDI') return jefaturaLocal ? ['LOCAL', 'RRHH'] : ['RRHH'];
  return ['RRHH'];
}

/** Cadena guardada en la solicitud; las anteriores a esta regla la calculan */
async function cadenaDeSolicitud(vacacion) {
  if (vacacion.cadena?.length) return vacacion.cadena;
  const ctx = await contextoDe(vacacion.empleado?._id || vacacion.empleado);
  return ctx ? cadenaDe(ctx) : ['RRHH'];
}

/** El primer paso de la cadena que todavía no tiene una aprobación registrada */
function pasoPendiente(cadena, vacacion) {
  if (!['PENDIENTE', 'APROBADO_LOCAL'].includes(vacacion.estado)) return null;
  const hechos = new Set((vacacion.aprobaciones || [])
    .filter((a) => a.decision === 'APROBADO')
    .map((a) => a.paso));
  return cadena.find((p) => !hechos.has(p)) || null;
}

/**
 * ¿Puede este usuario decidir en este paso de esta solicitud?
 * Devuelve { ok, motivo } para que la ruta pueda explicar el rechazo.
 */
async function puedeActuar(usuario, paso, vacacion, ctx = null) {
  const solicitante = ctx || await contextoDe(vacacion.empleado?._id || vacacion.empleado);
  if (!solicitante) return { ok: false, motivo: 'El legajo de quien solicita ya no existe' };

  if (usuario.empleado && String(usuario.empleado) === String(solicitante.empleado._id)) {
    return { ok: false, motivo: 'Nadie puede decidir sobre su propia solicitud' };
  }

  const def = PASOS[paso];
  if (!def) return { ok: false, motivo: 'La solicitud no tiene pasos pendientes' };

  // Suplencia: RRHH y Dirección destraban pasos ajenos, salvo el que les toca a ellos mismos
  if (SUPLENTES.includes(usuario.rol) && !def.roles.includes(usuario.rol)) {
    if (paso === 'DIRECCION' && usuario.rol !== 'ADMIN') {
      return { ok: false, motivo: 'La solicitud de la Gerencia de RRHH la autoriza la Dirección' };
    }
    return { ok: true, suplencia: true };
  }

  if (!def.roles.includes(usuario.rol)) {
    return { ok: false, motivo: `Este paso corresponde a: ${def.etiqueta}` };
  }

  if (paso === 'LOCAL' || paso === 'ZONAL') {
    const yo = await Empleado.findById(usuario.empleado)
      .select('localActual zona').populate('localActual', 'zona').lean();
    if (paso === 'LOCAL' && String(yo?.localActual?._id) !== String(solicitante.localId)) {
      return { ok: false, motivo: 'Sólo la jefatura del mismo centro de trabajo puede avalarla' };
    }
    if (paso === 'ZONAL') {
      const miZona = yo?.zona || yo?.localActual?.zona;
      if (!miZona || String(miZona) !== String(solicitante.zonaId)) {
        return { ok: false, motivo: 'La solicitud es de un local fuera de su zona' };
      }
    }
  }
  return { ok: true };
}

/** Cuentas que deben enterarse de que un paso espera decisión */
async function destinatariosDe(paso, ctx) {
  const def = PASOS[paso];
  if (!def) return [];
  const filtro = { rol: { $in: def.roles }, activo: true };
  let cuentas = await Usuario.find(filtro).populate({
    path: 'empleado', select: 'localActual zona', populate: { path: 'localActual', select: 'zona' },
  }).lean();

  if (paso === 'LOCAL') {
    cuentas = cuentas.filter((u) => String(u.empleado?.localActual?._id) === String(ctx.localId));
  } else if (paso === 'ZONAL') {
    cuentas = cuentas.filter((u) => String(u.empleado?.zona || u.empleado?.localActual?.zona) === String(ctx.zonaId));
  }
  // Nadie se notifica a sí mismo
  cuentas = cuentas.filter((u) => String(u.empleado?._id) !== String(ctx.empleado._id));

  // Si el paso no tiene a nadie —un local sin administrador, una zona sin jefe—
  // la solicitud no se queda huérfana: llega a Recursos Humanos
  if (!cuentas.length && paso !== 'RRHH' && paso !== 'DIRECCION') {
    return destinatariosDe('RRHH', ctx);
  }
  return cuentas.map((u) => u._id);
}

module.exports = {
  PASOS, SUPLENTES, contextoDe, cadenaDe, cadenaDeSolicitud, pasoPendiente, puedeActuar, destinatariosDe,
};
