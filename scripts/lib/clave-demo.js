/**
 * Clave común de las cuentas de demostración.
 *
 * No se escribe en el código porque el repositorio es público: se lee de
 * CLAVE_DEMO en el archivo .env (ver .env.example). Sin ella, los scripts que
 * crean o usan cuentas de demostración se detienen con un mensaje claro.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

function claveDemo() {
  const clave = process.env.CLAVE_DEMO;
  if (!clave) {
    console.error('Falta CLAVE_DEMO en el archivo .env: es la contraseña común de las cuentas de demostración (ver .env.example).');
    process.exit(1);
  }
  return clave;
}

module.exports = { claveDemo };
