// Smoke test for the Quotes API + rate lookups. Run while the server is up.
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

// Grab a query + a hotel to cost against
const { data: queries } = await j('/queries?status=all&limit=1', { headers: auth });
const query = queries[0];
const { data: hotels } = await j('/hotels?search=Silver', { headers: auth });
const hotel = hotels[0];

// Auto-cost: look up the hotel rate
const { data: rate } = await j(
  `/lookups/hotel-rate?hotel=${hotel._id}&roomType=Andaman Cabana&mealPlan=AP&date=2026-02-01`,
  { headers: auth }
);
console.log(`Rate lookup: ${hotel.name} Andaman Cabana/AP on 2026-02-01 => ${rate ? rate.basePrice : 'none'}`);

// Create a quote with 2 days + cost items
const { data: quote } = await j('/quotes', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    query: query._id,
    title: 'Andaman 4N/5D Honeymoon',
    currency: 'INR',
    days: [
      { dayNumber: 1, title: 'Arrival at Port Blair', description: 'Cellular Jail Light & Sound show' },
      { dayNumber: 2, title: 'Ferry to Havelock', description: 'Radhanagar Beach' },
    ],
    costItems: [
      { category: 'hotel', label: 'Silver Sand — Andaman Cabana (AP)', meta: '3 nights', qty: 3, rate: rate?.basePrice || 17783 },
      { category: 'activity', label: 'Makruzz Ferry (Adult x2)', meta: 'Havelock', qty: 2, rate: 1775 },
    ],
    markupType: 'percent',
    markupValue: 15,
    taxPercent: 5,
  }),
});
const p = quote.pricing;
console.log(`Created quote #${quote.quoteNumber}: subtotal=${p.subtotal}, markup(15%)=${p.markup}, tax(5%)=${p.tax}, TOTAL=${p.total}`);

// Verify the parent query picked up the quoted amount
const { data: q2 } = await j(`/queries/${query._id}`, { headers: auth });
console.log(`Query #${q2.queryNumber} quotedAmount synced => ${q2.quotedAmount}`);

// Accept the quote → should convert the query
await j(`/quotes/${quote._id}/status`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'accepted' }) });
const { data: q3 } = await j(`/queries/${query._id}`, { headers: auth });
console.log(`After accept: query status => ${q3.status}, bookedAmount => ${q3.bookedAmount}`);

// Clean up so reruns stay deterministic
await j(`/quotes/${quote._id}`, { method: 'DELETE', headers: auth });
console.log('Cleaned up test quote.');
