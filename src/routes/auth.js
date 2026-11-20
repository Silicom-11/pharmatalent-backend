const router = require('express').Router();
const Usuario = require('../models/Usuario');
const { auth } = require('../middleware/auth');
const { validarContrasena, LONGITUD_MINIMA } = require('./users');
const Notificacion = require('../models/Notificacion');
const rec = require('../services/recuperacion');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');

/**
 * Autenticación y credencial propia.
 *
 * El login cuenta los intentos fallidos por cuenta y la bloquea temporalmente
 * tras varios seguidos: sin esa contención, una contraseña débil cae por fuerza
 * bruta en minutos. La respuesta no distingue entre correo inexistente y
 * contraseña equivocada, para no revelar qué cuentas existen.
 */

const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;

router.post('/login', validarCuerpo(esq.login), async (req, res, next) => {
  try {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena) {
      return res.status(400).json({ error: 'Correo y contraseña requeridos' });
    }

    const usuario = await Usuario.findOne({ correo: String(correo).toLowerCase().trim() })
      .select('+contrasena')
      .populate('empleado');

    // Mismo mensaje exista o no la cuenta: no se filtra qué correos hay
    const credencialInvalida = () =>
      res.status(401).json({ error: 'Credenciales inválidas' });

    if (!usuario) return credencialInvalida();

    if (usuario.bloqueadoHasta && usuario.bloqueadoHasta > new Date()) {
      const minutos = Math.ceil((usuario.bloqueadoHasta - Date.now()) / 60000);
      return res.status(429).json({
        error: `Cuenta bloqueada por intentos fallidos. Reintente en ${minutos} minuto(s) o solicite el desbloqueo a Recursos Humanos.`,
      });
    }

    if (!(await usuario.compararContrasena(contrasena))) {
      usuario.intentosFallidos = (usuario.intentosFallidos || 0) + 1;
      if (usuario.intentosFallidos >= MAX_INTENTOS) {
        usuario.bloqueadoHasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60000);
        usuario.intentosFallidos = 0;
      }
      await usuario.save();

      if (usuario.bloqueadoHasta && usuario.bloqueadoHasta > new Date()) {
        return res.status(429).json({
          error: `Demasiados intentos fallidos. Cuenta bloqueada por ${BLOQUEO_MINUTOS} minutos.`,
        });
      }
      return credencialInvalida();
    }

    if (!usuario.activo) {
      return res.status(403).json({ error: 'Cuenta desactivada. Contacte a Recursos Humanos.' });
    }

    // Segunda barrera: el cese ya desactiva la cuenta, pero una cuenta heredada
    // de antes de esa regla podría seguir activa con el legajo cerrado
    if (usuario.empleado?.estado === 'CESADO') {
      return res.status(403).json({ error: 'Su vínculo laboral con la empresa ha concluido. Contacte a Recursos Humanos.' });
    }

    usuario.intentosFallidos = 0;
    usuario.bloqueadoHasta = undefined;
    usuario.ultimoIngreso = new Date();
    await usuario.save();

    res.json({
      token: usuario.generarToken(),
      // Obliga a la interfaz a pedir una contraseña propia antes de continuar
      debeCambiarContrasena: !!usuario.debeCambiarContrasena,
      usuario: {
        id: usuario._id,
        correo: usuario.correo,
        rol: usuario.rol,
        metaRol: usuario.metaRol,
        empleado: usuario.empleado,
        debeCambiarContrasena: !!usuario.debeCambiarContrasena,
      },
    });
  } catch (err) { next(err); }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const usuario = await Usuario.findById(req.usuario._id).populate('empleado');
    res.json(usuario);
  } catch (err) { next(err); }
});

/** Cambio de la propia contraseña: exige conocer la actual */
router.put('/change-password', auth, validarCuerpo(esq.cambioClave), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Indique la contraseña actual y la nueva' });
    }

    const usuario = await Usuario.findById(req.usuario._id).select('+contrasena');
    if (!(await usuario.compararContrasena(currentPassword))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
    }

    const problemas = validarContrasena(newPassword, usuario.correo);
    if (problemas.length) return res.status(400).json({ error: problemas[0], problemas });

    usuario.contrasena = newPassword;
    usuario.debeCambiarContrasena = false;
    usuario.contrasenaCambiadaEn = new Date();
    // Cambiar la contraseña cierra las demás sesiones: si alguien la tenía, deja de servirle
    usuario.cerrarSesiones();
    await usuario.save();

    res.json({
      mensaje: 'Contraseña actualizada. Las demás sesiones se han cerrado.',
      // El token actual acaba de quedar obsoleto: se entrega uno nuevo
      token: usuario.generarToken(),
    });
  } catch (err) { next(err); }
});

/** Exigencias vigentes, para que la interfaz las muestre antes de escribir */
router.get('/password-policy', (_req, res) => {
  res.json({
    longitudMinima: LONGITUD_MINIMA,
    requisitos: [
      `Al menos ${LONGITUD_MINIMA} caracteres`,
      'Mayúsculas y minúsculas',
      'Al menos un número',
      'No puede contener el nombre de la cuenta',
    ],
    intentosAntesDeBloqueo: MAX_INTENTOS,
    minutosDeBloqueo: BLOQUEO_MINUTOS,
  });
});

