const router = require('express').Router();
const { patronDeBusqueda } = require('../utils/busqueda');
const crypto = require('crypto');
const Usuario = require('../models/Usuario');
const Empleado = require('../models/Empleado');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { ROLES, ROLE_CODES, getRole } = require('../config/roles');
const rec = require('../services/recuperacion');
const { validarCuerpo, validarConsulta, validarId } = require('../middleware/validar');
const esq = require('../validators/esquemas');
const { paginacionDe } = require('../middleware/paginacion');

/**
 * Administración de cuentas.
 *
 * Un sistema de RRHH sin alta de usuarios no se puede poner en producción: al
 * incorporar a alguien hay que darle acceso, y al cesarlo hay que quitárselo.
 * Aquí vive ese ciclo, reservado a quien administra el sistema.
 */

router.use(auth);

/**
 * El rol ADMIN sólo lo concede, lo retira o lo toca otro ADMIN.
 *
 * El permiso `users: write` lo tiene también la Gerencia de RRHH, que da de alta
 * y de baja al personal. Sin este guardia esa misma cuenta podía asignarse el
 * rol de administrador a sí misma a través de una cuenta cómplice, o resetear la
 * contraseña del administrador y entrar con ella: una escalada completa desde un
 * permiso que existe para otra cosa.
 *
 * Va a nivel de router, antes de cada ruta, para que una ruta de escritura nueva
 * no pueda olvidarlo.
 */
router.use(async (req, res, next) => {
  if (req.method === 'GET' || req.usuario.rol === 'ADMIN') return next();
  try {
    if (req.body?.rol === 'ADMIN') {
      return res.status(403).json({ error: 'Sólo un Administrador del Sistema puede conceder ese rol.' });
    }
    const id = (req.path.match(/^\/([0-9a-fA-F]{24})(\/|$)/) || [])[1];
    if (id) {
      const objetivo = await Usuario.findById(id).select('rol').lean();
      if (objetivo?.rol === 'ADMIN') {
        return res.status(403).json({ error: 'La cuenta de un Administrador del Sistema sólo la gestiona otro administrador.' });
      }
    }
    next();
  } catch (err) { next(err); }
});

const LONGITUD_MINIMA = 10;

/**
 * Contraseña temporal legible pero no adivinable.
 *
 * Se excluyen los caracteres que se confunden al dictarla por teléfono (I, l,
 * O, 0, 1). Cada clase de carácter se siembra explícitamente: tomando 12
 * símbolos al azar del alfabeto completo, una de cada 400 salía sin minúsculas
 * y no cumplía la política que este mismo archivo exige.
 */
const MAYUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghijkmnopqrstuvwxyz';
const DIGITOS = '23456789';

/** Entero uniforme en [0, tope) sin el sesgo del módulo */
function alAzar(tope) {
  const limite = Math.floor(256 / tope) * tope;
  let b;
  do { b = crypto.randomBytes(1)[0]; } while (b >= limite);
  return b % tope;
}

function generarTemporal() {
  const alfabeto = MAYUSCULAS + MINUSCULAS + DIGITOS;
  const caracteres = [
    MAYUSCULAS[alAzar(MAYUSCULAS.length)],
    MINUSCULAS[alAzar(MINUSCULAS.length)],
    DIGITOS[alAzar(DIGITOS.length)],
  ];
  while (caracteres.length < 12) caracteres.push(alfabeto[alAzar(alfabeto.length)]);

  // Barajado de Fisher-Yates: si no, las tres primeras posiciones son predecibles
  for (let i = caracteres.length - 1; i > 0; i--) {
    const j = alAzar(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j], caracteres[i]];
  }
  return caracteres.join('') + '#1';
}

