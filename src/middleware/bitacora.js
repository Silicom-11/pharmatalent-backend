const Bitacora = require('../models/Bitacora');

/**
 * Registro automático de cambios.
 *
 * Se engancha a la respuesta en lugar de repartir llamadas por las 57 rutas de
 * escritura: así ninguna queda fuera por olvido, que es exactamente como se
 * pierden las bitácoras. Sólo anota lo que efectivamente cambió algo, es decir
 * métodos de escritura que terminaron bien.
 */

/**
 * Campos que nunca deben quedar escritos en la bitácora.
 *
 * Se conservan también los nombres antiguos en inglés. No es descuido: un
 * cliente sin actualizar, una integración externa o una petición guardada de
 * antes de la traducción pueden seguir enviando `contrasena`, y si ese nombre
 * desaparece de la lista la contraseña se escribe en claro en la bitácora
 * —que es justo el registro que no se puede borrar—.
 */
const CAMPOS_OCULTOS = [
  'contrasena', 'nuevaContrasena', 'contrasenaActual', 'contrasenaTemporal',
  'token', 'cuentaBancaria', 'cuspp',
  // Nombres anteriores a la traducción. Van entre comillas y no se tocan:
  // son datos, no identificadores de este código.
  'password', 'newPassword', 'currentPassword', 'bankAccount',
];

/** Módulos cuyo contenido es remuneración o salud */
const MODULOS_SENSIBLES = ['payroll', 'welfare', 'contracts', 'users'];

const VERBOS = {
  POST: 'CREAR',
  PUT: 'MODIFICAR',
  PATCH: 'MODIFICAR',
  DELETE: 'ELIMINAR',
};

/**
 * Sufijos de ruta que describen mejor la operación que el verbo HTTP.
 * `/vacations/:id/approve` es una aprobación, no una modificación cualquiera.
 */
const ACCIONES_POR_SUFIJO = [
  [/\/approve$|\/aprobar$/, 'APROBAR'],
  [/\/reject$|\/rechazar$/, 'RECHAZAR'],
  [/\/publish$|\/publicar$/, 'PUBLICAR'],
  [/\/cancel$|\/anular$/, 'ANULAR'],
  [/\/renovar$|\/renewal$/, 'RENOVAR'],
  [/\/cerrar$|\/close$/, 'CERRAR'],
  [/\/reset-password$/, 'RESTABLECER_CLAVE'],
  [/\/desbloquear$/, 'DESBLOQUEAR'],
  [/\/estado$/, 'CAMBIAR_ESTADO'],
  [/\/role$/, 'CAMBIAR_ROL'],
  [/\/clock-in$|\/clock-out$/, 'MARCAR'],
  [/\/hire$|\/contratar$/, 'CONTRATAR'],
  [/\/calcular$|\/calculate$/, 'CALCULAR'],
];

/** Nombre de la cosa y su género, para que la frase concuerde en castellano */
const ETIQUETAS = {
  employees: ['empleado', 'm'], contracts: ['contrato', 'm'], payroll: ['planilla', 'f'],
  vacations: ['descanso', 'm'], schedules: ['turno', 'm'], attendance: ['asistencia', 'f'],
  evaluations: ['evaluación', 'f'], training: ['capacitación', 'f'], users: ['cuenta', 'f'],
  requisitions: ['requerimiento', 'm'], recruitment: ['candidato', 'm'],
  welfare: ['caso de bienestar', 'm'], audits: ['visita de auditoría', 'f'],
  locations: ['centro de trabajo', 'm'], positions: ['cargo', 'm'], zones: ['zona', 'f'],
  me: ['dato propio', 'm'], notifications: ['notificación', 'f'], bitacora: ['entrada', 'f'],
};

/** Copia el cuerpo sin lo que no debe registrarse */
function limpiar(valor, profundidad = 0) {
  if (valor === null || typeof valor !== 'object' || profundidad > 3) return valor;
  if (Array.isArray(valor)) return valor.slice(0, 20).map((v) => limpiar(v, profundidad + 1));

  const salida = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (CAMPOS_OCULTOS.includes(clave)) {
      salida[clave] = '«oculto»';
    } else if (typeof v === 'string' && v.length > 500) {
      salida[clave] = `${v.slice(0, 500)}… (${v.length} caracteres)`;
    } else {
      salida[clave] = limpiar(v, profundidad + 1);
    }
  }
  return salida;
}

