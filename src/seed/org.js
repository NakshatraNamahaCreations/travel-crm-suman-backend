// Default tenant organization used by seeds, importers and the migration.
// Existing single-tenant data belongs to this company.
import { Organization } from '../models/Organization.js';

export const DEFAULT_ORG_NAME = 'Irshad Travels';

export async function defaultOrg() {
  return Organization.findOneAndUpdate(
    { name: DEFAULT_ORG_NAME },
    { $setOnInsert: { name: DEFAULT_ORG_NAME, isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