/** Exigencias mínimas de la credencial */
function validarContrasena(valor, correo) {
  const problemas = [];
  if (!valor || valor.length < LONGITUD_MINIMA) {
    problemas.push(`Debe tener al menos ${LONGITUD_MINIMA} caracteres`);
  }
  if (!/[a-z]/.test(valor || '') || !/[A-Z]/.test(valor || '')) {
    problemas.push('Debe combinar mayúsculas y minúsculas');
  }
  if (!/\d/.test(valor || '')) problemas.push('Debe incluir al menos un número');
  // Se comparan ambos sin separadores: "prueba.acceso" y "PruebaAcceso" son lo mismo
  const simplificar = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cuenta = simplificar((correo || '').split('@')[0]);
  if (cuenta.length >= 4 && simplificar(valor).includes(cuenta)) {
    problemas.push('No puede contener el nombre de la cuenta');
  }
  // Contraseñas que la gente escribe de verdad. Son datos, no nombres de campo:
  // «password» es la más usada del mundo y tiene que seguir en la lista.
  const comunes = ['password', 'contrasena', '12345678', 'qwerty', 'admin123'];
  if (comunes.some((c) => (valor || '').toLowerCase().includes(c))) {
    problemas.push('Es una contraseña demasiado común');
  }
  return problemas;
}

// ─── Listado de cuentas ──────────────────────────────────────────────────────
router.get('/', permit('users', 'read'), async (req, res, next) => {
  try {
    const { rol, activo, search } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filter = {};
    if (rol) filter.rol = rol;
    if (activo !== undefined) filter.activo = activo === 'true';
    const patron = patronDeBusqueda(search);
    if (patron) filter.correo = patron;

    const [cuentas, total] = await Promise.all([
      Usuario.find(filter)
        .populate({
          path: 'empleado',
          select: 'nombres apellidos dni tipoProfesional localActual estado',
          populate: { path: 'localActual', select: 'nombre marca' },
        })
        .populate('creadoPor', 'correo')
        .sort({ activo: -1, correo: 1 })
        .skip(skip).limit(limit),
      Usuario.countDocuments(filter),
    ]);

    // Empleados activos que todavía no pueden entrar al sistema
    const conCuenta = await Usuario.find().distinct('empleado');
    const sinCuenta = await Empleado.countDocuments({
      estado: 'ACTIVO',
      _id: { $nin: conCuenta.filter(Boolean) },
    });

    res.json({
      data: cuentas,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      resumen: {
        total: await Usuario.countDocuments(),
        activas: await Usuario.countDocuments({ activo: true }),
        bloqueadas: await Usuario.countDocuments({ bloqueadoHasta: { $gt: new Date() } }),
        conCambioPendiente: await Usuario.countDocuments({ debeCambiarContrasena: true }),
        empleadosSinCuenta: sinCuenta,
      },
    });
  } catch (err) { next(err); }
});

/** Catálogo de roles asignables, para no escribirlos a mano en la interfaz */
router.get('/roles', permit('users', 'read'), (_req, res) => {
  res.json(
    ROLE_CODES
      .filter((c) => !ROLES[c].deprecated)
      .map((codigo) => ({
        codigo,
        etiqueta: ROLES[codigo].etiqueta,
        nivelOrganizacional: ROLES[codigo].nivelOrganizacional,
        scope: ROLES[codigo].scope,
        modulos: Object.keys(ROLES[codigo].permissions).length,
      }))
  );
});

/** Empleados activos que aún no tienen acceso al sistema */
router.get('/pendientes', permit('users', 'write'), async (_req, res, next) => {
  try {
    const conCuenta = (await Usuario.find().distinct('empleado')).filter(Boolean);
    const pendientes = await Empleado.find({ estado: 'ACTIVO', _id: { $nin: conCuenta } })
      .populate('cargoActual', 'nombre rolPorDefecto')
      .populate('localActual', 'nombre marca')
      .select('nombres apellidos dni correo tipoProfesional cargoActual localActual')
      .sort({ apellidos: 1 })
      .limit(200);
    res.json({ data: pendientes, total: pendientes.length });
  } catch (err) { next(err); }
});

