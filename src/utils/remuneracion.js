const { can } = require('../config/roles');

/**
 * Qué parte del legajo no viaja fuera del área que la administra.
 *
 * El alcance por rol filtra QUÉ REGISTROS ve cada uno, pero no qué campos. Sin
 * esto, un Químico Farmacéutico —que lee `employees` para saber quién compone
 * su turno— recibía también el sueldo, la cuenta bancaria y el historial
 * salarial de sus compañeros de botica. Lo mismo el Jefe de Local y el
 * Coordinador de Rutas: trece roles leen el legajo y sólo cuatro administran
 * remuneraciones.
 *
 * El criterio es el módulo de planilla: quien no puede abrir `payroll` no
 * tiene por qué saber lo que gana nadie. La Ley 29733 pide que el acceso al
 * dato personal se limite a la finalidad que lo justifica, y la finalidad de
 * consultar el equipo de un local es saber quién lo compone, no cuánto cobra.
 *
 * `cuentaBancaria` y `cuspp` ya figuraban entre los campos que la bitácora se
 * niega a escribir; que salieran por la API era el hueco que faltaba cerrar.
 */
const CAMPOS_RESERVADOS = [
  'sueldoBasico',
  'historialSueldos',
  'cuentaBancaria',
  'cuspp',
  'sistemaPensiones',
];

/** ¿Este rol administra remuneraciones? */
const veRemuneracion = (rol) => can(rol, 'payroll', 'read');

/**
 * Proyección de Mongoose para una consulta de empleados.
 * Devuelve null cuando el rol sí puede verlo todo, para no encadenar un
 * `.select()` vacío.
 */
const proyeccionEmpleado = (rol) =>
  (veRemuneracion(rol) ? null : CAMPOS_RESERVADOS.map((c) => `-${c}`).join(' '));

/**
 * Quita los campos reservados de un documento ya leído.
 *
 * Hace falta además de la proyección porque algunas respuestas se arman con
 * documentos que vienen de otra consulta —el expediente, por ejemplo— y ahí no
 * hay un `.select()` donde engancharse.
 */
function sinRemuneracion(rol, documento) {
  if (!documento || veRemuneracion(rol)) return documento;
  const plano = typeof documento.toObject === 'function' ? documento.toObject() : { ...documento };
  for (const campo of CAMPOS_RESERVADOS) delete plano[campo];
  return plano;
}

/**
 * Los montos de una liquidación salen del sueldo: quien no administra
 * remuneraciones ve el estado y los plazos de un cese, no cuánto se paga.
 */
const MONTOS_LIQUIDACION = ['remuneracionComputable', 'conceptos', 'descuentos', 'rentaQuinta', 'totales', 'parametrosVigentes'];
const proyeccionLiquidacion = (rol) =>
  (veRemuneracion(rol) ? null : MONTOS_LIQUIDACION.map((c) => `-${c}`).join(' '));
/** El sueldo pactado en el contrato, igual que el del legajo */
const proyeccionContrato = (rol) => (veRemuneracion(rol) ? null : '-sueldo -historialRenovaciones.sueldo');

module.exports = {
  CAMPOS_RESERVADOS, veRemuneracion, proyeccionEmpleado, sinRemuneracion,
  MONTOS_LIQUIDACION, proyeccionLiquidacion, proyeccionContrato,
};
