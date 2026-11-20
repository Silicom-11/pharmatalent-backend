# PharmaTalent · API (backend)

Sistema de gestión de recursos humanos para **InRetail Pharma S.A.** (Inkafarma y Mifarma):
turnos con validación de Químico Farmacéutico (D.S. 014-2011-SA), asistencia en el terminal
de cada botica, vacaciones (D.L. 713), planilla y boletas, contratos y ceses, evaluaciones,
capacitación, bienestar, selección, auditoría DIGEMID y mantenimiento del sistema.

Proyecto del curso **Herramientas de Desarrollo** — Universidad Tecnológica del Perú, 2026.
Equipo: Marc Andreessen Aquino Carhuas y Maciel Daniela Cataño Mendoza.
Docente: Mg. Ing. José Fernando Matos Vera.

La interfaz web está en el repositorio
[pharmatalent-frontend](https://github.com/Silicom-11/pharmatalent-frontend).

## Tecnología

| Capa | Herramienta |
|---|---|
| Entorno | Node.js 22 |
| API REST | Express 5 · 175 endpoints en 28 archivos de rutas |
| Base de datos | MongoDB 8.0 con Mongoose 9 (23 colecciones) |
| Seguridad | JWT, bcrypt, Helmet, CORS declarado, límite de intentos, 21 roles con alcance de datos |
| Pruebas | `node:test` (sin dependencias externas) |
| Integración continua | GitHub Actions (`.github/workflows/ci.yml`) |

## Puesta en marcha

Requisitos: Node.js 22 y MongoDB 8.0 en marcha.

```bash
npm install
cp .env.example .env      # completar los valores; el servidor se niega a arrancar si falta algo esencial
npm run seed              # datos de demostración (opcional)
npm run dev               # http://localhost:5000
```

La contraseña común de las cuentas de demostración se define en `CLAVE_DEMO` dentro de `.env`;
no está en el código porque el repositorio es público.

## Pruebas

| Comando | Qué ejecuta |
|---|---|
| `npm test` | 242 pruebas unitarias (caja negra, blanca y gris) |
| `npm run test:integracion` | 26 pruebas de integración incremental en 5 niveles, sobre una base propia de pruebas |
| `npm run test:funcional` | 22 casos funcionales (CP-01 a CP-22) con el sistema completo |
| `npm run carga` | Prueba de carga con 100 usuarios concurrentes (RNF1) |
| `npm run pruebas` | Regresión completa y registro del mantenimiento preventivo |
| `npm run auditoria` · `npm run privacidad` | Permisos y privacidad por rol (con el servidor en marcha) |

## Otros comandos

| Comando | Uso |
|---|---|
| `npm run respaldo` / `npm run restaurar` | Copia de seguridad de la base y su restauración |
| `npm run integridad` | Revisión de coherencia de los datos |
| `npm run preventivo` | Rutina de mantenimiento preventivo |
| `npm run crear-admin` | Primer administrador en una base de producción |
| `npm run exposicion` | Prepara la base de demostración para una exposición |

## Estructura

```
src/
  app.js          servidor Express
  config/         roles y permisos, jornadas, parámetros legales (RMV, UIT), mantenimiento
  models/         esquemas de Mongoose
  routes/         endpoints REST por módulo
  services/       reglas de negocio (planilla, turnos, aprobaciones, liquidación…)
  middleware/     autenticación, permisos, validación y manejo de errores
  validators/     esquemas de entrada (lista blanca de campos)
scripts/          datos, respaldos, pruebas funcionales y de carga, mantenimiento
tests/            pruebas unitarias y de integración
```

## Ramas y versiones

- `main`: versión estable; cada versión lleva su etiqueta (`v1.1.0`, `v1.1.1`…).
- `develop`: integración de los cambios antes de pasar a `main`.
- `feature/*`: un cambio por rama, fusionado en `develop` con `--no-ff`.

Cada cambio posterior a la puesta en marcha se registra como mantenimiento (`MNT-AAAA-NNN`)
en el propio sistema (Administración → Mantenimiento) y en [CHANGELOG.md](CHANGELOG.md).

## Licencia

Software propietario. Ver [LICENSE](LICENSE).