// ─── Alta de cuenta ──────────────────────────────────────────────────────────
router.post('/', permit('users', 'write'), validarCuerpo(esq.cuentaCrear), async (req, res, next) => {
  try {
    // Ver la nota de auth.js: el correo del cuerpo y el normalizado son dos
    // cosas distintas y necesitan dos nombres distintos
    const { employeeId, correo: correoCrudo, rol, contrasena } = req.body;

    if (!getRole(rol) || ROLES[rol].deprecated) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const empleado = await Empleado.findById(employeeId)
      .populate('cargoActual', 'nombre rolPorDefecto');
    if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (empleado.estado === 'CESADO') {
      return res.status(400).json({ error: 'No se puede dar acceso a un empleado cesado' });
    }

    const yaExiste = await Usuario.findOne({ empleado: empleado._id });
    if (yaExiste) {
      return res.status(409).json({ error: `${empleado.nombres} ya tiene la cuenta ${yaExiste.correo}` });
    }

    const correo = (correoCrudo || empleado.correo || '').toLowerCase().trim();
    if (!correo) return res.status(400).json({ error: 'Indique el correo de la cuenta' });
    if (await Usuario.findOne({ correo })) {
      return res.status(409).json({ error: 'Ese correo ya está registrado' });
    }

    // Sin contraseña indicada se genera una temporal de un solo uso
    const temporal = contrasena ? null : generarTemporal();
    const credencial = contrasena || temporal;

    if (contrasena) {
      const problemas = validarContrasena(contrasena, correo);
      if (problemas.length) return res.status(400).json({ error: problemas[0], problemas });
    }

    const cuenta = await Usuario.create({
      correo: correo,
      contrasena: credencial,
      rol,
      empleado: empleado._id,
      debeCambiarContrasena: true,      // siempre se define una propia al entrar
      creadoPor: req.usuario._id,
    });

    res.status(201).json({
      cuenta,
      // La temporal se muestra una sola vez: no queda recuperable después
      contrasenaTemporal: temporal,
      mensaje: temporal
        ? 'Cuenta creada. Entregue la contraseña temporal al empleado: no volverá a mostrarse.'
        : 'Cuenta creada. El empleado deberá cambiar la contraseña al ingresar.',
    });
  } catch (err) { next(err); }
});

// ─── Cambio de rol ───────────────────────────────────────────────────────────
router.put('/:id/role', validarId(), permit('users', 'write'), validarCuerpo(esq.cuentaRol), async (req, res, next) => {
  try {
    const { rol } = req.body;
    if (!getRole(rol) || ROLES[rol].deprecated) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const cuenta = await Usuario.findById(req.params.id);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    // Nadie se degrada a sí mismo sin querer, ni se queda el sistema sin quien lo administre
    if (String(cuenta._id) === String(req.usuario._id) && rol !== cuenta.rol) {
      return res.status(400).json({ error: 'No puede cambiar su propio rol' });
    }
    if (cuenta.rol === 'ADMIN' && rol !== 'ADMIN') {
      const admins = await Usuario.countDocuments({ rol: 'ADMIN', activo: true });
      if (admins <= 1) {
        return res.status(400).json({ error: 'Debe existir al menos un administrador activo' });
      }
    }

    const anterior = cuenta.rol;
    cuenta.rol = rol;
    // El rol viaja en el token: sin esto, un degradado conservaría sus permisos
    cuenta.cerrarSesiones(req.usuario._id);
    await cuenta.save();

    await Notificacion.create({
      usuario: cuenta._id,
      tipo: 'SISTEMA',
      titulo: 'Su rol ha cambiado',
      mensaje: `Su acceso pasó de ${ROLES[anterior]?.etiqueta || anterior} a ${ROLES[rol].etiqueta}.`,
      prioridad: 'ALTA',
    });

    res.json({ cuenta, anterior });
  } catch (err) { next(err); }
});

// ─── Activación y desactivación ──────────────────────────────────────────────
router.put('/:id/estado', validarId(), permit('users', 'write'), validarCuerpo(esq.cuentaEstado), async (req, res, next) => {
  try {
    const { activo, motivo } = req.body;
    const cuenta = await Usuario.findById(req.params.id);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    if (String(cuenta._id) === String(req.usuario._id)) {
      return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
    }
    if (!activo && cuenta.rol === 'ADMIN') {
      const admins = await Usuario.countDocuments({ rol: 'ADMIN', activo: true });
      if (admins <= 1) {
        return res.status(400).json({ error: 'Debe existir al menos un administrador activo' });
      }
    }

    cuenta.activo = !!activo;
    if (!activo) {
      cuenta.desactivadoEn = new Date();
      cuenta.desactivadoPor = req.usuario._id;
      // Revocar el acceso debe surtir efecto ya, no cuando expire su token
      cuenta.cerrarSesiones(req.usuario._id);
    } else {
      cuenta.desactivadoEn = undefined;
      cuenta.desactivadoPor = undefined;
      cuenta.intentosFallidos = 0;
      cuenta.bloqueadoHasta = undefined;
    }
    await cuenta.save();

    res.json({
      cuenta,
      mensaje: activo
        ? 'Cuenta reactivada'
        : `Acceso revocado${motivo ? `: ${motivo}` : ''}. Las sesiones abiertas caducan al expirar su token.`,
    });
  } catch (err) { next(err); }
});

