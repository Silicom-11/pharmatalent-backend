const jwt = require('jsonwebtoken');
const Usuario = require('../models/Usuario');

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso no autorizado' });
  }

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const usuario = await Usuario.findById(decoded.id);
    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    }

    /**
     * El token puede ser válido y estar caducado igualmente.
     *
     * Si la contraseña cambió, el rol cambió o se revocó el acceso, la cuenta
     * subió su versión de sesión y los tokens anteriores dejaron de valer.
     * Sin esta comprobación, cesar a alguien no le quitaba el acceso hasta
     * ocho horas después.
     */
    const versionDelToken = decoded.tv ?? 0;
    if (versionDelToken !== (usuario.versionToken || 0)) {
      return res.status(401).json({
        error: 'Su sesión ya no es válida. Vuelva a ingresar.',
        sesionCerrada: true,
      });
    }

    req.usuario = usuario;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.usuario.rol)) {
    return res.status(403).json({ error: 'No tiene permisos para esta acción' });
  }
  next();
};

module.exports = { auth, authorize };
