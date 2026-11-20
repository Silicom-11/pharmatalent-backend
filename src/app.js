/**
 * PharmaTalent — Sistema de gestión de personal
 * Copyright (c) 2026 Marc Aquino Carhuas. Todos los derechos reservados.
 * Software propietario. Ver LICENSE.
 */

require('dotenv').config();

/**
 * Antes que nada: la zona horaria.
 * Node la fija al construir la primera fecha, así que esto tiene que ocurrir
 * antes de cargar cualquier otro módulo del sistema.
 */
const { fijarZonaHoraria } = require('./config/zonaHoraria');
const zona = fijarZonaHoraria();
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const connectDB = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const bitacora = require('./middleware/bitacora');
const { exigirEntorno, origenesPermitidos } = require('./config/entorno');
const { limitador } = require('./middleware/limitador');
const { version: VERSION } = require('../package.json');

// Antes de nada: si la configuración está incompleta, no se arranca
exigirEntorno();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const employeeRoutes = require('./routes/employees');
const dossierRoutes = require('./routes/dossier');
const positionRoutes = require('./routes/positions');
const locationRoutes = require('./routes/locations');
const zoneRoutes = require('./routes/zones');
const scheduleRoutes = require('./routes/schedules');
const attendanceRoutes = require('./routes/attendance');
const vacationRoutes = require('./routes/vacations');
const evaluationRoutes = require('./routes/evaluations');
const contractRoutes = require('./routes/contracts');
const dashboardRoutes = require('./routes/dashboard');
const payrollRoutes = require('./routes/payroll');
const trainingRoutes = require('./routes/training');
const notificationRoutes = require('./routes/notifications');
const meRoutes = require('./routes/me');
const meSelfServiceRoutes = require('./routes/meSelfService');
const requisitionRoutes = require('./routes/requisitions');
const recruitmentRoutes = require('./routes/recruitment');
const welfareRoutes = require('./routes/welfare');
const auditRoutes = require('./routes/audits');
const orgRoutes = require('./routes/org');
const auditLogRoutes = require('./routes/auditLog');
const settlementRoutes = require('./routes/settlements');
const terminalRoutes = require('./routes/terminal');

const app = express();

/**
 * El analizador de consultas se declara, no se hereda.
 *
 * Diecinueve rutas meten un parámetro de consulta directamente en el filtro de
 * Mongo (`if (status) filter.status = status`). Con el analizador «extended»,
 * `?status[$ne]=ACTIVO` llegaría como un objeto y ese operador se ejecutaría
 * contra la base. Express 5 usa «simple» por defecto y por eso hoy no es
 * explotable — pero eso es una herencia, no una decisión, y basta que alguien
 * lo cambie para admitir arrays en la URL para que deje de estarlo.
 */
app.set('query parser', 'simple');

// Cabeceras de seguridad. Sin «upgrade-insecure-requests»: probado por
// http://servidor:8080 antes de ponerle certificado, el navegador pedía los
// scripts por https y la página quedaba en blanco. Con HTTPS, HSTS ya obliga.
app.use(helmet({
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
}));
// Sólo los orígenes declarados pueden llamar a la API
app.use(cors({ origin: origenesPermitidos(), credentials: true }));
const PRODUCCION = process.env.NODE_ENV === 'production';
// En producción, el formato estándar de acceso (lo leen los agregadores de logs)
// (las pruebas de integración no lo necesitan: ensucia su reporte)
if (process.env.NODE_ENV !== 'test') app.use(morgan(PRODUCCION ? 'combined' : 'dev'));
// Un cuerpo desmedido es la forma más barata de tumbar el proceso
app.use(express.json({ limit: '1mb' }));
// Detrás de un proxy, req.ip debe ser el del cliente y no el del balanceador
app.set('trust proxy', 1);
// Toda escritura que salga bien queda registrada
app.use(bitacora);

// Salud para el orquestador: sin base de datos el servicio no está sano
app.get('/api/salud', (_req, res) => {
  // La pantalla de conexión del APK la consulta desde su propio origen para
  // saber si el servidor está al alcance. No expone nada: puede leerla cualquiera
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  const baseConectada = mongoose.connection.readyState === 1;
  res.status(baseConectada ? 200 : 503).json({
    estado: baseConectada ? 'ok' : 'sin base de datos',
    service: 'PharmaTalent API', version: VERSION, timestamp: new Date(),
  });
});

