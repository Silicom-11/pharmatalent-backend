const Usuario = require('../models/Usuario');

/**
 * Retira el acceso al sistema de quien deja la empresa.
 *
 * El cese se registra desde tres sitios —el vencimiento sin renovación de un
 * contrato, la baja del legajo y el pago de la liquidación— y ninguno tocaba la
 * cuenta. El resultado era que una persona cesada seguía entrando, viendo su
 * horario, su boleta y, si era jefatura, los datos de su antiguo equipo. En la
 * base había dieciséis cuentas activas de personal cesado.
 *
 * Se desactiva la cuenta y además se sube la versión de sesión: desactivar sin
 * cerrar sesiones dejaría vivos los tokens ya emitidos hasta que caducaran.
 *
 * Devuelve cuántas cuentas se cerraron (una persona debería tener una sola,
 * pero si la base heredó duplicados se cierran todas).
 */
async function revocarAccesoPorCese(empleadoId, porQuien = null) {
  const cuentas = await Usuario.find({ empleado: empleadoId, activo: true });
  for (const cuenta of cuentas) {
    cuenta.activo = false;
    cuenta.desactivadoEn = new Date();
    if (porQuien) cuenta.desactivadoPor = porQuien;
    cuenta.cerrarSesiones(porQuien);
    await cuenta.save();
  }
  return cuentas.length;
}

module.exports = { revocarAccesoPorCese };