/**
 * Paso 1 · alguien dice que olvidó su contraseña.
 *
 * La respuesta es siempre la misma exista o no la cuenta. Si variara, esta
 * ruta se convertiría en una forma cómoda de averiguar qué correos están
 * registrados en la empresa.
 */
router.post('/recuperar', validarCuerpo(esq.recuperarSolicitar), async (req, res, next) => {
  try {
    const correo = String(req.body.correo).toLowerCase().trim();
    const respuesta = {
      mensaje: 'Si ese correo corresponde a una cuenta activa, Recursos Humanos recibirá su '
        + 'solicitud y le entregará un código de recuperación.',
      vigenciaMinutos: rec.VIGENCIA_MINUTOS,
    };

    const usuario = await Usuario.findOne({ correo: correo });
    if (!usuario || !usuario.activo) return res.json(respuesta);

    // Ventana de solicitudes: pedirlo diez veces no debe llenar de avisos a RRHH
    const ventana = rec.VENTANA_SOLICITUDES_MINUTOS * 60000;
    const dentroDeVentana = usuario.recuperacion?.solicitadaEn
      && Date.now() - new Date(usuario.recuperacion.solicitadaEn) < ventana;
    const recientes = dentroDeVentana ? (usuario.recuperacion.solicitudesRecientes || 0) : 0;

    if (recientes >= rec.MAX_SOLICITUDES) {
      // Se responde igual, pero no se genera nada ni se avisa otra vez
      return res.json(respuesta);
    }

    const solicitud = rec.nuevaSolicitud();
    usuario.recuperacion = {
      huella: solicitud.huella,
      expiraEn: solicitud.expiraEn,
      intentos: 0,
      solicitadaEn: solicitud.solicitadaEn,
      usadaEn: undefined,
      solicitudesRecientes: recientes + 1,
    };
    await usuario.save();

    /**
     * Entrega del código.
     *
     * Sin servidor de correo configurado, la solicitud llega a quien administra
     * cuentas y el código se dicta por teléfono. Es lo que ocurre de verdad
     * cuando quien lo necesita está en una botica y RRHH está en Lima.
     */
    const administradores = await Usuario.find({
      rol: { $in: ['ADMIN', 'GERENTE_RRHH'] },
      activo: true,
    }).select('_id').lean();

    await Notificacion.insertMany(administradores.map((a) => ({
      usuario: a._id,
      tipo: 'SISTEMA',
      titulo: 'Solicitud de recuperación de contraseña',
      mensaje: `${correo} solicitó recuperar su contraseña. El código está en Cuentas de Acceso `
        + `y caduca en ${rec.VIGENCIA_MINUTOS} minutos.`,
      prioridad: 'ALTA',
    }))).catch(() => { /* el aviso es secundario: la solicitud ya quedó registrada */ });

    res.json(respuesta);
  } catch (err) { next(err); }
});

/**
 * Paso 2 · se canjea el código por una contraseña nueva.
 *
 * Cada intento fallido cuenta. A los cinco, el código muere: seis dígitos con
 * media hora de vida y cinco intentos dejan la fuerza bruta en cinco entre un
 * millón.
 */
router.post('/recuperar/canjear', validarCuerpo(esq.recuperarCanjear), async (req, res, next) => {
  try {
    // El crudo se distingue del normalizado: antes de traducir, uno se
    // llamaba `correo` y el otro `correo`, y al pasar ambos a castellano
    // quedaban con el mismo nombre en el mismo ambito
    const { correo: correoCrudo, codigo, nuevaContrasena } = req.body;
    const correo = String(correoCrudo).toLowerCase().trim();

    const usuario = await Usuario.findOne({ correo }).select('+recuperacion.huella +contrasena');
    // Mismo mensaje que un código equivocado: no se revela si la cuenta existe
    const invalido = () => res.status(400).json({
      error: 'El código no es válido o ya caducó. Solicite uno nuevo.',
    });
    if (!usuario || !usuario.activo) return invalido();

    const estado = rec.estadoDeSolicitud(usuario.recuperacion);
    if (!estado.valida) {
      return res.status(400).json({ error: estado.motivo });
    }

    if (!rec.coincide(codigo, usuario.recuperacion.huella)) {
      usuario.recuperacion.intentos = (usuario.recuperacion.intentos || 0) + 1;
      await usuario.save();
      const restantes = rec.MAX_INTENTOS_CANJE - usuario.recuperacion.intentos;
      return res.status(400).json({
        error: restantes > 0
          ? `Código incorrecto. Le quedan ${restantes} intento(s).`
          : 'Código incorrecto. Se agotaron los intentos: solicite uno nuevo.',
      });
    }

    const problemas = validarContrasena(nuevaContrasena, correo);
    if (problemas.length) return res.status(400).json({ error: problemas[0], problemas });

    usuario.contrasena = nuevaContrasena;
    usuario.debeCambiarContrasena = false;
    usuario.contrasenaCambiadaEn = new Date();
    usuario.intentosFallidos = 0;
    usuario.bloqueadoHasta = undefined;
    usuario.recuperacion.usadaEn = new Date();
    usuario.recuperacion.huella = undefined;
    // Recuperar la contraseña cierra todo lo abierto: si alguien había entrado, sale
    usuario.cerrarSesiones();
    await usuario.save();

    res.json({
      mensaje: 'Contraseña restablecida. Las sesiones abiertas se han cerrado.',
      token: usuario.generarToken(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