// ─── Restablecimiento por el administrador ───────────────────────────────────
router.put('/:id/reset-password', validarId(), permit('users', 'write'), async (req, res, next) => {
  try {
    const cuenta = await Usuario.findById(req.params.id).select('+contrasena');
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const temporal = generarTemporal();
    cuenta.contrasena = temporal;
    cuenta.debeCambiarContrasena = true;
    cuenta.intentosFallidos = 0;
    cuenta.bloqueadoHasta = undefined;
    // Si se restablece porque la cuenta quedó comprometida, hay que echar al intruso
    cuenta.cerrarSesiones(req.usuario._id);
    await cuenta.save();

    await Notificacion.create({
      usuario: cuenta._id,
      tipo: 'SISTEMA',
      titulo: 'Su contraseña fue restablecida',
      mensaje: 'Recursos Humanos restableció su contraseña. Deberá definir una nueva al ingresar.',
      prioridad: 'ALTA',
    });

    res.json({
      contrasenaTemporal: temporal,
      mensaje: 'Entregue esta contraseña al empleado: no volverá a mostrarse.',
    });
  } catch (err) { next(err); }
});

/** Desbloqueo tras intentos fallidos */
router.put('/:id/desbloquear', validarId(), permit('users', 'write'), async (req, res, next) => {
  try {
    const cuenta = await Usuario.findByIdAndUpdate(
      req.params.id,
      { intentosFallidos: 0, bloqueadoHasta: undefined },
      { new: true }
    );
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ cuenta, mensaje: 'Cuenta desbloqueada' });
  } catch (err) { next(err); }
});

/**
 * Correo institucional sugerido a partir del nombre.
 *
 * Se quitan tildes y se usa el primer nombre y el primer apellido, que es la
 * convención de la casa. Si ya está tomado se añade una inicial más antes de
 * recurrir a un número: «ana.perez», «ana.perezr», «ana.perez2».
 */
function sinTildes(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z\s]/g, '').trim();
}

function correoSugerido(empleado, dominio, tomados) {
  const nombre = sinTildes(empleado.nombres).split(/\s+/)[0] || 'usuario';
  const apellidos = sinTildes(empleado.apellidos).split(/\s+/).filter(Boolean);
  const apellido = apellidos[0] || 'sa';

  const candidatos = [`${nombre}.${apellido}`];
  if (apellidos[1]) candidatos.push(`${nombre}.${apellido}${apellidos[1][0]}`);
  for (let i = 2; i <= 20; i++) candidatos.push(`${nombre}.${apellido}${i}`);

  for (const base of candidatos) {
    const correo = `${base}@${dominio}`;
    if (!tomados.has(correo)) {
      tomados.add(correo);
      return correo;
    }
  }
  return `dni${empleado.dni}@${dominio}`;
}

/**
 * Alta masiva de cuentas.
 *
 * De poco sirve un sistema de autoservicio si la mayor parte de la planilla no
 * puede entrar: sin cuenta no marcan asistencia, no ven su boleta ni solicitan
 * descansos. Dar de alta 130 personas de una en una no se hace nunca, así que
 * se hace de golpe, con el rol que corresponde al puesto de cada quien.
 *
 * Devuelve las contraseñas temporales UNA sola vez: después no son
 * recuperables. La respuesta está pensada para imprimirse y repartirse.
 */
