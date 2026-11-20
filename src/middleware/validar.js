const mongoose = require('mongoose');

/**
 * Validación y saneamiento del cuerpo de las peticiones.
 *
 * Cumple dos funciones que suelen confundirse:
 *
 *  1. Rechazar lo que no tiene forma válida, con un mensaje que la persona
 *     pueda entender y corregir.
 *  2. Descartar lo que no fue declarado. Esto último importa más de lo que
 *     parece: sin lista blanca, un `Object.assign(doc, req.body)` deja que
 *     quien puede editar una boleta le cambie el estado a PAGADO sin pasar por
 *     la aprobación. Aquí el campo que no está en el esquema no llega al modelo.
 *
 * El esquema se escribe en forma compacta para que la ruta siga leyéndose:
 *
 *   validarCuerpo({
 *     employee:  'id!',
 *     startDate: 'fecha!',          // 'fechaPasada' si no puede ser futura
 *     type:      ['enum!', ['INDEFINIDO', 'PLAZO_FIJO']],
 *     salary:    'monto!',
 *     notes:     'texto:0..500',
 *   })
 *
 * El signo `!` marca lo obligatorio; `:min..max` acota longitud o rango.
 */

const ES_OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const ES_PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
const ES_FECHA = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
const ES_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const ES_DNI = /^\d{8}$/;
const ES_RUC = /^(10|15|17|20)\d{9}$/;
const ES_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Un celular peruano: 9 dígitos empezando en 9
const ES_CELULAR = /^9\d{8}$/;

const LARGO_TEXTO_POR_DEFECTO = 2000;

/** Descompone `'texto!:1..200'` en sus partes */
function leerSpec(spec) {
  if (Array.isArray(spec)) {
    const [cabeza, extra] = spec;
    return { ...leerSpec(cabeza), valores: extra };
  }
  const m = String(spec).match(/^([a-zA-Zñ]+)(!?)(?::(-?[\d.]+)?\.\.(-?[\d.]+)?)?$/);
  if (!m) throw new Error(`Especificación de validación no reconocida: «${spec}»`);
  const [, tipo, obligatorio, min, max] = m;
  return {
    tipo,
    obligatorio: obligatorio === '!',
    min: min === undefined || min === '' ? undefined : Number(min),
    max: max === undefined || max === '' ? undefined : Number(max),
  };
}

/**
 * Comprueba y normaliza un valor.
 * Devuelve `{ valor }` si pasa, o `{ error }` con el motivo en castellano.
 */
