import { asyncHandler } from './asyncHandler.js';
import { ApiError } from './ApiError.js';
import { ok, created, paginate } from './apiResponse.js';

/**
 * Builds standard list/get/create/update/remove handlers for a Mongoose model.
 *
 * @param {import('mongoose').Model} Model
 * @param {object} opts
 * @param {string[]} [opts.searchFields]  fields matched (case-insensitive) by ?search=
 * @param {string}   [opts.sort]          default sort (default '-createdAt')
 * @param {function} [opts.beforeWrite]   (body, req) => body  — mutate/augment payload
 * @param {Array}    [opts.populate]      populate spec(s) applied to list/get/create/update
 * @param {string[]} [opts.filterFields]  query params copied verbatim into the filter (exact match)
 * @param {function} [opts.advancedFilter] (query) => mongoFilter — extra filter merged into list/count
 * @param {function} [opts.onChange]      (req, doc, action) => void — called after create/update/remove (action: 'created'|'updated'|'deleted')
 */
export function crudFactory(Model, opts = {}) {
  const {
    searchFields = ['name'],
    sort = '-createdAt',
    beforeWrite,
    populate,
    filterFields = [],
    injectOnCreate,
    advancedFilter,
    onChange,
  } = opts;
  const withPopulate = (q) => (populate ? q.populate(populate) : q);
  const fireChange = async (req, doc, action) => {
    if (!onChange || !doc) return;
    try { await onChange(req, doc, action); } catch { /* audit is non-fatal */ }
  };

  const buildFilter = (query) => {
    const filter = {};
    if (query.search && searchFields.length) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = searchFields.map((f) => ({ [f]: rx }));
    }
    // isActive=true → everything not explicitly disabled (legacy rows lack the field);
    // isActive=false → only disabled rows.
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true' ? { $ne: false } : false;
    for (const f of filterFields) {
      if (query[f] !== undefined && query[f] !== '') filter[f] = query[f];
    }
    if (advancedFilter) Object.assign(filter, advancedFilter(query));
    return filter;
  };

  return {
    list: asyncHandler(async (req, res) => {
      const filter = buildFilter(req.query);
      const total = await Model.countDocuments(filter);
      const meta = paginate(req.query, total);
      const items = await withPopulate(
        Model.find(filter).sort(sort).skip(meta.skip).limit(meta.limit)
      );
      return ok(res, await items, meta);
    }),

    get: asyncHandler(async (req, res) => {
      const item = await withPopulate(Model.findById(req.params.id));
      if (!item) throw ApiError.notFound(`${Model.modelName} not found`);
      return ok(res, item);
    }),

    create: asyncHandler(async (req, res) => {
      let payload = beforeWrite ? beforeWrite(req.body, req) : req.body;
      if (injectOnCreate) payload = { ...payload, ...injectOnCreate(req) };
      let item = await Model.create(payload);
      if (populate) item = await item.populate(populate);
      await fireChange(req, item, 'created');
      return created(res, item);
    }),

    update: asyncHandler(async (req, res) => {
      const payload = beforeWrite ? beforeWrite(req.body, req) : req.body;
      const item = await withPopulate(
        Model.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true })
      );
      if (!item) throw ApiError.notFound(`${Model.modelName} not found`);
      await fireChange(req, item, 'updated');
      return ok(res, item);
    }),

    remove: asyncHandler(async (req, res) => {
      const item = await Model.findByIdAndDelete(req.params.id);
      if (!item) throw ApiError.notFound(`${Model.modelName} not found`);
      await fireChange(req, item, 'deleted');
      return ok(res, { id: req.params.id });
    }),
  };
}