router.post('/alta-masiva', permit('users', 'write'), validarCuerpo(esq.cuentaAltaMasiva), async (req, res, next) => {
  try {
    const { locationId, dominio = 'pharmatalent.pe', limite = 200, soloSimular } = req.body;

    const conCuenta = (await Usuario.find().distinct('empleado')).filter(Boolean);
    const filtro = { estado: 'ACTIVO', _id: { $nin: conCuenta } };
    if (locationId) filtro.localActual = locationId;

    const pendientes = await Empleado.find(filtro)
      .populate('cargoActual', 'nombre rolPorDefecto')
      .populate('localActual', 'nombre marca')
      .sort({ apellidos: 1 })
      .limit(Math.min(Number(limite) || 200, 500));

    if (!pendientes.length) {
      return res.status(400).json({ error: 'No hay empleados activos sin cuenta con ese criterio' });
    }

    const tomados = new Set((await Usuario.find().select('correo').lean()).map((u) => u.correo));
    const creadas = [];
    const omitidos = [];

    for (const emp of pendientes) {
      const rol = emp.cargoActual?.rolPorDefecto;
      // Sin rol declarado en el puesto no se adivina: se informa y se salta
      // El rol ADMIN no se concede por alta masiva aunque el cargo lo traiga por
      // omisión: lo asigna a mano otro administrador
      if (!rol || !getRole(rol) || ROLES[rol].deprecated || rol === 'ADMIN') {
        omitidos.push({
          dni: emp.dni,
          nombre: `${emp.nombres} ${emp.apellidos}`,
          motivo: rol
            ? `El puesto declara el rol «${rol}», que no existe en la matriz`
            : `El puesto «${emp.cargoActual?.nombre || '—'}» no declara rol`,
        });
        continue;
      }

      const correo = (emp.correo && !tomados.has(emp.correo.toLowerCase()))
        ? emp.correo.toLowerCase()
        : correoSugerido(emp, dominio, tomados);
      tomados.add(correo);

      const temporal = generarTemporal();
      creadas.push({
        empleado: emp._id,
        dni: emp.dni,
        nombre: `${emp.apellidos}, ${emp.nombres}`,
        cargo: emp.cargoActual?.nombre,
        centro: emp.localActual?.nombre,
        correo: correo,
        rol: rol,
        rolLabel: ROLES[rol].etiqueta,
        contrasenaTemporal: temporal,
      });
    }

    if (soloSimular) {
      return res.json({
        simulacion: true,
        seCrearian: creadas.length,
        omitidos,
        // En la simulación no se entregan credenciales: aún no existen
        muestra: creadas.slice(0, 10).map(({ contrasenaTemporal, ...resto }) => resto),
      });
    }

    // Se crean de una en una para que el hash de contraseña del modelo se aplique
    const listas = [];
    const fallidas = [];
    for (const c of creadas) {
      try {
        await Usuario.create({
          correo: c.correo,
          contrasena: c.contrasenaTemporal,
          rol: c.rol,
          empleado: c.empleado,
          debeCambiarContrasena: true,
          creadoPor: req.usuario._id,
        });
        listas.push(c);
      } catch (err) {
        fallidas.push({ dni: c.dni, nombre: c.nombre, motivo: err.message });
      }
    }

    res.status(201).json({
      creadas: listas.length,
      omitidos,
      fallidas,
      mensaje: 'Estas contraseñas no volverán a mostrarse. Imprima o guarde esta lista antes de cerrarla.',
      credenciales: listas.map((c) => ({
        nombre: c.nombre,
        dni: c.dni,
        cargo: c.cargo,
        centro: c.centro,
        correo: c.correo,
        rol: c.rolLabel,
        contrasenaTemporal: c.contrasenaTemporal,
      })),
    });
  } catch (err) { next(err); }
});

/**
 * Cerrar todas las sesiones de una cuenta.
 *
 * Sirve cuando alguien perdió el teléfono o sospecha que su clave se filtró:
 * corta el acceso al instante sin necesidad de cambiar la contraseña ni
 * desactivar la cuenta.
 */
