// Ad-hoc smoke test for the Queries API. Run while the server is up.
const BASE = 'http://localhost:5000/api';

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

const { data: login } = await j('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@travelcrm.test', password: 'admin123' }),
});
const auth = { Authorization: `Bearer ${login.token}` };

const { data: dests } = await j('/destinations?search=Goa', { headers: auth });
const { data: sources } = await j('/query-sources?search=Website', { headers: auth });
const { data: tags } = await j('/tags?search=honeymoon', { headers: auth });

const payload = {
  source: sources[0]?._id,
  referenceId: 'REF-1001',
  tags: tags.slice(0, 1).map((t) => t._id),
  destinations: dests.slice(0, 1).map((d) => d._id),
  startDate: '2026-07-15',
  nights: 4,
  pax: { adults: 2, children: [{ age: 6 }] },
  foc: 0,
  guest: {
    salutation: 'Mr.',
    name: 'Yogesh Sharma',
    email: 'yogesh@example.com',
    location: 'Delhi',
    phones: [{ countryCode: '91', number: '9779212232', isPrimary: true }],
  },
  comments: 'Only 5 star hotels',
};

const { data: q } = await j('/queries', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify(payload),
});
console.log(`Created query #${q.queryNumber} for ${q.guest.name} -> ${q.destinations.map((d) => d.name).join(', ')} (${q.nights}N/${q.days}D, ${q.totalPax} pax), status=${q.status}`);

const { data: list, meta } = await j('/queries?status=new_query', { headers: auth });
console.log(`List new_query: ${meta.total} total; first=#${list[0]?.queryNumber}`);

await j(`/queries/${q._id}/status`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ status: 'in_progress' }),
});
const { data: stats } = await j('/queries/stats', { headers: auth });
console.log('Stats:', stats.counts.map((c) => `${c.label}=${c.count}`).join(' | '), `| all=${stats.all}`);
