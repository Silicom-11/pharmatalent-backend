const router = require('express').Router();
const Mantenimiento = require('../models/Mantenimiento');
const ErrorSistema = require('../models/ErrorSistema');
const Usuario = require('../models/Usuario');
const Notificacion = require('../models/Notificacion');
const { auth } = require('../middleware/auth');
const { permit } = require('../middleware/scopeByRole');
const { validarCuerpo, validarId } = require('../middleware/validar');
const { paginacionDe } = require('../middleware/paginacion');
const { patronDeBusqueda } = require('../utils/busqueda');
const esq = require('../validators/esquemas');
const M = require('../config/mantenimiento');
const { estadoDelSistema, VERSION } = require('../services/salud');

const TIPO = Object.fromEntries(M.TIPOS_CODIGOS.map((t) => [t, t]));

/**
 * Fase de mantenimiento (GP 08).
 *
 *   Para todos
 *     GET  /catalogo              tipos, etapas, prioridades, áreas y plan preventivo
 *     POST /reportes              reportar un error o sugerir una mejora
 *     GET  /mis-reportes          lo que uno reportó y en qué etapa va
 *
 *   Administración (módulo «mantenimiento»)
 *     GET  /  · /resumen · /salud · /errores · /:id
 *     POST /                      registrar un mantenimiento de cualquier tipo
 *     PUT  /:id                   completar análisis, solución, pruebas, versión
 *     POST /:id/avanzar           pasar a la etapa siguiente del proceso
 *     POST /:id/descartar         no procede (no es un error, ya resuelto…)
 *     POST /errores/:id/registrar convertir un error del monitoreo en correctivo
 */

router.use(auth);

const quien = (req) => req.usuario.correo;
const paso = (req, accion, nota, etapa) => ({ etapa, accion, nota, por: req.usuario._id, porNombre: quien(req), en: new Date() });

/** Avisa sin que un aviso fallido tumbe la operación */
async function avisar(usuarios, titulo, mensaje, registro, prioridad = 'MEDIA') {
  const lista = usuarios.filter(Boolean);
  if (!lista.length) return;
  await Notificacion.insertMany(lista.map((usuario) => ({
    usuario, tipo: 'SISTEMA', titulo, mensaje, prioridad,
    modeloRelacionado: 'Mantenimiento', idRelacionado: registro._id,
  }))).catch(() => {});
}

async function administradores() {
  return (await Usuario.find({ rol: 'ADMIN', activo: true }).select('_id').lean()).map((u) => u._id);
}

/** Lo que la pantalla necesita para mostrar el proceso */
function conEtapas(r) {
  const etapas = M.etapasDe(r.tipo);
  return {
    ...r,
    etapas,
    etapaActual: etapas[r.etapa] || null,
    progreso: Math.round((Math.min(r.etapa, etapas.length) / etapas.length) * 100),
    vencido: ['ABIERTO', 'EN_CURSO'].includes(r.estado) && r.fechaLimite && new Date(r.fechaLimite) < new Date(),
  };
}

// ─── Para todos ──────────────────────────────────────────────────────────────

router.get('/catalogo', (_req, res) => {
  res.json({
    version: VERSION,
    tipos: M.TIPOS, prioridades: M.PRIORIDADES, origenes: M.ORIGENES,
    areas: M.AREAS, estados: M.ESTADOS, plan: M.PLAN_PREVENTIVO,
  });
});

router.post('/reportes', validarCuerpo(esq.mantenimientoReportar), async (req, res, next) => {
  try {
    const { tipo, titulo, descripcion, area, prioridad, pagina, incidencia } = req.body;
    const nivel = prioridad || (tipo === 'PERFECTIVO' ? 'BAJA' : 'MEDIA');
    const registro = await Mantenimiento.create({
      tipo, titulo, descripcion,
      area: area || 'general',
      prioridad: nivel,
      origen: 'USUARIO',
      reportadoPor: req.usuario._id,
      contexto: {
        pagina,
        incidencia: incidencia ? incidencia.toUpperCase() : undefined,
        navegador: String(req.headers['user-agent'] || '').slice(0, 200),
        versionSistema: VERSION,
      },
      fechaLimite: M.fechaLimiteDe(nivel),
      historial: [paso(req, 'REGISTRO', tipo === 'PERFECTIVO' ? 'Sugerencia de mejora recibida' : 'Informe de error recibido', 0)],
    });
    // Si trae el código que mostró el error, el reporte y el registro técnico quedan unidos
    if (registro.contexto.incidencia) {
      await ErrorSistema.updateMany({ incidencia: registro.contexto.incidencia }, { mantenimiento: registro._id, atendido: true });
    }
    await avisar(
      await administradores(),
      `${tipo === 'PERFECTIVO' ? 'Sugerencia' : 'Reporte de error'} ${registro.codigo}`,
      `${quien(req)}: ${titulo}`,
      registro,
      ['CRITICA', 'ALTA'].includes(nivel) ? 'ALTA' : 'MEDIA',
    );
    res.status(201).json({ codigo: registro.codigo, _id: registro._id, estado: registro.estado, fechaLimite: registro.fechaLimite });
  } catch (err) { next(err); }
});

