const router = require('express').Router();
const Usuario = require('../models/Usuario');
const Local = require('../models/Local');
const Turno = require('../models/Turno');
const Asistencia = require('../models/Asistencia');
const Empleado = require('../models/Empleado');
const { inicioDelDia, DIA } = require('../services/marcacion');
const exposicion = require('../config/exposicion');
const { validarCuerpo } = require('../middleware/validar');
const esq = require('../validators/esquemas');

/**
 * Modo exposición (ver config/exposicion.js).
 *
 * GET  /api/exposicion           si está activo y con qué cuentas
 * POST /api/exposicion/ingresar  entra como una de esas cuentas, sin contraseña
 *
 * Fuera del modo exposición ambas responden como si no existieran.
 */
/**
 * A quién marcar hoy en el terminal de la botica de la exposición, según los
 * turnos y las marcas de este momento: los DNI de la guía no envejecen.
 */
async function sugerenciasTerminal() {
  const local = await Local.findOne({ codigo: exposicion.LOCAL_TERMINAL }).select('_id nombre codigo').lean();
  if (!local) return null;
  const hoy = inicioDelDia();
  const turnos = await Turno.find({ local: local._id, fecha: { $gte: hoy, $lt: new Date(hoy.getTime() + DIA) } })
    .select('tipoTurno horaInicio horaFin asignaciones').lean();
  const turnoDe = new Map();
  for (const t of turnos) for (const a of t.asignaciones) turnoDe.set(String(a.empleado), `${t.horaInicio}–${t.horaFin}`);
  const ids = [...turnoDe.keys()];
  const marcas = new Map((await Asistencia.find({ empleado: { $in: ids }, fecha: { $gte: hoy, $lt: new Date(hoy.getTime() + DIA) } })
    .select('empleado marcaEntrada marcaSalida').lean()).map((a) => [String(a.empleado), a]));
  const personas = await Empleado.find({ _id: { $in: ids } }).select('dni nombres apellidos').sort({ apellidos: 1 }).lean();
  const ficha = (e) => e && { dni: e.dni, nombre: `${e.nombres} ${e.apellidos}`, turno: turnoDe.get(String(e._id)) || null };
  const entrada = personas.find((e) => !marcas.get(String(e._id))?.marcaEntrada);
  const salida = personas.find((e) => marcas.get(String(e._id))?.marcaEntrada && !marcas.get(String(e._id))?.marcaSalida);
  const libre = await Empleado.findOne({ localActual: local._id, estado: 'ACTIVO', _id: { $nin: ids } }).select('dni nombres apellidos').lean();
  return { codigo: local.codigo, local: local.nombre, entrada: ficha(entrada), salida: ficha(salida), rechazo: ficha(libre) };
}

router.get('/', async (req, res, next) => {
  try {
    if (!exposicion.activo()) return res.json({ activo: false });
    const lista = exposicion.cuentas();
    const usuarios = await Usuario.find({ correo: { $in: lista.map((c) => exposicion.correoDe(c.cuenta)) }, activo: true })
      .populate({ path: 'empleado', select: 'nombres apellidos localActual', populate: { path: 'localActual', select: 'nombre' } })
      .lean();
    const porCuenta = new Map(usuarios.map((u) => [u.correo.split('@')[0], u]));
    res.json({
      activo: true,
      modo: exposicion.modo(),
      requierePin: exposicion.pinRequerido(req),
      region: exposicion.soloJunin() ? 'Junín' : 'Perú',
      terminal: await sugerenciasTerminal(),
      cuentas: lista.filter((c) => porCuenta.has(c.cuenta)).map((c) => {
        const u = porCuenta.get(c.cuenta);
        return {
          ...c,
          rol: u.rol,
          persona: u.empleado ? `${u.empleado.nombres} ${u.empleado.apellidos}` : '',
          centro: u.empleado?.localActual?.nombre || null,
        };
      }),
    });
  } catch (err) { next(err); }
});

router.post('/ingresar', validarCuerpo(esq.exposicionIngresar), async (req, res, next) => {
  try {
    if (!exposicion.activo()) return res.status(404).json({ error: 'Ruta no encontrada' });
    if (exposicion.pinRequerido(req) && !exposicion.pinCorrecto(req.body.pin)) {
      return res.status(403).json({ error: 'PIN de exposición incorrecto', requierePin: true });
    }
    const elegida = exposicion.cuentas().find((c) => c.cuenta === req.body.cuenta);
    if (!elegida) return res.status(403).json({ error: 'Esa cuenta no participa en la exposición' });

    const usuario = await Usuario.findOne({ correo: exposicion.correoDe(elegida.cuenta), activo: true }).populate('empleado');
    if (!usuario || usuario.empleado?.estado === 'CESADO') {
      return res.status(404).json({ error: 'La cuenta de la exposición no está disponible' });
    }
    usuario.ultimoIngreso = new Date();
    await usuario.save();

    // La misma respuesta que /api/auth/login
    res.json({
      token: usuario.generarToken(),
      debeCambiarContrasena: false,
      usuario: {
        id: usuario._id,
        correo: usuario.correo,
        rol: usuario.rol,
        metaRol: usuario.metaRol,
        empleado: usuario.empleado,
        debeCambiarContrasena: false,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
