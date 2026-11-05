import { Activity } from '../models/Activity.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';

// Fire-and-forget audit logger — never throws into the caller's flow.
export async function logActivity(queryId, userId, message, type = 'note') {
  try {
    if (queryId && message) await Activity.create({ query: queryId, user: userId, message, type });
  } catch {
    /* non-fatal */
  }
}

// Generic entity audit logger (e.g. transport services).
export async function logEntityActivity(entityType, entityId, userId, message, type = 'note') {
  try {
    if (entityType && entityId && message) {
      await Activity.create({ entityType, entity: entityId, user: userId, message, type });
    }
  } catch {
    /* non-fatal */
  }
}

// GET /api/activity-log?query=<id>  or  ?entityType=transport&entity=<id>
export const listActivities = asyncHandler(async (req, res) => {
  const { query, entityType, entity, transport } = req.query;
  let filter;
  if (query) filter = { query };
  else if (transport) filter = { entityType: 'transport', entity: transport };
  else if (entityType && entity) filter = { entityType, entity };
  else throw ApiError.badRequest('query or entity id is required');
  const items = await Activity.find(filter).populate('user', 'name').sort('-createdAt').limit(200);
  return ok(res, items);
});
