import mongoose from 'mongoose';
import { getTenantId } from './context.js';

// Mongoose schema plugin providing default-deny tenant isolation. Applied
// explicitly (one line) in every tenant-owned model file — NOT globally — so
// the exclusions (Counter, Organization, Plan, SubscriptionPayment) stay
// auditable.
//
// With a tenant context (set by tenant/middleware.js):
//   - every query op gets `organization` merged into its filter (the context
//     value overwrites any caller-supplied one — context is authoritative)
//   - new documents are stamped with the caller's organization
//   - aggregation pipelines get a leading $match
// Without a context (login, seeds, migrations, owner panel) all hooks are
// no-ops; those code paths pass organization explicitly where needed.
//
// Escape hatch for context-bound code that must cross tenants deliberately:
//   Model.find(...).setOptions({ skipTenant: true })
//   Model.aggregate(pipeline, { skipTenant: true })

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
];

export function tenantPlugin(schema) {
  schema.add({
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  });

  schema.pre(QUERY_HOOKS, function tenantFilter() {
    if (this.getOptions().skipTenant) return;
    const orgId = getTenantId();
    if (orgId) this.setQuery({ ...this.getQuery(), organization: orgId });
  });

  // Stamped on BOTH validate and save: Mongoose runs document validation
  // before user-defined save hooks, so a schema that marks `organization`
  // required (User does, for every non-owner) would fail validation before a
  // save-only stamp could run.
  schema.pre(['validate', 'save'], function tenantStamp(next) {
    if (!this.organization) {
      const orgId = getTenantId();
      if (orgId) this.organization = orgId;
    }
    next();
  });

  schema.pre('insertMany', function tenantStampMany(next, docs) {
    const orgId = getTenantId();
    if (orgId && Array.isArray(docs)) {
      for (const d of docs) if (!d.organization) d.organization = orgId;
    }
    next();
  });

  schema.pre('aggregate', function tenantMatch() {
    if (this.options?.skipTenant) return;
    const orgId = getTenantId();
    if (orgId) this.pipeline().unshift({ $match: { organization: new mongoose.Types.ObjectId(orgId) } });
  });
}