router.get('/mis-reportes', async (req, res, next) => {
  try {
    const propios = await Mantenimiento.find({ reportadoPor: req.usuario._id })
      .select('codigo tipo titulo estado etapa prioridad creadoEn cerradoEn solucion motivoDescarte fechaLimite')
      .sort({ creadoEn: -1 }).limit(30).lean();
    res.json(propios.map((r) => {
      const c = conEtapas(r);
      // Quien reporta ve en qué va y, al cerrarse, cómo se resolvió; el análisis técnico no
      return {
        _id: r._id, codigo: r.codigo, tipo: r.tipo, titulo: r.titulo, estado: r.estado,
        etapa: r.etapa, etapaActual: c.etapaActual?.etiqueta || (r.estado === 'CERRADO' ? 'Cerrado' : null),
        totalEtapas: c.etapas.length, progreso: c.progreso, creadoEn: r.creadoEn, cerradoEn: r.cerradoEn,
        solucion: r.estado === 'CERRADO' ? r.solucion : undefined,
        motivoDescarte: r.estado === 'DESCARTADO' ? r.motivoDescarte : undefined,
      };
    }));
  } catch (err) { next(err); }
});

// ─── Administración ──────────────────────────────────────────────────────────

router.get('/', permit('mantenimiento', 'read'), async (req, res, next) => {
  try {
    const { tipo, estado, prioridad, origen, q } = req.query;
    const { page, limit, skip } = paginacionDe(req.query);
    const filtro = {};
    if (M.TIPOS_CODIGOS.includes(tipo)) filtro.tipo = tipo;
    if (estado === 'PENDIENTES') filtro.estado = { $in: ['ABIERTO', 'EN_CURSO'] };
    else if (M.ESTADOS.includes(estado)) filtro.estado = estado;
    if (M.PRIORIDADES[prioridad]) filtro.prioridad = prioridad;
    if (M.ORIGENES[origen]) filtro.origen = origen;
    const patron = patronDeBusqueda(q);
    if (patron) filtro.$or = [{ titulo: patron }, { codigo: patron }, { descripcion: patron }];

    const [lista, total] = await Promise.all([
      Mantenimiento.find(filtro)
        .select('-historial -contexto.navegador')
        .populate('reportadoPor', 'correo rol')
        .populate('responsable', 'correo')
        .sort({ creadoEn: -1 }).skip(skip).limit(limit).lean(),
      Mantenimiento.countDocuments(filtro),
    ]);
    res.json({ data: lista.map(conEtapas), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

router.get('/resumen', permit('mantenimiento', 'read'), async (_req, res, next) => {
  try {
    const [porTipo, porPrioridad, cerrados, vencidos] = await Promise.all([
      Mantenimiento.aggregate([{ $group: { _id: { tipo: '$tipo', estado: '$estado' }, total: { $sum: 1 } } }]),
      Mantenimiento.aggregate([
        { $match: { estado: { $in: ['ABIERTO', 'EN_CURSO'] } } },
        { $group: { _id: '$prioridad', total: { $sum: 1 } } },
      ]),
      // Tiempo medio de atención: de recibido a cerrado
      Mantenimiento.aggregate([
        { $match: { estado: 'CERRADO', cerradoEn: { $ne: null } } },
        { $group: { _id: '$tipo', dias: { $avg: { $divide: [{ $subtract: ['$cerradoEn', '$creadoEn'] }, 86400000] } }, total: { $sum: 1 } } },
      ]),
      Mantenimiento.countDocuments({ estado: { $in: ['ABIERTO', 'EN_CURSO'] }, fechaLimite: { $lt: new Date() } }),
    ]);
    const tipos = Object.fromEntries(M.TIPOS_CODIGOS.map((t) => [t, { ABIERTO: 0, EN_CURSO: 0, CERRADO: 0, DESCARTADO: 0, total: 0 }]));
    for (const g of porTipo) {
      tipos[g._id.tipo][g._id.estado] = g.total;
      tipos[g._id.tipo].total += g.total;
    }
    res.json({
      porTipo: tipos,
      pendientesPorPrioridad: Object.fromEntries(porPrioridad.map((p) => [p._id, p.total])),
      tiempoMedioDias: Object.fromEntries(cerrados.map((c) => [c._id, Math.round(c.dias * 10) / 10])),
      vencidos,
    });
  } catch (err) { next(err); }
});

router.get('/salud', permit('mantenimiento', 'read'), async (_req, res, next) => {
  try {
    res.json(await estadoDelSistema());
  } catch (err) { next(err); }
});

router.get('/errores', permit('mantenimiento', 'read'), async (req, res, next) => {
  try {
    const { page, limit, skip } = paginacionDe(req.query);
    const filtro = req.query.atendido === 'false' ? { atendido: false } : {};
    const [lista, total] = await Promise.all([
      ErrorSistema.find(filtro).select('-pila').populate('usuario', 'correo').populate('mantenimiento', 'codigo estado')
        .sort({ creadoEn: -1 }).skip(skip).limit(limit).lean(),
      ErrorSistema.countDocuments(filtro),
    ]);
    res.json({ data: lista, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

/** Del monitoreo al proceso correctivo: el error pasa a ser una solicitud */
router.post('/errores/:id/registrar', validarId(), permit('mantenimiento', 'write'), async (req, res, next) => {
  try {
    const error = await ErrorSistema.findById(req.params.id);
    if (!error) return res.status(404).json({ error: 'Error no encontrado' });
    if (error.mantenimiento) {
      const ya = await Mantenimiento.findById(error.mantenimiento).select('codigo').lean();
      return res.status(409).json({ error: `Este error ya está en el mantenimiento ${ya?.codigo || 'registrado'}` });
    }
    const repeticiones = await ErrorSistema.countDocuments({ metodo: error.metodo, ruta: error.ruta, mensaje: error.mensaje });
    const registro = await Mantenimiento.create({
      tipo: TIPO.CORRECTIVO,
      titulo: `Error inesperado en ${error.metodo} ${error.ruta}`.slice(0, 160),
      descripcion: `Detectado por el monitoreo de errores (incidencia ${error.incidencia}, ${repeticiones} vez/veces). Mensaje: ${error.mensaje || '—'}`,
      area: 'general',
      prioridad: repeticiones >= 5 ? 'ALTA' : 'MEDIA',
      origen: 'MONITOREO',
      reportadoPor: req.usuario._id,
      contexto: { incidencia: error.incidencia, pagina: error.ruta, versionSistema: VERSION },
      fechaLimite: M.fechaLimiteDe(repeticiones >= 5 ? 'ALTA' : 'MEDIA'),
      historial: [paso(req, 'REGISTRO', 'Registrado desde el monitoreo de errores', 0)],
    });
    await ErrorSistema.updateMany({ metodo: error.metodo, ruta: error.ruta, mensaje: error.mensaje }, { mantenimiento: registro._id, atendido: true });
    res.status(201).json(conEtapas(registro.toObject()));
  } catch (err) { next(err); }
});

router.get('/:id', validarId(), permit('mantenimiento', 'read'), async (req, res, next) => {
  try {
    const registro = await Mantenimiento.findById(req.params.id)
      .populate('reportadoPor', 'correo rol')
      .populate('responsable', 'correo').lean();
    if (!registro) return res.status(404).json({ error: 'Mantenimiento no encontrado' });
    res.json(conEtapas(registro));
  } catch (err) { next(err); }
});

router.post('/', permit('mantenimiento', 'write'), validarCuerpo(esq.mantenimientoCrear), async (req, res, next) => {
  try {
    const prioridad = req.body.prioridad || 'MEDIA';
    const registro = await Mantenimiento.create({
      ...req.body,
      prioridad,
      origen: req.body.origen || (req.body.tipo === 'PREVENTIVO' ? 'PLAN' : 'EQUIPO'),
      reportadoPor: req.usuario._id,
      contexto: { versionSistema: VERSION },
      fechaLimite: M.fechaLimiteDe(prioridad),
      historial: [paso(req, 'REGISTRO', 'Registrado por el equipo', 0)],
    });
    res.status(201).json(conEtapas(registro.toObject()));
  } catch (err) { next(err); }
});

router.put('/:id', validarId(), permit('mantenimiento', 'write'), validarCuerpo(esq.mantenimientoEditar), async (req, res, next) => {
  try {
    const registro = await Mantenimiento.findById(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Mantenimiento no encontrado' });
    if (['CERRADO', 'DESCARTADO'].includes(registro.estado)) {
      return res.status(400).json({ error: `El mantenimiento está ${registro.estado.toLowerCase()}: su documentación ya no se modifica.` });
    }
    // El tipo sólo se corrige al recibirlo: un «error» que resulta ser una mejora
    if (req.body.tipo && req.body.tipo !== registro.tipo && registro.etapa > 0) {
      return res.status(400).json({ error: 'El tipo sólo puede cambiarse en la primera etapa, antes de empezar el proceso.' });
    }
    const cambiados = [];
    for (const [campo, valor] of Object.entries(req.body)) {
      if (JSON.stringify(registro[campo]) === JSON.stringify(valor)) continue;
      registro[campo] = valor;
      cambiados.push(campo);
    }
    if (req.body.prioridad && cambiados.includes('prioridad')) registro.fechaLimite = M.fechaLimiteDe(req.body.prioridad, registro.creadoEn);
    if (cambiados.length) {
      registro.historial.push(paso(req, 'EDICION', `Actualizado: ${cambiados.join(', ')}`, registro.etapa));
      await registro.save();
    }
    res.json(conEtapas(registro.toObject()));
  } catch (err) { next(err); }
});

router.post('/:id/avanzar', validarId(), permit('mantenimiento', 'write'), validarCuerpo(esq.mantenimientoAvanzar), async (req, res, next) => {
  try {
    const registro = await Mantenimiento.findById(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Mantenimiento no encontrado' });
    const { nota, analisis, solucion, pruebas, version } = req.body;
    // Lo que la etapa produce puede escribirse en el mismo paso
    for (const [campo, valor] of Object.entries({ analisis, solucion, pruebas, version })) {
      if (valor) registro[campo] = valor;
    }
    const motivo = M.motivoParaNoAvanzar(registro);
    if (motivo) return res.status(400).json({ error: motivo });

    const etapas = M.etapasDe(registro.tipo);
    const cerrada = etapas[registro.etapa];
    registro.etapa += 1;
    registro.estado = M.estadoDeEtapa(registro.tipo, registro.etapa);
    if (!registro.responsable) registro.responsable = req.usuario._id;
    const cierra = registro.estado === 'CERRADO';
    if (cierra) registro.cerradoEn = new Date();
    registro.historial.push(paso(req, cierra ? 'CIERRE' : 'AVANCE', `${cerrada.etiqueta}: ${nota}`, registro.etapa - 1));
    await registro.save();

    if (cierra && registro.reportadoPor && String(registro.reportadoPor) !== String(req.usuario._id)) {
      await avisar([registro.reportadoPor], `Su reporte ${registro.codigo} fue resuelto`,
        registro.solucion ? `${registro.titulo}. Solución: ${registro.solucion.slice(0, 240)}` : registro.titulo, registro);
    }
    res.json(conEtapas(registro.toObject()));
  } catch (err) { next(err); }
});

router.post('/:id/descartar', validarId(), permit('mantenimiento', 'write'), validarCuerpo(esq.mantenimientoDescartar), async (req, res, next) => {
  try {
    const registro = await Mantenimiento.findById(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Mantenimiento no encontrado' });
    if (['CERRADO', 'DESCARTADO'].includes(registro.estado)) {
      return res.status(400).json({ error: `El mantenimiento ya está ${registro.estado.toLowerCase()}.` });
    }
    registro.estado = 'DESCARTADO';
    registro.motivoDescarte = req.body.motivo;
    registro.cerradoEn = new Date();
    registro.historial.push(paso(req, 'DESCARTE', req.body.motivo, registro.etapa));
    await registro.save();
    if (registro.reportadoPor && String(registro.reportadoPor) !== String(req.usuario._id)) {
      await avisar([registro.reportadoPor], `Su reporte ${registro.codigo} fue revisado`, `No procede: ${req.body.motivo}`, registro, 'BAJA');
    }
    res.json(conEtapas(registro.toObject()));
  } catch (err) { next(err); }
});

module.exports = router;
