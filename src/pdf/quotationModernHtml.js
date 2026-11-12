/**
 * The "modern" quotation layout: a letterhead-and-sections document — cover, quote summary,
 * accommodation, transport, inclusions, day-wise itinerary, terms, and a closing contact page.
 *
 * Nothing in here is hard-coded to one travel company. Every name, logo, phone number, email,
 * address, colour, cover image and terms paragraph comes from the organization's own profile;
 * every date, hotel, vehicle, day and price comes from the quote. That is the whole point —
 * the previous layout read its branding from a static config file, so every tenant's document
 * went out wearing the first tenant's name.
 *
 * Where a value is genuinely absent the block that needs it is omitted rather than printed
 * empty: a quotation with a blank "Your Holiday Consultant" card looks broken to a guest,
 * while one without that card just looks shorter.
 */

import { resolveQuotationTheme, themeCss, readableOn } from '../utils/quotationTheme.js';

/* ------------------------------ small helpers ------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => '&#8377;' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
/** Indian grouping without a currency mark — the price box prints "12,72,000 /-". */
const num = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtLong = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '');
const fmtDayMon = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const stars = (n) => '&#9733;'.repeat(Math.min(Math.max(Number(n) || 0, 0), 5)) + '&#9734;'.repeat(Math.max(0, 5 - Math.min(Number(n) || 0, 5)));
const uniq = (a) => [...new Set(a.filter(Boolean))];
/** Strips the HTML an agent's rich-text description may contain, for places that need plain
 *  text — the description is authored copy and must not inject markup into the document. */
const plain = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* ------------------------------ page furniture ----------------------------- */

const header = (org) => `
<div class="sheet-head">
  ${org.logo ? `<img class="hd-logo" src="${esc(org.logo)}" alt="">` : `<span class="hd-word">${esc(org.name)}</span>`}
  ${org.website ? `<span class="hd-site">${esc(org.websiteLabel)}</span>` : ''}
</div>`;

const footer = (org) => `
<div class="sheet-foot">
  <div class="ft-contact">
    ${org.phone ? `<span>&#9742; ${esc(org.phone)}</span>` : ''}
    ${org.email ? `<span>&#9993; ${esc(org.email)}</span>` : ''}
    ${org.address ? `<span>&#8962; ${esc(org.address)}</span>` : ''}
  </div>
  ${org.logo ? `<img class="ft-logo" src="${esc(org.logo)}" alt="">` : ''}
</div>`;

/** One printed page. The watermark is repeated text rather than an image so it scales with
 *  the page and costs nothing to render. */
const page = (org, body, { cover = false } = {}) => `
<section class="sheet${cover ? ' cover' : ''}">
  ${cover ? '' : header(org)}
  ${org.watermark ? `<div class="wm">${Array.from({ length: 14 }, () => esc(org.watermark)).join(' &bull; ')}</div>` : ''}
  <div class="sheet-body">${body}</div>
  ${cover ? '' : footer(org)}
