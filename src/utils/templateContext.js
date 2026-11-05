// Server-side resolution of WhatsApp template placeholder sources.
//
// The agent-driven send resolves these on the client (client/src/lib/templateSources.js),
// where a trip's query / quote / booking / instalment context is already assembled. An
// automatic send has no browser, so the subset of sources that need nothing beyond the
// query itself and the organization profile is resolved here.
//
// Only link-free sources are covered: a public document link is minted when an agent opens
// the send modal, so any template carrying `needs` still belongs to the manual path.

import { OrgProfile } from '../models/OrgProfile.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'd MMM, yyyy', matching the client's date-fns format so both paths read alike. */
const dt = (d) => {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${date.getFullYear()}`;
};

const guestName = (q) =>
  [q?.guest?.salutation, q?.guest?.name].filter(Boolean).join(' ') || 'Guest';

const travellers = (q) => {
  const a = q?.pax?.adults || 0;
  const c = q?.pax?.children?.length || 0;
  return `${a} Adult${a === 1 ? '' : 's'}${c ? `, ${c} Child${c === 1 ? '' : 'ren'}` : ''}`;
};

// `destinations` is a ref array: resolved only when the caller populated it, so an
// unpopulated query degrades to the same wording the client uses for a missing one.
const destination = (q) =>
  (q?.destinations || []).map((d) => d?.name).filter(Boolean).join(', ') || 'your holiday';

const travelDates = (q) => {
  if (!q?.startDate) return 'To be confirmed';
  const end = new Date(q.startDate);
  end.setDate(end.getDate() + (q.nights || 0));
  return `${dt(q.startDate)} – ${dt(end)}`;
};

const duration = (q) => {
  const n = q?.nights || 0;
  return `${n} Night${n === 1 ? '' : 's'} / ${n + 1} Day${n === 1 ? '' : 's'}`;
};

/** The guest's primary phone as Gallabox wants it: country code then number, digits only. */
export const guestPhone = (q) => {
  const phones = q?.guest?.phones || [];
  const primary = phones.find((p) => p.isPrimary) || phones[0];
  if (!primary) return '';
  return `${primary.countryCode || '91'}${primary.number || ''}`.replace(/\D/g, '');
};

// Keyed by the same source names the client's TEMPLATE_SOURCES uses, so a template written
// in the editor resolves identically whichever path sends it.
const RESOLVERS = {
  manual: () => '',
  guest_name: ({ query }) => guestName(query),
  guest_first_name: ({ query }) => String(query?.guest?.name || 'Guest').split(/\s+/)[0],
  guest_phone: ({ query }) => guestPhone(query),
  guest_email: ({ query }) => query?.guest?.email || '',
  traveller_count: ({ query }) => travellers(query),
  trip_no: ({ query }) => (query?.queryNumber == null ? '' : String(query.queryNumber).padStart(4, '0')),
  destination: ({ query }) => destination(query),
  travel_dates: ({ query }) => travelDates(query),
  start_date: ({ query }) => dt(query?.startDate),
  end_date: ({ query }) => {
    if (!query?.startDate) return '';
    const end = new Date(query.startDate);
    end.setDate(end.getDate() + (query.nights || 0));
    return dt(end);
  },
  duration: ({ query }) => duration(query),
  company_name: ({ org }) => org?.officialName || org?.brandName || '',
  company_short: ({ org }) => org?.brandName || org?.officialName || '',
  company_phone: ({ org }) => org?.supportPhones?.[0] || org?.phone || '',
  company_website: ({ org }) => org?.website || '',
};

/** The sources this module can fill — anything outside it belongs to the agent-driven send. */
export const serverResolvableSources = () => Object.keys(RESOLVERS);

/**
 * Fill a stored template's `variables` from the query, as Gallabox `bodyValues`.
 *
 * Returns the values alongside the names it could not resolve, so a caller can refuse to
 * send a half-filled first-contact message rather than deliver one with blanks in it.
 */
export function buildBodyValues(template, { query, org }) {
  const ctx = { query, org };
  const bodyValues = {};
  const unresolved = [];
  for (const variable of template?.variables || []) {
    const resolve = RESOLVERS[variable.source];
    const value = resolve ? String(resolve(ctx) ?? '') : '';
    if (value) {
      bodyValues[variable.name] = value;
    } else if (variable.fallback) {
      bodyValues[variable.name] = variable.fallback;
    } else {
      unresolved.push(variable.name);
    }
  }
  return { bodyValues, unresolved };
}

/** The organization's profile, or null when it has none yet (tenant-scoped by the plugin). */
export const loadOrgProfile = () => OrgProfile.findOne().lean();
