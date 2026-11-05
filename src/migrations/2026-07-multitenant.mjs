/* One-time multi-tenant migration. Idempotent — safe to re-run.
   1. Creates the default "Andaman TravelCare" organization
   2. Stamps every tenant-owned document (and tenant users) with it
   3. Renames global counters to per-org composite keys, preserving sequences
   4. Claims the singleton OrgProfile for the default org
   5. Bootstraps the platform owner from OWNER_EMAIL / OWNER_PASSWORD
   6. syncIndexes() everywhere — drops the old global unique indexes and
      builds the new per-org compound ones
   Take a mongodump before running. Usage: npm run migrate:multitenant */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import * as models from '../models/index.js';
import { Organization } from '../models/Organization.js';
import { Counter } from '../models/Counter.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { User } from '../models/User.js';
import { ensureOwner } from '../seed/create-owner.mjs';
import { defaultOrg } from '../seed/org.js';

// Every tenant-scoped model registered in the barrel (plugin adds the
// organization path). User is handled separately (owner excluded).
const TENANT_MODELS = Object.values(models).filter(
  (M) =>
    typeof M === 'function' &&
    M.schema?.path?.('organization') &&
    !['User', 'Organization', 'Plan', 'SubscriptionPayment', 'OrgProfile', 'Counter'].includes(M.modelName)
);

const COUNTER_KEYS = ['query', 'quote', 'booking', 'payment', 'installment', 'proformaInvoice'];

async function run() {
  await connectDB();

  // 1. Default organization
  const org = await defaultOrg();
  console.log(`[migrate] Default org: ${org.name} (${org._id})`);

  // 2. Stamp tenant documents (no tenant context here → plugin is inert)
  for (const M of TENANT_MODELS) {
    const r = await M.updateMany(
      { organization: { $exists: false } },
      { $set: { organization: org._id } }
    );
    if (r.modifiedCount) console.log(`[migrate] ${M.modelName}: stamped ${r.modifiedCount}`);
  }
  const ru = await User.updateMany(
    { role: { $ne: 'owner' }, organization: { $exists: false } },
    { $set: { organization: org._id } }
  );
  if (ru.modifiedCount) console.log(`[migrate] User: stamped ${ru.modifiedCount}`);

  // 3. Counters → per-org composite keys (keep the higher seq on re-run)
  for (const key of COUNTER_KEYS) {
    const old = await Counter.findById(key);
    if (!old) continue;
    await Counter.updateOne(
      { _id: `${org._id}:${key}` },
      { $max: { seq: old.seq } },
      { upsert: true }
    );
    await Counter.deleteOne({ _id: key });
    console.log(`[migrate] Counter '${key}' → '${org._id}:${key}' (seq ${old.seq})`);
  }

  // 4. Claim the singleton OrgProfile
  const rp = await OrgProfile.updateMany(
    { organization: { $exists: false } },
    { $set: { organization: org._id } }
  );
  if (rp.modifiedCount) console.log(`[migrate] OrgProfile claimed for default org`);

  // 5. Platform owner (skipped with a warning if env vars are missing)
  try {
    await ensureOwner();
  } catch (err) {
    console.warn(`[migrate] Owner not created: ${err.message} (run 'npm run bootstrap:owner' later)`);
  }

  // 6. Rebuild indexes AFTER data is stamped
  for (const M of [...TENANT_MODELS, User, Organization, OrgProfile]) {
    try {
      await M.syncIndexes();
      console.log(`[migrate] syncIndexes: ${M.modelName}`);
    } catch (err) {
      console.warn(`[migrate] syncIndexes failed for ${M.modelName}: ${err.message}`);
    }
  }

  console.log('[migrate] Done.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
