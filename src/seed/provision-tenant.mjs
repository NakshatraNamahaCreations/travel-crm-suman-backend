/**
 * Fills in the configuration an existing tenant is missing, per organization.
 *
 * Written for the case where a database predates a feature: the companies, users and trips are
 * all there, but the catalogues and settings a newer module expects were never created, so the
 * module's pages open empty or its API refuses the request.
 *
 * Deliberately NOT a data copy. Seeding from a demo database would mix invented companies into
 * a live one's records, and once 'Coral Reef Holidays' sits beside 934 real enquiries there is
 * no clean way to tell them apart again. Only settings and catalogues are written here.
 *
 * Every write is an upsert keyed on something stable, so running it twice changes nothing, and
 * nothing is ever deleted or overwritten — existing rows are left exactly as they are.
 *
 *   node src/seed/provision-tenant.mjs              # report what is missing, write nothing
 *   node src/seed/provision-tenant.mjs --apply      # write it
 *   node src/seed/provision-tenant.mjs --apply --org "Andaman TravelCare"   # one company only
 *
 * Reads MONGODB_URI from the environment like every other script here, so the database it
 * touches is whatever .env points at. It prints that host before doing anything — check it,
 * because a .env left pointing at a demo cluster is the easy mistake to make.
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import '../models/index.js';
import { runWithTenant } from '../tenant/context.js';
import { seedWhatsappTemplates } from '../controllers/whatsappTemplate.controller.js';
import { LEAD_CHANNELS } from '../config/leadChannels.js';

const APPLY = process.argv.includes('--apply');
const ORG_ARG = (() => {
  const i = process.argv.indexOf('--org');
  return i > -1 ? process.argv[i + 1] : null;
})();

const { Organization, WhatsappTemplate, QuerySource, LeadSettings, AssignmentRule } = mongoose.models;

// The starter routing rules, matching what seedMasterData gives a brand-new tenant. Neither
// names a person or a team, so they work whatever staff the company has on day one.
const STARTER_RULES = [
  {
    label: 'Paid ad leads — call fast',
    order: 1,
    match: 'any',
    conditions: [{ field: 'channel', op: 'in', value: ['google_ads', 'meta_ads'] }],
    targetType: 'any',
    method: 'least_busy',
    // Tighter than the default: a lead you paid for going cold costs money twice.
    slaMinutes: 10,
  },
  {
    label: 'Everything else',
    order: 99,
    conditions: [],
    targetType: 'any',
    method: 'least_busy',
    // The catch-all. Without it a lead matching no rule is simply never assigned.
    isFallback: true,
  },
];

// Query-source names the lead channels map onto, so captured leads also show up in the
// existing sales report, which breaks down by source rather than by channel.
const CHANNEL_SOURCES = [...new Set(LEAD_CHANNELS.map((c) => c.source))];

// Modules this script provisions for. Only ever ADDED to a company's list — an entitlement the
// owner removed on purpose must not come back because a seed script ran.
const MODULES_NEEDED = ['leads', 'whatsapp'];

const line = (label, value) => console.log('  ' + String(label).padEnd(19) + ': ' + value);

async function main() {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log('database : ' + mongoose.connection.host + ' / ' + mongoose.connection.name);
  console.log('mode     : ' + (APPLY ? 'APPLY — writing' : 'dry run — nothing will be written'));
  console.log('');

  const filter = ORG_ARG ? { name: ORG_ARG } : {};
  const orgs = await Organization.find(filter).select('name subscription').lean();
  if (!orgs.length) {
    console.log(ORG_ARG ? 'No company named "' + ORG_ARG + '".' : 'No companies in this database.');
    await mongoose.disconnect();
    process.exit(1);
  }

  for (const org of orgs) {
    console.log('── ' + org.name + ' ' + '─'.repeat(Math.max(0, 50 - org.name.length)));

    await runWithTenant(org._id, async () => {
      const templatesBefore = await WhatsappTemplate.countDocuments({});
      if (APPLY) await seedWhatsappTemplates();
      line('whatsapp templates', templatesBefore
        + (APPLY ? ' -> ' + await WhatsappTemplate.countDocuments({}) : ' (would seed the starter catalogue)'));

      const existing = new Set((await QuerySource.find().select('name').lean()).map((s) => s.name));
      const missing = CHANNEL_SOURCES.filter((n) => !existing.has(n));
      if (APPLY) {
        for (const name of missing) {
          await QuerySource.findOneAndUpdate(
            { name },
            { $setOnInsert: { name, isActive: true } },
            { upsert: true, setDefaultsOnInsert: true }
          );
        }
      }
      line('query sources', existing.size + ' present, ' + (missing.length ? 'adding ' + missing.join(', ') : 'nothing to add'));

      const had = await LeadSettings.findOne({}).lean();
      const settings = APPLY ? await LeadSettings.getFor() : had;
      line('lead settings', had ? 'already present' : APPLY ? 'created' : 'would be created');
      if (settings?.ingestToken) line('website token', settings.ingestToken.slice(0, 10) + '… (UTM Capture page shows it in full)');

      const rulesBefore = await AssignmentRule.countDocuments({});
      if (APPLY) {
        for (const rule of STARTER_RULES) {
          await AssignmentRule.findOneAndUpdate(
            { label: rule.label },
            { $setOnInsert: rule },
            { upsert: true, setDefaultsOnInsert: true }
          );
        }
      }
      line('assignment rules', rulesBefore
        + (APPLY ? ' -> ' + await AssignmentRule.countDocuments({}) : ' (would add ' + STARTER_RULES.length + ' starter rules)'));
    });

    // An absent module list means "everything", so only a stored list ever needs topping up.
    const stored = org.subscription?.modules;
    if (Array.isArray(stored)) {
      const add = MODULES_NEEDED.filter((m) => !stored.includes(m));
      if (add.length) {
        if (APPLY) {
          await Organization.updateOne({ _id: org._id }, { $addToSet: { 'subscription.modules': { $each: add } } });
        }
        line('modules', (APPLY ? 'added ' : 'would add ') + add.join(', ') + ' (keeping the ' + stored.length + ' already there)');
      } else {
        line('modules', MODULES_NEEDED.join(' + ') + ' already included');
      }
    } else {
      line('modules', 'no stored list — every module is already available');
    }
    console.log('');
  }

  await mongoose.disconnect();
  console.log(APPLY
    ? 'Done. Reload the CRM and the Leads and WhatsApp menus will be there.'
    : 'Dry run complete — nothing was written. Re-run with --apply to write.');
}

main().catch(async (err) => {
  console.error('[provision-tenant] ' + err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