// Intentos por IP: el bloqueo de cuenta no frena a quien prueba una misma
// contraseña contra muchos correos. En desarrollo el tope es holgado para no
// estorbar a las pruebas automáticas.
const QUINCE_MIN = 15 * 60000;
const limiteLogin = limitador({
  ventanaMs: QUINCE_MIN,
  maximo: Number(process.env.LIMITE_INGRESOS_IP) || (PRODUCCION ? 40 : 1000),
  mensaje: 'Demasiados intentos de ingreso desde esta red. Espere unos minutos.',
});
app.use('/api/auth/login', limiteLogin);
app.use('/api/auth/recuperar', limiteLogin);
// El PIN de exposición no se adivina a fuerza de intentos
app.use('/api/exposicion/ingresar', limitador({
  ventanaMs: QUINCE_MIN,
  maximo: 150,
  mensaje: 'Demasiados cambios de rol desde esta red. Espere unos minutos.',
}));
// El terminal de un local recibe la marca de todo el turno en pocos minutos
app.use('/api/terminal/marcar', limitador({
  ventanaMs: 5 * 60000,
  maximo: Number(process.env.LIMITE_MARCAS_IP) || 150,
  mensaje: 'Demasiadas marcas seguidas desde este equipo. Espere un momento.',
}));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', dossierRoutes);   // /:id/dossier antes del CRUD genérico
app.use('/api/employees', employeeRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/vacations', vacationRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/notifications', notificationRoutes);
// Las rutas específicas van primero: /attendance/today antes que /attendance
app.use('/api/me', meSelfServiceRoutes);
app.use('/api/me', meRoutes);
app.use('/api/requisitions', requisitionRoutes);
app.use('/api/recruitment', recruitmentRoutes);
app.use('/api/welfare', welfareRoutes);
app.use('/api/audits', auditRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/bitacora', auditLogRoutes);
app.use('/api/liquidaciones', settlementRoutes);
// El terminal de marcación se autentica con la clave del equipo, no con una sesión
app.use('/api/terminal', terminalRoutes);
// Modo exposición: inactivo salvo MODO_EXPOSICION, y nunca en producción
app.use('/api/exposicion', require('./routes/exposicion'));
// Fase de mantenimiento: reportes de los usuarios, monitoreo y plan preventivo
app.use('/api/mantenimiento', require('./routes/mantenimiento'));

// Una ruta de la API que no existe responde JSON, no la página del frontend
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

/**
 * El frontend compilado, servido por el mismo proceso.
 *
 * Así producción es un solo servicio en un solo origen: sin CORS entre
 * dominios y con el kiosco del terminal (/terminal) en la misma dirección.
 * Se activa cuando existe la compilación (npm run build en el frontend);
 * FRONTEND_DIST permite apuntar a otra carpeta.
 */
const DIST = process.env.FRONTEND_DIST || path.join(__dirname, '..', '..', 'pharmatalent-frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  // Los archivos con hash en el nombre no cambian: se guardan un año
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  // Cualquier otra ruta es del enrutador de React
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
  console.log(`Frontend servido desde ${DIST}`);
}

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

/**
 * Se exporta la aplicación sin arrancarla: las pruebas de integración la
 * levantan en un puerto libre, contra su propia base. Sólo `node src/app.js`
 * (npm start, nodemon, Docker) conecta y escucha.
 */
module.exports = app;
if (require.main !== module) return;

connectDB().then(() => {
  const servidor = app.listen(PORT, () => {
    console.log(`PharmaTalent API corriendo en puerto ${PORT}`);
    console.log(`Zona horaria: ${zona.efectiva} (UTC${zona.desfase >= 0 ? '+' : ''}${zona.desfase})`
      + (zona.heredada !== zona.efectiva ? ` — el servidor venía en ${zona.heredada}` : ''));
    if (!zona.aplicada) {
      console.error('  AVISO: no se pudo imponer la zona horaria. Las fechas pueden desplazarse un día.');
    }
  });

  // Apagado ordenado: el orquestador avisa con SIGTERM antes de matar el
  // proceso. Se dejan de aceptar conexiones, se terminan las que están en
  // curso (una marca, un pago) y se cierra la base.
  const apagar = (senal) => {
    console.log(`${senal} recibido: cerrando PharmaTalent...`);
    servidor.close(async () => {
      await mongoose.connection.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));
}).catch(err => {
  console.error('Error al conectar a MongoDB:', err.message);
  process.exit(1);
});

// Un error que nadie atrapó deja el proceso en un estado desconocido: se
// registra y se sale, para que el orquestador lo reinicie limpio
process.on('unhandledRejection', (motivo) => {
  console.error('Promesa rechazada sin manejar:', motivo);
});
process.on('uncaughtException', (err) => {
  console.error('Excepción no capturada:', err);
  process.exit(1);
});