function moduloDeRuta(ruta) {
  const partes = ruta.split('/').filter(Boolean);   // ['api','payroll','123','aprobar']
  return partes[0] === 'api' ? partes[1] : partes[0];
}

function accionDeRuta(metodo, ruta) {
  const especifica = ACCIONES_POR_SUFIJO.find(([patron]) => patron.test(ruta));
  return especifica ? especifica[1] : (VERBOS[metodo] || metodo);
}

/** Frase legible: «Aprobó un descanso» en vez de «PUT /api/vacations/:id/approve» */
function describir(accion, modulo, cuerpo) {
  const [cosa, genero] = ETIQUETAS[modulo] || [modulo, 'm'];
  const femenino = genero === 'f';
  const un = femenino ? 'una' : 'un';
  const nuevo = femenino ? 'nueva' : 'nuevo';

  const frases = {
    CREAR: `Registró ${un} ${nuevo} ${cosa}`,
    MODIFICAR: `Modificó ${un} ${cosa}`,
    ELIMINAR: `Eliminó ${un} ${cosa}`,
    APROBAR: `Aprobó ${un} ${cosa}`,
    RECHAZAR: `Rechazó ${un} ${cosa}`,
    PUBLICAR: `Publicó ${un} ${cosa}`,
    ANULAR: `Anuló ${un} ${cosa}`,
    RENOVAR: `Resolvió la renovación de ${un} ${cosa}`,
    CERRAR: `Cerró ${un} ${cosa}`,
    RESTABLECER_CLAVE: 'Restableció la contraseña de una cuenta',
    DESBLOQUEAR: 'Desbloqueó una cuenta',
    CAMBIAR_ESTADO: `Cambió el estado de ${un} ${cosa}`,
    CAMBIAR_ROL: `Cambió el rol de una cuenta${cuerpo?.rol ? ` a ${cuerpo.rol}` : ''}`,
    MARCAR: 'Registró una marca de asistencia',
    CONTRATAR: 'Incorporó a un candidato como empleado',
    CALCULAR: `Calculó ${femenino ? 'la' : 'el'} ${cosa}${cuerpo?.periodo ? ` del período ${cuerpo.periodo}` : ''}`,
  };
  return frases[accion] || `${accion} sobre ${cosa}`;
}

/** Busca el identificador de la entidad afectada en la ruta o en la respuesta */
function identificarEntidad(req, cuerpoRespuesta) {
  if (req.params?.id && /^[0-9a-fA-F]{24}$/.test(req.params.id)) return req.params.id;
  const candidato = cuerpoRespuesta?._id
    || cuerpoRespuesta?.data?._id
    || cuerpoRespuesta?.cuenta?._id;
  return candidato && /^[0-9a-fA-F]{24}$/.test(String(candidato)) ? candidato : undefined;
}

function bitacora(req, res, next) {
  // Las lecturas no cambian nada: registrarlas sólo enterraría lo importante
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const jsonOriginal = res.json.bind(res);

  res.json = (cuerpo) => {
    // Se responde primero: la bitácora nunca debe demorar ni tumbar la operación
    const resultado = jsonOriginal(cuerpo);

    if (res.statusCode >= 200 && res.statusCode < 300 && req.usuario) {
      const modulo = moduloDeRuta(req.originalUrl.split('?')[0]);
      const accion = accionDeRuta(req.method, req.originalUrl.split('?')[0]);

      Bitacora.create({
        actor: req.usuario._id,
        actorCorreo: req.usuario.correo,
        actorRol: req.usuario.rol,
        modulo,
        accion,
        descripcion: describir(accion, modulo, req.body),
        entidad: modulo,
        entidadId: identificarEntidad(req, cuerpo),
        afectado: req.body?.employeeId || req.body?.empleado || cuerpo?.empleado?._id || undefined,
        despues: limpiar(req.body),
        metodo: req.method,
        ruta: req.originalUrl.split('?')[0],
        estado: res.statusCode,
        ip: req.ip,
        sensible: MODULOS_SENSIBLES.includes(modulo),
      }).catch((err) => {
        // Si la bitácora falla se avisa por consola, pero no se pierde la operación
        console.error('[bitácora] no se pudo registrar:', err.message);
      });
    }

    return resultado;
  };

  next();
}

module.exports = bitacora;
module.exports.limpiar = limpiar;
module.exports.accionDeRuta = accionDeRuta;
module.exports.moduloDeRuta = moduloDeRuta;
module.exports.describir = describir;
module.exports.CAMPOS_OCULTOS = CAMPOS_OCULTOS;