</section>`;

const band = (title) => `<div class="band">${esc(title)}</div>`;

/* --------------------------- organization profile -------------------------- */

/** Everything the document prints about the company, resolved once with sensible fallbacks. */
function orgInfo(org) {
  const q = org?.quotation || {};
  const addr = (org?.contactAddresses || []).find((a) => a.primary) || (org?.contactAddresses || [])[0] || {};
  const name = org?.brandName || org?.officialName || '';
  const website = org?.website || '';
  return {
    name,
    officialName: org?.officialName || name,
    logo: org?.images?.logo || '',
    website,
    websiteLabel: website.replace(/^https?:\/\//i, '').replace(/\/$/, ''),
    phone: (org?.supportPhones || [])[0] || addr.phone || '',
    phones: uniq(org?.supportPhones || []),
    email: (org?.emails || [])[0] || addr.email || '',
    emails: uniq(org?.emails || []),
    address: String(addr.address || '').split('\n').filter(Boolean).join(', '),
    addressLines: String(addr.address || '').split('\n').filter(Boolean),
    tagline: q.tagline || '',
    // A blank watermark means "use the brand name"; a single space means "none at all".
    watermark: q.watermark === undefined || q.watermark === null || q.watermark === ''
      ? name
      : (String(q.watermark).trim() ? String(q.watermark) : ''),
    whyUs: (q.whyUs || []).filter((w) => w?.title || w?.text),
  };
}

/* ------------------------------- the document ------------------------------ */

export function quotationModernHtml(q, org = null) {
  const pkg = (q.packages || [])[q.selectedPackageIndex || 0] || {};
  const hotels = (pkg.hotels || []);
  const primary = hotels.filter((h) => !h.isAlternative);
  const guest = q.query?.guest || {};
  const info = orgInfo(org);

  const adults = q.pax?.adults || 0;
  const children = q.pax?.children?.length || 0;
  const pax = adults + children;
  const nights = q.nights || 0;
  const start = q.startDate || q.query?.startDate ? new Date(q.startDate || q.query.startDate) : null;
  const end = start ? addDays(start, nights) : null;

  const destNames = uniq((q.query?.destinations || []).map((d) => d?.name || d));
  const cities = uniq(primary.map((h) => h.city));
  const destLine = destNames.join(' & ') || cities.join(' & ') || pkg.name || 'Your Holiday';

  const theme = resolveQuotationTheme(org, {
    destinationIds: (q.query?.destinations || []).map((d) => d?._id || d),
    names: [...destNames, ...cities, pkg.name],
  });

  const guestName = [guest.salutation, guest.name].filter(Boolean).join(' ') || 'Traveller';
  const consultant = q.createdBy || null;

  const totalRooms = primary.reduce((s, h) => s + (Number(h.rooms) || 0), 0);
  const starSet = uniq(primary.map((h) => h.hotel?.stars || h.stars).filter(Boolean));
  const mealSet = uniq(primary.map((h) => h.mealPlan));
  const vehicleSet = uniq(
    (pkg.sameCabType ? pkg.sharedCabItems || [] : (pkg.transports || []).flatMap((t) => t.items || []))
      .map((i) => (i.qty > 1 ? `${i.qty} ${i.type}` : i.type))
  );

  const total = q.pricing?.total || 0;
  const perPerson = pax ? Math.round(total / pax) : 0;
  const advancePct = 10;
  const advance = Math.round((total * advancePct) / 100);

  /* ----------------------------- 1. cover page ---------------------------- */
  const coverFacts = [
    ['Trip Type', pkg.name || 'Holiday Package'],
    [guestName, pax ? `${pax} ${pax === 1 ? 'Person' : 'Persons'}` : ''],
  ];
  const coverPage = `
    ${theme.banner.image ? `<img class="cv-hero" src="${esc(theme.banner.image)}" alt="">` : '<div class="cv-hero cv-hero-blank"></div>'}
    <div class="cv-veil"></div>
    ${info.logo ? `<img class="cv-logo" src="${esc(info.logo)}" alt="">` : `<div class="cv-logo-word">${esc(info.name)}</div>`}
    <div class="cv-title">
      <h1>${esc(destLine)}</h1>
      ${info.tagline ? `<div class="cv-tag">${esc(info.tagline)}</div>` : ''}
    </div>
    <div class="cv-cards">
      <div class="cv-card">
        ${coverFacts.filter(([, v]) => v).map(([k, v]) => `<div class="cv-f"><span>${esc(k)}:</span> <b>${esc(v)}</b></div>`).join('')}
        <div class="cv-rule"></div>
        <div class="cv-dates">
          ${start ? `<div><span>Starts:</span> <b>${fmtDate(start)}</b></div>` : ''}
          ${end ? `<div><span>Ends:</span> <b>${fmtDate(end)} (${nights}N/${nights + 1}D)</b></div>` : ''}
        </div>
      </div>
      ${consultant?.name ? `
      <div class="cv-card cv-consult">
        <div class="cv-cl">Your Holiday Consultant</div>
        <b>${esc(consultant.name)}</b>
        ${consultant.phone ? `<div class="cv-cp">${esc(consultant.phone)}</div>` : ''}
      </div>` : ''}
    </div>
    <div class="cv-strip">
      ${info.phone ? `<span>&#9742; ${esc(info.phone)}</span>` : ''}
      ${info.email ? `<span>&#9993; ${esc(info.email)}</span>` : ''}
      ${info.websiteLabel ? `<span>&#127760; ${esc(info.websiteLabel)}</span>` : ''}
    </div>`;

  /* --------------------------- 2. quote summary --------------------------- */
  const facts = [
    ['Destination', destLine],
    ['Start Date', start ? fmtDate(start) : ''],
    ['Duration', nights ? `${nights} Nights / ${nights + 1} Days` : ''],
    ['Pax', pax ? `${pax} ${pax === 1 ? 'Person' : 'Persons'}${children ? ` (${adults} adult${adults === 1 ? '' : 's'}, ${children} child${children === 1 ? '' : 'ren'})` : ''}` : ''],
    ['Travel Type', pkg.name || ''],
    ['Rooms', totalRooms ? `${totalRooms} Room${totalRooms === 1 ? '' : 's'}${starSet.length === 1 ? ` &bull; ${starSet[0]} Star` : ''}` : ''],
    ['Stay', cities.join(', ')],
    ['End Date', end ? fmtDate(end) : ''],
    ['Vehicles', vehicleSet.join(', ')],
  ].filter(([, v]) => v);

  const summaryPage = `
    ${band(`QUOTE${pax ? ` &bull; ${pax} ${pax === 1 ? 'PERSON' : 'PERSONS'}` : ''}`)}
    <p class="greet">Dear <b>${esc(guestName)}</b>,</p>
    <p class="greet">Warm greetings from <b>${esc(info.name)}</b>!</p>
    <p class="lead">
      We are pleased to offer you a <b>${esc(nights ? `${nights} Nights / ${nights + 1} Days` : '')} ${esc(destLine)} Tour Package</b>${pax ? `, designed for your group of ${pax}` : ''}.
      ${cities.length ? `It covers stays in <b>${esc(cities.join(', '))}</b>.` : ''}
      Please go through it and let us know if you would like any changes. Contact details are at the end.
    </p>
    <div class="facts">
      ${facts.map(([k, v]) => `<div class="fact"><div class="fk">${k.toUpperCase()}</div><div class="fv">${v}</div></div>`).join('')}
    </div>
    ${band('Quote Price')}
    <table class="price">
      <thead><tr><th>Per Person (${esc(q.currency || 'INR')})</th><th>Total${pax ? ` for ${pax} ${pax === 1 ? 'Person' : 'Persons'}` : ''} (${esc(q.currency || 'INR')})</th></tr></thead>
      <tbody><tr>
        <td><span class="big">${num(perPerson)} /-</span><small>per person</small></td>
        <td><span class="big">${num(total)} /-</span>${pax ? `<small>${pax} &times; ${num(perPerson)}</small>` : ''}</td>
      </tr></tbody>
    </table>
    ${total ? `<div class="advance"><b>Advance to confirm booking:</b> ${advancePct}% of total package cost = <b>${inr(advance)}</b></div>` : ''}
    ${theme.bookingTerms ? `<div class="bookterms"><b>Booking terms:</b> ${esc(theme.bookingTerms)}</div>` : ''}`;

  /* ----------------------------- 3. hotels -------------------------------- */
  // Alternatives render inside their primary's block as "OPTION 1 / OR / OPTION 2", which is
  // how an agent means them — two choices for the same nights, not two separate stays.
  const nightLabel = (ns) => (ns || []).map((n) => `<span class="nb">${ord(n)}</span>`).join('');
  const hotelBlocks = primary.map((h) => {
    const alts = hotels.filter((a) => a.isAlternative && String(a.city || '') === String(h.city || '')
      && (a.nights || []).join() === (h.nights || []).join());
    const options = [h, ...alts];
    const checkIn = start && (h.nights || [])[0] ? fmtDate(addDays(start, (h.nights[0] - 1))) : '';
    const photo = h.hotel?.imageUrl || '';
    return `
    <div class="hcard">
      <div class="hmain">
        <div class="hnights">${nightLabel(h.nights)} <span class="hat">Night${(h.nights || []).length === 1 ? '' : 's'} at <b>${esc(h.city || '')}</b></span></div>
        ${checkIn ? `<div class="hsub">Check-in on ${checkIn}</div>` : ''}
        ${options.map((o, i) => `
          ${options.length > 1 ? `<div class="hopt">${i ? 'OR<br>' : ''}OPTION ${i + 1}</div>` : ''}
          <div class="hname">${esc(o.hotel?.name || o.hotelName || 'Hotel')}</div>
          ${(o.hotel?.stars || o.stars) ? `<div class="hstars">${stars(o.hotel?.stars || o.stars)}</div>` : ''}
        `).join('')}
        <div class="hmeta">
          ${h.rooms ? `<div><div class="fk">ROOMS</div><div class="fv">${h.rooms} Room${h.rooms === 1 ? '' : 's'}${(h.hotel?.stars || h.stars) ? ` (${h.hotel?.stars || h.stars}-Star)` : ''}</div>${pax ? `<div class="hpax">${pax} Persons</div>` : ''}</div>` : ''}
          ${h.mealPlan ? `<div><div class="fk">MEAL PLAN</div><div class="fv">${esc(h.mealPlan)}</div></div>` : ''}
          ${h.roomType ? `<div><div class="fk">ROOM TYPE</div><div class="fv">${esc(h.roomType)}</div></div>` : ''}
        </div>
      </div>
      ${photo ? `<figure class="hpic"><img src="${esc(photo)}" alt=""><figcaption>${esc(h.city || '')}</figcaption></figure>` : ''}
    </div>`;
  }).join('');

  /* ------------------- 4. transport & activities table -------------------- */
  const byDay = new Map();
  const push = (day, service, detail) => {
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ service, detail });
  };
  (pkg.transports || []).forEach((t) => {
    const days = (t.days?.length ? t.days : [t.day]).filter(Boolean);
    const label = [t.serviceLocation, t.serviceType].filter(Boolean).join(' — ');
    const veh = (t.items || []).map((i) => (i.qty > 1 ? `${i.qty} ${i.type}` : i.type)).join(', ')
      || (pkg.sameCabType ? vehicleSet.join(', ') : '');
    days.forEach((d) => push(d, label || 'Transfer', veh));
  });
  (pkg.activities || []).forEach((a) => {
    const days = (a.days?.length ? a.days : [a.day]).filter(Boolean);
    const label = a.name || a.activity?.name || 'Activity';
    days.forEach((d) => push(d, label, pax ? `${pax} Persons` : ''));
  });
  const dayRows = [...byDay.keys()].sort((a, b) => a - b).map((d) => {
    const rows = byDay.get(d);
    const date = start ? addDays(start, d - 1) : null;
    return rows.map((r, i) => `
      <tr>
        ${i === 0 ? `<td class="dcell" rowspan="${rows.length}"><b>${ord(d)} Day</b>${date ? `<div class="dsub">${fmtDayMon(date)}</div>` : ''}</td>` : ''}
        <td>${esc(r.service)}</td>
        <td>${esc(r.detail || '')}</td>
      </tr>`).join('');
  }).join('');

  const transportPage = dayRows ? `
    ${band('Transportation and Activities')}
    <table class="grid">
      <thead><tr><th style="width:92px">Day</th><th>Service</th><th style="width:34%">Vehicle / Details</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table>` : '';

  /* ----------------------- 5. inclusions / exclusions ---------------------- */
  const incExcPage = `
    ${band('Inclusions / Exclusions')}
    <div class="ie">
      <div>
        <h3 class="ie-h inc">Inclusions</h3>
        <ul class="bullets">${(q.inclusions || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>As discussed with your consultant.</li>'}</ul>
      </div>
      <div>
        <h3 class="ie-h exc">Exclusions</h3>
        <ul class="bullets">${(q.exclusions || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Anything not listed under inclusions.</li>'}</ul>
        <p class="ie-note">Anything not mentioned in the inclusions is excluded.</p>
      </div>
    </div>`;

  /* -------------------------- 6. day-wise itinerary ----------------------- */
  const itinerary = (q.days || []).filter((d) => d.title || d.description || d.sightseeing);
  const itineraryPage = itinerary.length ? `
    ${band('Day Wise Itinerary')}
    ${itinerary.map((d) => {
      const date = d.date || (start ? addDays(start, (d.dayNumber || 1) - 1) : null);
      return `
      <div class="itd">
        <div class="itn"><b>${ord(d.dayNumber || 1)}</b><span>Day</span></div>
        <div class="itb">
          ${date ? `<div class="itdate">${fmtLong(date)}</div>` : ''}
          <h3>${esc(d.title || `Day ${d.dayNumber || 1}`)}</h3>
          ${d.destination?.name ? `<div class="itloc">${esc(d.destination.name)}</div>` : ''}
          ${d.description ? `<p>${esc(plain(d.description))}</p>` : ''}
          ${d.sightseeing ? `<div class="itplus"><span>+</span><div><b>${esc(plain(d.sightseeing))}</b></div></div>` : ''}
        </div>
      </div>`;
    }).join('')}` : '';

  /* ---------------------------- 7. terms ---------------------------------- */
  const termsHtml = theme.terms.length ? `
    ${band('Terms and Conditions')}
    ${theme.terms.map((s) => `
      <div class="tsec">
        <h3>${esc(String(s.heading || '').replace(/^\d+\.\s*/, ''))}</h3>
        ${s.intro ? `<p class="tintro">${esc(s.intro)}</p>` : ''}
        ${s.table?.rows?.length ? `
          <table class="grid sm">
            ${s.table.headers?.length ? `<thead><tr>${s.table.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}
            <tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>` : ''}
        ${s.items?.length ? `<ul class="bullets">${s.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </div>`).join('')}` : '';

  /* --------------------------- 8. closing page ---------------------------- */
  const closingPage = `
    <div class="close">
      <div class="close-brand">
        ${info.logo ? `<img src="${esc(info.logo)}" alt="">` : `<div class="cv-logo-word dark">${esc(info.name)}</div>`}
        <h2>${esc(info.name)}</h2>
        ${info.addressLines.length ? `<p class="close-addr">${info.addressLines.map(esc).join('<br>')}</p>` : ''}
      </div>
      ${consultant?.name ? `
      <div class="close-consult">
        <div class="cv-cl">Your Holiday Consultant</div>
        <b>${esc(consultant.name)}</b>
        ${consultant.phone ? `<div>Call / WhatsApp: <b>${esc(consultant.phone)}</b></div>` : ''}
        ${consultant.email ? `<div>${esc(consultant.email)}</div>` : ''}
      </div>` : ''}
    </div>
    ${info.whyUs.length ? `
      ${band(`Why Choose ${info.name}?`)}
      <ul class="bullets why">${info.whyUs.map((w) => `<li>${w.title ? `<b>${esc(w.title)}:</b> ` : ''}${esc(w.text || '')}</li>`).join('')}</ul>` : ''}
    <p class="signoff">Warm regards,<br><b>${esc(info.name)}</b></p>`;

  /* ------------------------------- assemble ------------------------------- */
  const onBand = readableOn(theme.colors.primary);
  const pages = [
    page(info, coverPage, { cover: true }),
    page(info, summaryPage),
    hotelBlocks ? page(info, `${band('Hotels / Accommodations')}${hotelBlocks}`) : '',
    transportPage ? page(info, transportPage) : '',
    page(info, incExcPage),
    itineraryPage ? page(info, itineraryPage) : '',
    termsHtml ? page(info, termsHtml) : '',
    page(info, closingPage),
  ].filter(Boolean).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Quotation${q.quoteNumber ? ' ' + q.quoteNumber : ''} — ${esc(info.name)}</title>
<style>
${themeCss(theme.colors)}
:root { --band-fg:${onBand}; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font:13px/1.55 "Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--q-text);background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{position:relative;width:850px;min-height:1150px;margin:0 auto 10px;padding:0 0 60px;background:#fff;overflow:hidden;page-break-after:always;display:flex;flex-direction:column}
.sheet:last-child{page-break-after:auto}
.sheet-body{position:relative;z-index:2;padding:16px 34px 10px;flex:1}
.cover .sheet-body{padding:0}

/* header / footer */
.sheet-head{position:relative;z-index:3;display:flex;align-items:center;gap:12px;padding:12px 34px 10px;border-bottom:3px solid var(--q-primary)}
.hd-logo{height:38px;width:auto;object-fit:contain}
.hd-word{font-weight:700;font-size:17px;color:var(--q-primary);letter-spacing:.02em}
.hd-site{margin-left:auto;background:var(--q-primary);color:var(--band-fg);border-radius:20px;padding:5px 16px;font-size:11.5px;font-weight:600}
.sheet-foot{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;align-items:center;gap:14px;padding:10px 34px;background:var(--q-primary);color:var(--band-fg)}
.ft-contact{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:10.5px}
.ft-logo{margin-left:auto;height:30px;background:#fff;border-radius:5px;padding:3px 7px}

/* watermark */
.wm{position:absolute;inset:0;z-index:1;opacity:.05;color:var(--q-primary);font-size:34px;font-weight:800;line-height:2.6;word-spacing:6px;transform:rotate(-24deg) scale(1.5);transform-origin:center;pointer-events:none;overflow:hidden}

/* cover */
.cover{padding:0}
.cv-hero{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cv-hero-blank{background:linear-gradient(140deg,var(--q-primary),var(--q-primary-light))}
.cv-veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.42) 0%,rgba(0,0,0,.12) 34%,rgba(0,0,0,.62) 100%)}
.cv-logo{position:absolute;top:34px;left:34px;z-index:3;height:92px;width:92px;object-fit:contain;background:#fff;border-radius:50%;padding:9px;box-shadow:0 3px 14px rgba(0,0,0,.25)}
.cv-logo-word{position:absolute;top:40px;left:34px;z-index:3;color:#fff;font-size:24px;font-weight:800;letter-spacing:.04em;text-shadow:0 2px 10px rgba(0,0,0,.4)}
.cv-logo-word.dark{position:static;color:var(--q-primary);text-shadow:none}
.cv-title{position:absolute;left:0;right:0;top:46%;z-index:3;text-align:center;color:#fff;padding:0 40px}
.cv-title h1{margin:0;font-size:68px;line-height:.98;font-weight:800;letter-spacing:-.01em;text-transform:uppercase;text-shadow:0 4px 22px rgba(0,0,0,.45)}
.cv-tag{margin-top:14px;display:inline-block;background:rgba(255,255,255,.93);color:var(--q-primary);border-radius:7px;padding:7px 22px;font-size:19px;font-style:italic;font-weight:700}
.cv-cards{position:absolute;left:34px;right:34px;bottom:84px;z-index:3;display:flex;gap:14px}
.cv-card{flex:1;background:rgba(255,255,255,.95);border-radius:10px;padding:14px 18px}
.cv-f{font-size:13px;margin-bottom:3px}
.cv-f span{color:#5b6475}
.cv-rule{border-top:1px dashed #b9c2d2;margin:9px 0}
.cv-dates{display:flex;gap:26px;font-size:13px;flex-wrap:wrap}
.cv-dates span{color:#5b6475}
.cv-consult{max-width:38%}
.cv-cl{color:#5b6475;font-size:12px;margin-bottom:3px}
.cv-consult b{font-size:15px;color:var(--q-primary)}
.cv-cp{color:var(--q-accent);font-weight:600;margin-top:2px}
.cv-strip{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;justify-content:center;gap:34px;flex-wrap:wrap;padding:14px 20px;background:rgba(255,255,255,.95);font-size:12.5px;font-weight:600;color:var(--q-primary)}

/* bands & text */
.band{background:var(--q-tint);border-left:5px solid var(--q-accent);color:var(--q-primary);font-size:15px;font-weight:700;padding:9px 14px;border-radius:5px;margin:18px 0 12px}
.sheet-body > .band:first-child{margin-top:4px}
.greet{margin:6px 0}
.lead{margin:8px 0 4px;text-align:justify}
h3{margin:0 0 5px;color:var(--q-primary);font-size:14.5px}

/* fact grid */
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px 18px;margin:14px 0 6px}
.fk{color:#8a93a4;font-size:10.5px;font-weight:600;letter-spacing:.05em}
.fv{font-size:14px;font-weight:700;color:var(--q-primary)}

/* price */
.price{width:100%;border-collapse:collapse;margin-top:4px}
.price th{background:#fff;border:1px solid var(--q-soft);text-align:left;padding:9px 14px;font-size:12.5px;color:var(--q-text)}
.price td{border:1px solid var(--q-soft);padding:12px 14px;vertical-align:top}
.price .big{display:block;font-size:27px;font-weight:800;color:var(--q-primary);line-height:1.1}
.price small{color:#8a93a4;font-size:11px}
.advance{background:#fdf6e6;border:1px solid #f0dcae;border-radius:5px;padding:9px 14px;margin-top:9px;font-size:12.5px}
.bookterms{margin-top:7px;font-size:12px;color:#5b6475}

/* hotels */
.hcard{display:flex;gap:14px;border:1px solid #e3e8f0;border-radius:10px;padding:13px 15px;margin-bottom:11px;page-break-inside:avoid}
.hmain{flex:1;min-width:0}
.hnights{font-size:14px}
.nb{display:inline-block;background:var(--q-tint);border:1px solid var(--q-soft);color:var(--q-primary);border-radius:4px;padding:1px 7px;font-size:11.5px;font-weight:700;margin-right:4px}
.hat{color:var(--q-text)}
.hsub{color:#8a93a4;font-size:11.5px;margin-bottom:5px}
.hopt{color:#8a93a4;font-size:10.5px;font-weight:700;letter-spacing:.05em;margin-top:6px}
.hname{font-size:16px;font-weight:700;color:var(--q-primary)}
.hstars{color:var(--q-accent);font-size:13px;letter-spacing:1px}
.hmeta{display:flex;gap:30px;flex-wrap:wrap;margin-top:9px}
.hpax{color:#8a93a4;font-size:11.5px}
.hpic{margin:0;width:210px;flex-shrink:0}
.hpic img{width:100%;height:126px;object-fit:cover;border:1px solid #e3e8f0;border-radius:6px}
.hpic figcaption{text-align:center;color:#8a93a4;font-size:11px;margin-top:3px}

/* tables */
.grid{width:100%;border-collapse:collapse;font-size:12.5px}
.grid th{background:#f4f7fb;border:1px solid #e3e8f0;text-align:left;padding:8px 11px;color:var(--q-primary);font-size:12px}
.grid td{border:1px solid #e3e8f0;padding:8px 11px;vertical-align:top}
.grid.sm{font-size:12px;margin:6px 0}
.dcell{background:#fafcff;white-space:nowrap}
.dsub{color:#8a93a4;font-size:11px;font-weight:400}

/* lists */
.bullets{margin:4px 0;padding-left:17px}
.bullets li{margin:3px 0}
.bullets li::marker{color:var(--q-accent)}
.ie{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.ie-h{border-bottom:2px solid var(--q-accent);display:inline-block;padding-bottom:2px}
.ie-note{color:var(--q-accent);font-weight:600;font-size:12px;margin-top:8px}
.why li{margin:5px 0}

/* itinerary */
.itd{display:flex;gap:13px;margin-bottom:13px;page-break-inside:avoid}
.itn{width:44px;flex-shrink:0;text-align:center;background:var(--q-tint);border:1px solid var(--q-soft);border-radius:6px;padding:6px 0;height:max-content}
.itn b{display:block;color:var(--q-primary);font-size:16px;line-height:1}
.itn span{font-size:10px;color:#8a93a4}
.itb{flex:1;min-width:0}
.itdate{color:#5b6475;font-size:11.5px;font-weight:600}
.itb h3{margin:1px 0 2px;font-size:16px}
.itloc{color:#8a93a4;font-size:11.5px;margin-bottom:4px}
.itb p{margin:4px 0;text-align:justify}
.itplus{display:flex;gap:9px;align-items:flex-start;margin-top:7px;background:#f7fafd;border-radius:6px;padding:7px 10px}
.itplus span{display:grid;place-items:center;width:22px;height:22px;flex-shrink:0;border:1px solid var(--q-soft);border-radius:5px;color:var(--q-primary);font-weight:700}

/* terms */
.tsec{margin-bottom:13px;page-break-inside:avoid}
.tintro{margin:3px 0 5px;color:#5b6475}

/* closing */
.close{display:flex;gap:24px;align-items:flex-start;margin-top:8px}
.close-brand{flex:1}
.close-brand img{height:84px;object-fit:contain;display:block;margin-bottom:9px}
.close-brand h2{margin:0;color:var(--q-primary);font-size:19px}
.close-addr{color:#5b6475;font-size:12px;margin:5px 0 0}
.close-consult{width:40%;text-align:right;font-size:12.5px}
.close-consult b{color:var(--q-primary);font-size:15px}
.signoff{margin-top:22px;color:#5b6475}

@page{size:A4;margin:0}
@media print{.sheet{margin:0;box-shadow:none}}
</style></head><body>${pages}</body></html>`;
}
