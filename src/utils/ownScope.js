import { SUPER_ROLES } from '../config/permissions.js';

// Data visibility: admins/managers (and the platform owner) see the whole
// organization; every other role sees only records they own or created.
export const seesAll = (user) => !user || user.role === 'owner' || SUPER_ROLES.includes(user.role);

// Mongo filter limiting a collection to the caller's own records.
// Returns {} for privileged roles. `fields` lists the ownership fields the
// collection actually has.
export function ownScope(user, fields = ['owner', 'createdBy']) {
  if (seesAll(user)) return {};
  const or = fields.map((f) => ({ [f]: user._id }));
  return or.length === 1 ? or[0] : { $or: or };
}

// Merges the scope into an existing filter without clobbering a $or the
// filter already uses (e.g. for search).
export function applyScope(filter, scope) {
  if (!scope || !Object.keys(scope).length) return filter;
  return { $and: [filter, scope] };
}