router.put('/:id/cerrar-sesiones', validarId(), permit('users', 'write'),
  async (req, res, next) => {
    try {
      const cuenta = await Usuario.findById(req.params.id);
      if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

      cuenta.cerrarSesiones(req.usuario._id);
      await cuenta.save();

      await Notificacion.create({
        usuario: cuenta._id,
        tipo: 'SISTEMA',
        titulo: 'Se cerraron sus sesiones',
        mensaje: 'Recursos Humanos cerró las sesiones abiertas de su cuenta. Vuelva a ingresar.',
        prioridad: 'ALTA',
      }).catch(() => {});

      res.json({
        cuenta,
        mensaje: 'Sesiones cerradas. Cualquier acceso abierto deja de funcionar al instante.',
      });
    } catch (err) { next(err); }
  });

/**
 * Solicitudes de recuperación pendientes.
 *
 * Quien pidió recuperar su contraseña aparece aquí. El código NO figura: se
 * guarda su huella, no el código, precisamente para que leer la base de datos
 * no baste para entrar en una cuenta.
 */
router.get('/recuperaciones', permit('users', 'write'), async (_req, res, next) => {
  try {
    const pendientes = await Usuario.find({
      'recuperacion.solicitadaEn': { $exists: true },
      'recuperacion.expiraEn': { $gt: new Date() },
      'recuperacion.usadaEn': { $exists: false },
      activo: true,
    })
      .populate('empleado', 'nombres apellidos dni localActual')
      .select('correo rol recuperacion empleado')
      .sort({ 'recuperacion.solicitadaEn': -1 })
      .lean();

    res.json({
      data: pendientes.map((u) => ({
        _id: u._id,
        correo: u.correo,
        rol: u.rol,
        empleado: u.empleado
          ? { nombre: `${u.empleado.nombres} ${u.empleado.apellidos}`, dni: u.empleado.dni }
          : null,
        solicitadaEn: u.recuperacion.solicitadaEn,
        minutosRestantes: rec.minutosRestantes(u.recuperacion),
        intentosFallidos: u.recuperacion.intentos || 0,
      })),
      total: pendientes.length,
      nota: 'El código no se almacena en claro. Genere uno nuevo para poder dictárselo.',
    });
  } catch (err) { next(err); }
});

/**
 * Genera el código y lo muestra una sola vez a quien lo va a entregar.
 *
 * Es el eslabón que hacía falta: el sistema guarda la huella —para que leer la
 * base no sirva de nada— pero alguien tiene que poder dictarle seis dígitos
 * por teléfono a quien está en una botica de Huancayo un domingo.
 *
 * Al generarlo se invalida cualquier código anterior, de modo que dos llamadas
 * seguidas no dejan dos códigos vivos.
 */
router.put('/:id/codigo-recuperacion', validarId(), permit('users', 'write'),
  async (req, res, next) => {
    try {
      const cuenta = await Usuario.findById(req.params.id).populate('empleado', 'nombres apellidos telefono');
      if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
      if (!cuenta.activo) {
        return res.status(400).json({ error: 'La cuenta está desactivada. Reactívela primero.' });
      }

      const solicitud = rec.nuevaSolicitud();
      cuenta.recuperacion = {
        huella: solicitud.huella,
        expiraEn: solicitud.expiraEn,
        intentos: 0,
        solicitadaEn: solicitud.solicitadaEn,
        usadaEn: undefined,
        solicitudesRecientes: cuenta.recuperacion?.solicitudesRecientes || 0,
      };
      await cuenta.save();

      res.json({
        // Se entrega una vez: después sólo queda la huella
        codigo: solicitud.codigo,
        expiraEn: `${rec.VIGENCIA_MINUTOS} minutos`,
        destinatario: cuenta.empleado
          ? `${cuenta.empleado.nombres} ${cuenta.empleado.apellidos}`
          : cuenta.correo,
        telefono: cuenta.empleado?.telefono,
        mensaje: 'Dicte este código a la persona. No volverá a mostrarse y caduca en '
          + `${rec.VIGENCIA_MINUTOS} minutos.`,
      });
    } catch (err) { next(err); }
  });

module.exports = router;
module.exports.validarContrasena = validarContrasena;
module.exports.generarTemporal = generarTemporal;
module.exports.LONGITUD_MINIMA = LONGITUD_MINIMA;
