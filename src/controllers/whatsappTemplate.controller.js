import { WhatsappTemplate } from '../models/WhatsappTemplate.js';
import { crudFactory } from '../utils/crudFactory.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok, created } from '../utils/apiResponse.js';
import { DEFAULT_WHATSAPP_TEMPLATES, TEMPLATE_STAGES } from '../config/whatsappTemplates.js';

const slug = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60);

// Gallabox template names are lowercase snake_case; normalise rather than
// reject so an agent pasting "Quotation Sent" still gets a usable name.
const normalizeName = (s) => slug(s);

const placeholdersIn = (body) => {
  const seen = [];
  for (const m of String(body || '').matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
};

// Keeps `variables` in step with the body: every placeholder gets a row
// (preserving the source already chosen for it) and rows for placeholders that
// were edited out are dropped, so the editor never shows a stale variable.
function syncVariables(body, variables = []) {
  const byName = new Map((variables || []).map((v) => [v.name, v]));
  return placeholdersIn(body).map((name) => {
    const existing = byName.get(name);
    return {
      name,
      source: existing?.source || 'manual',
      fallback: existing?.fallback || undefined,
    };
  });
}

// Normalises the scalar fields only. Variables are deliberately left alone
// here: create derives them from the body, while update has to merge them
// against what the template already had.
const normalizeFields = (body, req) => {
  const payload = { ...body };
  if (payload.label) payload.label = String(payload.label).trim();
  if (payload.name) payload.name = normalizeName(payload.name);
  if (payload.key) payload.key = slug(payload.key);
  // A new template with no key gets one from its label.
  if (!payload.key && payload.label) payload.key = slug(payload.label);
  // An empty document kind means "no link needed" — store it as null rather
  // than '' so the enum accepts it.
  if (payload.needs) {
    payload.needs = {
      kind: payload.needs.kind || null,
      as: payload.needs.kind ? String(payload.needs.as || '').trim() : undefined,
    };
  }
  payload.updatedBy = req.user?._id;
  return payload;
};

const crud = crudFactory(WhatsappTemplate, {
  searchFields: ['label', 'name', 'key', 'body'],
  filterFields: ['stage'],
  sort: 'stage order label',
  beforeWrite: (body, req) => {
    const payload = normalizeFields(body, req);
    payload.variables = syncVariables(payload.body, body.variables);
    return payload;
  },
  injectOnCreate: (req) => ({ createdBy: req.user?._id, isSystem: false }),
});

// A duplicate key is a predictable conflict (two templates with the same
// label), so answer it as one instead of letting the index error bubble up.
const withKeyConflict = (handler) => asyncHandler(async (req, res, next) => {
  try {
    return await handler(req, res, next);
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict('A template with this key already exists — rename it or edit the existing one.');
    }
    throw err;
  }
});

export const listTemplates = crud.list;
export const getTemplate = crud.get;
export const createTemplate = withKeyConflict(crud.create);
export const removeTemplate = crud.remove;

// Updates go through the stored document rather than crud.update, because
// re-syncing the variables needs the sources already chosen for them: a PATCH
// that carries only a new `body` must keep `customer_name → guest_name`
// instead of silently resetting every mapping to manual.
export const updateTemplate = withKeyConflict(asyncHandler(async (req, res) => {
  const tpl = await WhatsappTemplate.findById(req.params.id);
  if (!tpl) throw ApiError.notFound('Template not found');

  const payload = normalizeFields(req.body, req);
  const nextBody = payload.body !== undefined ? payload.body : tpl.body;
  // Read the rows off the REQUEST, not the normalised payload: a body-only
  // edit sends no variables at all, and must keep the sources already stored.
  const baseVars = req.body.variables !== undefined ? req.body.variables : tpl.variables;

  for (const field of ['key', 'label', 'name', 'stage', 'body', 'description', 'order', 'isActive', 'needs']) {
    if (payload[field] !== undefined) tpl[field] = payload[field];
  }
  tpl.variables = syncVariables(nextBody, mergeVariables(tpl.variables, baseVars));
  tpl.updatedBy = req.user?._id;

  await tpl.save();
  return ok(res, tpl);
}));

// Caller rows take precedence, previous rows fill the gaps.
function mergeVariables(previous = [], incoming = []) {
  const merged = new Map((previous || []).map((v) => [v.name, { name: v.name, source: v.source, fallback: v.fallback }]));
  for (const v of incoming || []) {
    merged.set(v.name, { name: v.name, source: v.source || merged.get(v.name)?.source || 'manual', fallback: v.fallback });
  }
  return [...merged.values()];
}

// GET /api/whatsapp-templates/meta — stages + the starter catalog's keys, so
// the editor can show which defaults are still missing.
export const templateMeta = asyncHandler(async (req, res) =>
  ok(res, {
    stages: TEMPLATE_STAGES,
    defaults: DEFAULT_WHATSAPP_TEMPLATES.map((t) => ({ key: t.key, label: t.label, stage: t.stage })),
  })
);

// POST /api/whatsapp-templates/seed-defaults — add any starter template this
// organization doesn't have yet. Never overwrites an existing one, so it is
// safe to press twice and safe after the copy has been edited.
export const seedDefaults = asyncHandler(async (req, res) => {
  const existing = new Set((await WhatsappTemplate.find().select('key')).map((t) => t.key));
  const missing = DEFAULT_WHATSAPP_TEMPLATES.filter((t) => !existing.has(t.key));
  if (missing.length) {
    await WhatsappTemplate.insertMany(
      missing.map((t, i) => ({ ...t, order: i, isSystem: true, createdBy: req.user?._id })),
      // insertMany bypasses the document pre-save hooks but still runs the
      // tenantPlugin's insertMany stamp, so organization is set.
      { ordered: false }
    );
  }
  return created(res, { added: missing.length, keys: missing.map((t) => t.key) });
});

// POST /api/whatsapp-templates/:id/duplicate
export const duplicateTemplate = withKeyConflict(asyncHandler(async (req, res) => {
  const src = await WhatsappTemplate.findById(req.params.id);
  if (!src) throw ApiError.notFound('Template not found');
  const base = `${src.key}_copy`;
  let key = base;
  for (let n = 2; await WhatsappTemplate.exists({ key }); n += 1) key = `${base}_${n}`;
  const copy = await WhatsappTemplate.create({
    key,
    label: `${src.label} (copy)`,
    name: src.name,
    stage: src.stage,
    body: src.body,
    variables: src.variables,
    needs: src.needs,
    description: src.description,
    order: (src.order || 0) + 1,
    isActive: false, // a copy starts switched off so it can't be sent half-edited
    isSystem: false,
    createdBy: req.user?._id,
  });
  return created(res, copy);
}));

// Seeds the starter catalog for a brand-new organization. Called from the
// master-data seeder, which already runs inside the org's tenant context.
export async function seedWhatsappTemplates() {
  const existing = new Set((await WhatsappTemplate.find().select('key')).map((t) => t.key));
  const missing = DEFAULT_WHATSAPP_TEMPLATES.filter((t) => !existing.has(t.key));
  if (!missing.length) return 0;
  await WhatsappTemplate.insertMany(
    missing.map((t, i) => ({ ...t, order: i, isSystem: true })),
    { ordered: false }
  );
  return missing.length;
}
