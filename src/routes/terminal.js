const router = require('express').Router();
const crypto = require('crypto');
const Local = require('../models/Local');
const Empleado = require('../models/Empleado');
const Usuario = require('../models/Usuario');
const { registrarMarca } = require('../services/marcacion');
const { SHIFT_ROLES } = require('../config/formats');
const { validarCuerpo } = require('../middleware/validar');
const esq = require('../validators/esquemas');

/**
 * Terminal de marcación del centro de trabajo.
 *
 * La asistencia ya no se marca desde la sesión del trabajador. Antes bastaba
 * con abrir el sistema en el celular para registrar la entrada desde la casa,
 * desde el bus o desde otra botica: la hora era real, la presencia no.
 *
 * Ahora la marca la registra el equipo instalado en la botica —el reloj
 * biométrico o, donde no lo hay, la computadora del local en modo quiosco—, y
 * ese equipo se identifica con una clave propia que da de alta el
 * administrador. La persona se identifica en el equipo; el equipo responde por
 * el lugar. Es el registro de control de asistencia que exige el
 * D.S. 004-2006-TR, con su origen a la vista.
 *
 * Cabeceras de cada petición:
 *   X-Terminal-Local   código del local (p. ej. INK-HYO-01)
 *   X-Terminal-Clave   clave entregada al dar de alta el terminal
 */

const hash = (clave) => crypto.createHash('sha256').update(String(clave)).digest('hex');

function igual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Identifica el terminal; deja el local en req.local */
async function terminal(req, res, next) {
  try {
    const codigo = req.get('X-Terminal-Local');
    const clave = req.get('X-Terminal-Clave');
    if (!codigo || !clave) {
      return res.status(401).json({ error: 'Este equipo no está registrado como terminal de marcación.' });
    }
    const local = await Local.findOne({ codigo, activo: true }).select('+terminal.claveHash');
    // Mismo mensaje para «no existe» y «clave errada»: no se confirma qué
    // códigos de local son válidos a quien está probando
    if (!local?.terminal?.activo || !igual(local.terminal.claveHash, hash(clave))) {
      return res.status(401).json({ error: 'Terminal no autorizado. Solicite al administrador que lo registre de nuevo.' });
    }
    req.local = local;
    next();
  } catch (err) { next(err); }
}

router.use(terminal);

/** Lo que el terminal pinta en su cabecera */
router.get('/estado', (req, res) => {
  const l = req.local;
  res.json({
    local: { nombre: l.nombre, codigo: l.codigo, marca: l.marca, distrito: l.direccion?.distrito, ciudad: l.direccion?.ciudad },
    hora: new Date(),
  });
});

const ESTADOS_QUE_MARCAN = ['ACTIVO'];
const MOTIVO_NO_MARCA = {
  VACACIONES: 'Usted figura de vacaciones en estas fechas.',
  LICENCIA: 'Usted figura con licencia en estas fechas.',
  INACTIVO: 'Su legajo está inactivo. Consulte con su administrador.',
  CESADO: 'Su vínculo laboral con la empresa ha concluido.',
};

router.post('/marcar', validarCuerpo(esq.marcaTerminal), async (req, res, next) => {
  try {
    const dni = String(req.body?.dni || '').replace(/\D/g, '');
    const metodo = ['ROSTRO', 'HUELLA', 'DNI'].includes(req.body?.metodo) ? req.body.metodo : 'DNI';
    if (dni.length !== 8) return res.status(400).json({ error: 'El DNI tiene ocho dígitos.' });

    const empleado = await Empleado.findOne({ dni })
      .select('nombres apellidos dni estado localActual cargoActual')
      .populate('cargoActual', 'nombre');
    // Sin distinguir «no existe» de «no es de aquí»: el terminal no es un
    // buscador de DNI de la empresa
    if (!empleado) return res.status(404).json({ error: 'No se reconoce a esa persona en este centro de trabajo.' });

    if (!ESTADOS_QUE_MARCAN.includes(empleado.estado)) {
      return res.status(403).json({ error: MOTIVO_NO_MARCA[empleado.estado] || 'No puede marcar en este momento.' });
    }

    const cuenta = await Usuario.findOne({ empleado: empleado._id, activo: true }).select('rol').lean();
    const r = await registrarMarca({ empleado, local: req.local, rol: cuenta?.rol, origen: 'TERMINAL', metodo });
    if (!r.ok) {
      const status = ['OTRO_LOCAL', 'EXENTO'].includes(r.codigo) ? 403 : r.codigo === 'SIN_TURNO' ? 404 : 409;
      // Si la persona no es de este local y no tiene turno aquí, se responde
      // como si no existiera
      if (r.codigo === 'SIN_TURNO' && String(empleado.localActual) !== String(req.local._id)) {
        return res.status(404).json({ error: 'No se reconoce a esa persona en este centro de trabajo.' });
      }
      return res.status(status).json({ error: r.error });
    }

    await Local.updateOne({ _id: req.local._id }, { 'terminal.ultimaMarcaEn': new Date() });

    const mio = r.turno?.asignaciones?.find((a) => String(a.empleado) === String(empleado._id));
    res.status(r.accion === 'REPETIDA' ? 200 : 201).json({
      accion: r.accion,
      persona: {
        nombres: empleado.nombres,
        apellidos: empleado.apellidos,
        cargo: empleado.cargoActual?.nombre,
      },
      hora: r.accion === 'SALIDA' ? r.record.marcaSalida : r.record.marcaEntrada,
      turno: r.turno ? {
        tipo: r.turno.tipoTurno, horaInicio: r.turno.horaInicio, horaFin: r.turno.horaFin,
        puesto: SHIFT_ROLES[mio?.rol]?.etiqueta || mio?.rol,
      } : null,
      minutosTardanza: r.record.minutosTardanza || 0,
      horasTrabajadas: r.accion === 'SALIDA' ? r.record.horasTrabajadas : null,
      horasExtra: r.accion === 'SALIDA' ? r.record.horasExtra || 0 : null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.hashClave = hash;