function revisar(nombre, valor, regla) {
  const { tipo, min, max, valores } = regla;
  const entre = (n) =>
    (min !== undefined && n < min) || (max !== undefined && n > max);

  switch (tipo) {
    case 'id': {
      const t = String(valor);
      if (!ES_OBJECT_ID.test(t)) return { error: `«${nombre}» no es un identificador válido` };
      return { valor: new mongoose.Types.ObjectId(t) };
    }

    case 'texto': {
      if (typeof valor === 'number' || typeof valor === 'boolean') valor = String(valor);
      if (typeof valor !== 'string') return { error: `«${nombre}» debe ser texto` };
      const t = valor.trim();
      const tope = max ?? LARGO_TEXTO_POR_DEFECTO;
      if (min !== undefined && t.length < min) {
        return { error: `«${nombre}» debe tener al menos ${min} caracteres` };
      }
      if (t.length > tope) {
        return { error: `«${nombre}» no puede superar ${tope} caracteres` };
      }
      return { valor: t };
    }

    case 'entero': {
      const n = Number(valor);
      if (!Number.isInteger(n)) return { error: `«${nombre}» debe ser un número entero` };
      if (entre(n)) return { error: `«${nombre}» debe estar entre ${min ?? '−∞'} y ${max ?? '∞'}` };
      return { valor: n };
    }

    case 'decimal': {
      const n = Number(valor);
      if (!Number.isFinite(n)) return { error: `«${nombre}» debe ser un número` };
      if (entre(n)) return { error: `«${nombre}» debe estar entre ${min ?? '−∞'} y ${max ?? '∞'}` };
      return { valor: n };
    }

    case 'monto': {
      const n = Number(valor);
      if (!Number.isFinite(n)) return { error: `«${nombre}» debe ser un importe` };
      if (n < 0) return { error: `«${nombre}» no puede ser negativo` };
      if (max !== undefined && n > max) return { error: `«${nombre}» supera el máximo permitido` };
      // Los importes se guardan con dos decimales: son soles, no fracciones
      return { valor: Math.round(n * 100) / 100 };
    }

    case 'booleano': {
      if (typeof valor === 'boolean') return { valor };
      if (valor === 'true' || valor === 'false') return { valor: valor === 'true' };
      return { error: `«${nombre}» debe ser verdadero o falso` };
    }

    case 'fecha': {
      if (valor instanceof Date) {
        return Number.isNaN(valor.getTime()) ? { error: `«${nombre}» no es una fecha válida` } : { valor };
      }
      if (typeof valor !== 'string' || !ES_FECHA.test(valor)) {
        return { error: `«${nombre}» debe tener el formato AAAA-MM-DD` };
      }
      // Se ancla al día local: en UTC-5 el texto plano retrocedería un día
      const [a, m, d] = valor.slice(0, 10).split('-').map(Number);
      const f = new Date(a, m - 1, d);
      if (Number.isNaN(f.getTime()) || f.getMonth() !== m - 1 || f.getDate() !== d) {
        return { error: `«${nombre}» no corresponde a una fecha real` };
      }
      return { valor: f };
    }

    case 'fechaPasada': {
      // Una fecha que ya llegó: un ingreso registrado a futuro deja a alguien
      // ACTIVO antes de empezar a trabajar
      const r = revisar(nombre, valor, { ...regla, tipo: 'fecha' });
      if (r.error) return r;
      const finDeHoy = new Date();
      finDeHoy.setHours(23, 59, 59, 999);
      return r.valor > finDeHoy ? { error: `«${nombre}» no puede ser una fecha futura` } : r;
    }

    case 'periodo': {
      if (typeof valor !== 'string' || !ES_PERIODO.test(valor)) {
        return { error: `«${nombre}» debe tener el formato AAAA-MM` };
      }
      return { valor };
    }

    case 'hora': {
      if (typeof valor !== 'string' || !ES_HORA.test(valor)) {
        return { error: `«${nombre}» debe tener el formato HH:MM` };
      }
      return { valor };
    }

    case 'correo': {
      const t = String(valor).trim().toLowerCase();
      if (!ES_CORREO.test(t)) return { error: `«${nombre}» no es un correo válido` };
      return { valor: t };
    }

    case 'dni': {
      const t = String(valor).trim();
      if (!ES_DNI.test(t)) return { error: `«${nombre}» debe tener 8 dígitos` };
      return { valor: t };
    }

    case 'ruc': {
      const t = String(valor).trim();
      if (!ES_RUC.test(t)) return { error: `«${nombre}» debe ser un RUC de 11 dígitos` };
      return { valor: t };
    }

    case 'celular': {
      const t = String(valor).replace(/[\s-]/g, '');
      if (!ES_CELULAR.test(t)) return { error: `«${nombre}» debe ser un celular de 9 dígitos que empiece en 9` };
      return { valor: t };
    }

    case 'enum': {
      if (!Array.isArray(valores)) throw new Error(`«${nombre}» declara enum sin lista de valores`);
      const t = String(valor);
      if (!valores.includes(t)) {
        return { error: `«${nombre}» debe ser uno de: ${valores.join(', ')}` };
      }
      return { valor: t };
    }

    case 'lista': {
      if (!Array.isArray(valor)) return { error: `«${nombre}» debe ser una lista` };
      if (min !== undefined && valor.length < min) {
        return { error: `«${nombre}» debe tener al menos ${min} elemento(s)` };
      }
      const tope = max ?? 500;
      if (valor.length > tope) return { error: `«${nombre}» no puede tener más de ${tope} elementos` };

      const reglaHija = typeof valores === 'string' || Array.isArray(valores)
        ? leerSpec(valores)
        : { tipo: 'texto' };
      const limpia = [];
      for (let i = 0; i < valor.length; i++) {
        const r = revisar(`${nombre}[${i}]`, valor[i], reglaHija);
        if (r.error) return r;
        limpia.push(r.valor);
      }
      return { valor: limpia };
    }

    case 'objeto': {
      if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
        return { error: `«${nombre}» debe ser un objeto` };
      }
      // Con esquema hijo se valida en profundidad; sin él se acepta tal cual
      if (valores && typeof valores === 'object') {
        const { datos, error } = aplicar(valor, valores, nombre);
        return error ? { error } : { valor: datos };
      }
      return { valor };
    }

    default:
      throw new Error(`Tipo de validación desconocido: «${tipo}»`);
  }
}

/** Recorre el esquema y devuelve sólo los campos declarados, ya normalizados */
function aplicar(cuerpo, esquema, prefijo = '') {
  const datos = {};
  const fuente = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};

  for (const [nombre, spec] of Object.entries(esquema)) {
    const regla = leerSpec(spec);
    const etiqueta = prefijo ? `${prefijo}.${nombre}` : nombre;
    const valor = fuente[nombre];
    const ausente = valor === undefined || valor === null || valor === '';

    if (ausente) {
      if (regla.obligatorio) return { error: `Falta «${etiqueta}»` };
      continue;   // opcional y no vino: no se toca
    }

    const r = revisar(etiqueta, valor, regla);
    if (r.error) return { error: r.error };
    datos[nombre] = r.valor;
  }

  return { datos };
}

/**
 * Middleware: valida `req.body` contra el esquema y lo REEMPLAZA por la
 * versión saneada. Lo no declarado se descarta antes de llegar a la ruta.
 */
function validarCuerpo(esquema) {
  return (req, res, next) => {
    const { datos, error } = aplicar(req.body, esquema);
    if (error) return res.status(400).json({ error });

    // Se conserva lo descartado por si la ruta quiere avisar de algo ignorado
    const descartados = Object.keys(req.body || {}).filter((k) => !(k in esquema));
    req.descartados = descartados;
    req.body = datos;
    next();
  };
}

/** Igual, pero sobre los parámetros de consulta */
function validarConsulta(esquema) {
  return (req, res, next) => {
    const { datos, error } = aplicar(req.query, esquema);
    if (error) return res.status(400).json({ error });
    req.filtros = datos;
    next();
  };
}

/** Comprueba que `:id` (u otro parámetro) sea un ObjectId antes de tocar la base */
function validarId(nombre = 'id') {
  return (req, res, next) => {
    const valor = req.params[nombre];
    if (!ES_OBJECT_ID.test(String(valor))) {
      return res.status(400).json({ error: `El identificador «${valor}» no es válido` });
    }
    next();
  };
}

module.exports = {
  validarCuerpo,
  validarConsulta,
  validarId,
  aplicar,
  leerSpec,
  revisar,
  patrones: { ES_OBJECT_ID, ES_PERIODO, ES_FECHA, ES_HORA, ES_DNI, ES_RUC, ES_CORREO, ES_CELULAR },
};
