import { company } from '../config/company.js';

/**
 * Booking vouchers (Sembark-style Docs tab): one template, three types —
 *   trip     → Booking Confirmation Voucher (trip table, day-wise itinerary,
 *              transports & activities, inclusions/exclusions, TnC, helpline)
 *   hotels   → Hotels Confirmation Voucher (trip table + hotel stays)
 *   activity → Activity Confirmation Voucher (guest table + activities)
 *
 * options: { prices, removeBranding, removeItinerary, bankAccount, tnc }
 * Branded header/footer banner images + diagonal watermark repeat on every
 * printed page (fixed elements); Remove Branding switches to the plain
 * banners and drops the watermark's brand text.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const fmtLong = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');
const fmtShort = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };

const pkgOf = (q) => q?.packages?.[q.selectedPackageIndex || 0] || q?.packages?.[0] || null;

export function voucherHtml(quote, { org = null, type = 'trip', options = {} } = {}) {
  const {
    prices = false, removeBranding = false, removeItinerary = false, bankAccount = false, tnc = true,
    // Per-stay hotel confirmation voucher extras (Bookings > Hotel Check-Ins "Generate").
    confirmationNumber = '', voucherContact = '', voucherNotes = '',
    hotelAddress = '', hotelCheckInTime = '', hotelCheckOutTime = '',
  } = options;
  const q = quote.query || {};
  const pkg = pkgOf(quote) || {};
  const brand = org?.brandName || org?.officialName || company.name;
  const tripId = q.queryNumber ?? '';
  const guestName = [q.guest?.salutation, q.guest?.name].filter(Boolean).join(' ') || 'Guest';
  const guestPh = q.guest?.phones?.[0] ? `+${q.guest.phones[0].countryCode || '91'}-${q.guest.phones[0].number}` : '—';
  const paxLabel = `${q.pax?.adults ?? quote.pax?.adults ?? 0} Adult${(q.pax?.adults ?? quote.pax?.adults ?? 0) === 1 ? '' : 's'}${(q.pax?.children?.length || quote.pax?.children?.length) ? `, ${q.pax?.children?.length || quote.pax?.children?.length} Children` : ''}`;
  const dests = (q.destinations || []).map((d) => d.name || d).join(', ') || '—';
  const nights = quote.nights || q.nights || 0;
  const start = quote.startDate || q.startDate;

  const headerBanner = removeBranding ? org?.images?.headerBannerPlain : org?.images?.headerBanner;
  const footerBanner = removeBranding ? org?.images?.footerBannerPlain : org?.images?.footerBanner;

  /* ---- shared building blocks ---- */
  const kv = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  const kv2 = (k1, v1, k2, v2) => `<tr><td class="k">${k1}</td><td class="v">${v1}</td><td class="k">${k2}</td><td class="v">${v2}</td></tr>`;
  const bandRow = (label) => `<div class="secband">${esc(label)}</div>`;

  const tripTable = `
    <table class="kvt">
      <tr><td colspan="4" class="thead">Trip Voucher</td></tr>
      ${kv2('Trip ID', esc(String(tripId)), 'Start Date', esc(fmtLong(start)))}
      ${kv2('Destination', `<b>${esc(dests)}</b>`, 'Trip Duration', `<b>${nights} Nights / ${nights + 1} Days</b>`)}
      ${kv2('Guest Name', `<b>${esc(guestName)}</b>`, 'Guest Ph.', esc(guestPh))}
      ${kv('Pax', `<b>${esc(paxLabel)}</b>`)}
    </table>`;

  /* ---- day-wise itinerary ---- */
  const dayBlocks = (quote.days || []).map((d) => {
    const date = start ? addDays(start, (d.dayNumber || 1) - 1) : null;
    const dayLabel = `${ordinal(d.dayNumber || 1)} Day`;
    const dateLabel = date ? ` (${date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'long' })})` : '';
    const body = String(d.description || '').split('\n').filter((x) => x.trim())
      .map((line) => `<p class="dline">${esc(line)}</p>`).join('');
    return `<div class="dayblk">
      <div class="dayhead"><b>${dayLabel}</b><span class="daydate">${esc(dateLabel)}</span> : <span class="daytitle">${esc(d.title || '')}</span></div>
      ${body}
    </div>`;
  }).join('');

  /* ---- transports & activities table ---- */
  const byDay = new Map();
  const push = (dayNo, cell) => { if (!byDay.has(dayNo)) byDay.set(dayNo, []); byDay.get(dayNo).push(cell); };
  for (const t of pkg.transports || []) {
    const days = Array.isArray(t.days) && t.days.length ? t.days : [t.day || 1];
    const veh = (pkg.sameCabType ? pkg.sharedCabItems : t.items || [])
      ?.filter((it) => it.type).map((it) => `${it.qty || 1}-${it.type}`).join(', ') || '';
    const amount = (t.items || []).reduce((s, it) => s + (it.amount || (it.qty || 0) * (it.rate || 0)), 0);
    for (const dayNo of days) push(dayNo, { l1: t.serviceLocation, l2: t.serviceType, right: veh, amount });
  }
  for (const a of pkg.activities || []) {
    const days = Array.isArray(a.days) && a.days.length ? a.days : [1];
    const paxCells = (a.items || []).map((it) => `${it.qty || 1} ${it.type || ''}`.trim()).join(', ');
    const amount = (a.items || []).reduce((s, it) => s + (it.amount || (it.qty || 0) * (it.rate || 0)), 0);
    for (const dayNo of days) push(dayNo, { l1: a.name, l2: a.ticketType, right: paxCells, amount });
  }
  const transportRows = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([dayNo, cells]) => {
    const date = start ? addDays(start, dayNo - 1) : null;
    return cells.map((c, i) => `<tr>
      ${i === 0 ? `<td class="dcol" rowspan="${cells.length}"><b>${ordinal(dayNo)} Day</b><br/><span class="dim">${esc(fmtShort(date))}</span></td>` : ''}
      <td>${esc(c.l1 || '')}${c.l2 ? `<br/><span class="dim">${esc(c.l2)}</span>` : ''}</td>
      <td>${esc(c.right || '')}</td>
      ${prices ? `<td class="amt">${c.amount ? inr(c.amount) : '—'}</td>` : ''}
    </tr>`).join('');
  }).join('');
  const transportTable = transportRows ? `
    ${bandRow('Transportation and Activities')}
    <table class="grid">
      <tr><th style="width:130px">Day</th><th>Service</th><th style="width:150px"></th>${prices ? '<th style="width:110px">Price</th>' : ''}</tr>
      ${transportRows}
    </table>` : '';

  /* ---- hotels table (primary rows only — alternatives are quote-time choices) ----
     Non-consecutive nights at the same hotel (e.g. 1st + 5th) are SEPARATE
     stays — one row per contiguous run with its own real check-in/out, so the
     voucher never invents a merged stay or drops the re-check-in. */
  const contiguousRuns = (ns) => {
    const runs = [];
    for (const n of ns) {
      const last = runs[runs.length - 1];
      if (last && n === last[last.length - 1] + 1) last.push(n);
      else runs.push([n]);
    }
    return runs;
  };
  const stays = (pkg.hotels || []).filter((h) => !h.isAlternative).flatMap((h) => {
    const ns = (h.nights || []).slice().sort((a, b) => a - b);
    const runs = ns.length ? contiguousRuns(ns) : [[]];
    const perNight = ns.length ? (h.amount || 0) / ns.length : 0;
    let allocated = 0;
    return runs.map((run, ri) => {
      const isLast = ri === runs.length - 1;
      const amount = isLast ? Math.round((h.amount || 0) - allocated) : Math.round(perNight * run.length);
      allocated += amount;
      return { h, run, reCheckIn: ri > 0, amount };
    });
  });
  // Chronological down the page — night 1, 2-3, 4, 5 — not grouped by hotel.
  stays.sort((a, b) => (a.run[0] || 0) - (b.run[0] || 0));
  const hotelRows = stays.map(({ h, run, reCheckIn, amount }) => {
    const checkIn = start && run.length ? addDays(start, run[0] - 1) : null;
    const checkOut = checkIn ? addDays(checkIn, run.length) : null;
    return `<tr>
      <td><b>${run.map(ordinal).join(', ') || '—'}</b> Night${run.length > 1 ? 's' : ''}${reCheckIn ? '<br/><span class="dim">Re Check-in</span>' : ''}${checkIn ? `<br/><span class="dim">In: ${fmtShort(checkIn)}<br/>Out: ${fmtShort(checkOut)}</span>` : ''}</td>
      <td><b>${esc(h.hotelName || '')}</b><br/><span class="dim">${esc(h.city || '')}</span></td>
      <td>${h.rooms || 1} × ${esc(h.roomType || 'Room')}${h.aweb ? ` + ${h.aweb} AWEB` : ''}${h.cweb ? ` + ${h.cweb} CWEB` : ''}${h.cnb ? ` + ${h.cnb} CNB` : ''}</td>
      <td>${esc(h.mealPlan || '—')}</td>
      ${prices ? `<td class="amt">${amount ? inr(amount) : '—'}</td>` : ''}
    </tr>`;
  }).join('');
  const hotelsTable = hotelRows ? `
    ${bandRow('Hotels')}
    <table class="grid">
      <tr><th style="width:150px">Night(s)</th><th>Hotel</th><th>Rooms</th><th style="width:90px">Meal Plan</th>${prices ? '<th style="width:110px">Price</th>' : ''}</tr>
      ${hotelRows}
    </table>` : '';

  /* ---- activities-only table ---- */
  const activityRows = (pkg.activities || []).map((a) => {
    const dayNo = (Array.isArray(a.days) && a.days[0]) || 1;
    const date = start ? addDays(start, dayNo - 1) : null;
    const paxCells = (a.items || []).map((it) => `${it.qty || 1} ${it.type || ''}`.trim()).join(', ');
    const amount = (a.items || []).reduce((s, it) => s + (it.amount || (it.qty || 0) * (it.rate || 0)), 0);
    return `<tr>
      <td><b>${ordinal(dayNo)} Day</b><br/><span class="dim">${esc(fmtShort(date))}</span></td>
      <td><b>${esc(a.name || '')}</b>${a.ticketType ? `<br/><span class="dim">${esc(a.ticketType)}</span>` : ''}</td>
      <td>${esc(a.slot || '—')}</td>
      <td>${esc(paxCells || '—')}</td>
      ${prices ? `<td class="amt">${amount ? inr(amount) : '—'}</td>` : ''}
    </tr>`;
  }).join('');
  const activitiesTable = activityRows ? `
    ${bandRow('Activities')}
    <table class="grid">
      <tr><th style="width:130px">Day</th><th>Activity</th><th style="width:80px">Slot</th><th style="width:150px">Tickets</th>${prices ? '<th style="width:110px">Price</th>' : ''}</tr>
      ${activityRows}
    </table>` : '';

  /* ---- inclusions / exclusions ---- */
  const incExc = (quote.inclusions?.length || quote.exclusions?.length) ? `
    <table class="grid ie">
      <tr><th class="inc">Inclusions</th><th class="exc">Exclusions</th></tr>
      <tr>
        <td>${(quote.inclusions || []).map((x) => `<p class="li">• ${esc(x)}</p>`).join('')}</td>
        <td>${(quote.exclusions || []).map((x) => `<p class="li">• ${esc(x)}</p>`).join('')}</td>
      </tr>
    </table>` : '';

  /* ---- terms & conditions ---- */
  const tncHtml = tnc ? `
    ${bandRow('Terms and Conditions')}
    ${(company.termsAndConditions || []).map((sec) => `
      <div class="tncsec">
        <p class="tnchead">${esc(sec.heading)}</p>
        ${sec.intro ? `<p class="li">${esc(sec.intro)}</p>` : ''}
        ${sec.table?.rows?.length ? `<table class="grid" style="margin:5px 0 7px">
          <tr>${(sec.table.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
          ${sec.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
        </table>` : ''}
        ${(sec.items || []).map((it) => {
          const m = String(it).match(/^([^:]{3,60}):\s(.*)$/s);
          return `<p class="li">• ${m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(it)}</p>`;
        }).join('')}
      </div>`).join('')}` : '';

  /* ---- bank account ---- */
  const bank0 = (org?.bankAccounts || [])[0] || (company.bank ? { holder: company.bank.holder, bank: company.bank.bank, branch: company.bank.address, ifsc: company.bank.ifsc, accNo: company.bank.accNo } : null);
  const bankHtml = bankAccount && bank0 ? `
    ${bandRow('Bank Account Details')}
    <table class="kvt">
      ${kv('A/c Holder Name', esc(bank0.holder || ''))}
      ${kv('Bank / Branch', `${esc(bank0.bank || '')}${bank0.branch ? ` — ${esc(bank0.branch)}` : ''}`)}
      ${kv('A/c No.', esc(bank0.accNo || ''))}
      ${kv('IFSC', esc(bank0.ifsc || ''))}
    </table>` : '';

  /* ---- helpline ---- */
  const phones = (org?.supportPhones?.length ? org.supportPhones : company.phones) || [];
  const shortName = org?.brandName && org?.officialName && org.brandName !== org.officialName
    ? `${org.brandName} (${org.officialName})` : (org?.officialName || company.name);
  const helpline = `
    <table class="grid help">
      <tr><th colspan="3">Helpline</th></tr>
      <tr><td>${esc(shortName)}</td><td>24x7 Operational</td><td>${phones.map(esc).join(' / ')}</td></tr>
    </table>`;

  /* ---- per-stay confirmation details (single-hotel voucher only) ---- */
  const confirmHtml = (confirmationNumber || voucherContact || voucherNotes || hotelAddress) ? `
    ${bandRow('Booking Confirmation Details')}
    <table class="kvt">
      ${confirmationNumber ? kv('Confirmation No.', `<b>${esc(confirmationNumber)}</b>`) : ''}
      ${voucherContact ? kv('Confirmed By', esc(voucherContact)) : ''}
      ${(hotelAddress || hotelCheckInTime || hotelCheckOutTime) ? kv2('Hotel Address', esc(hotelAddress || '—'), 'Check-In / Check-Out', `${esc(hotelCheckInTime || '—')} / ${esc(hotelCheckOutTime || '—')}`) : ''}
    </table>
    ${voucherNotes ? `<div class="li" style="margin-top:6px">${voucherNotes}</div>` : ''}` : '';

  /* ---- per-type composition ---- */
  const titles = { trip: 'Booking Confirmation Voucher', hotels: 'Hotels Confirmation Voucher', activity: 'Activity Confirmation Voucher' };
  let body = '';
  if (type === 'hotels') {
    body = `${tripTable}${hotelsTable}${confirmHtml}${bankHtml}${helpline}`;
  } else if (type === 'activity') {
    body = `${tripTable}${activitiesTable}${bankHtml}${helpline}`;
  } else {
    body = `${tripTable}
      ${!removeItinerary && dayBlocks ? `${bandRow('Day Wise Itinerary')}${dayBlocks}` : ''}
      ${transportTable}
      ${incExc}
      ${tncHtml}
      ${bankHtml}
      ${helpline}`;
  }

  /* ---- watermark: fixed diagonal repeated text on every page ---- */
  const wmText = `Trip# ${tripId} - Voucher${removeBranding ? '' : ` - ${brand}`}`;
  const wmLine = Array.from({ length: 6 }, () => esc(wmText)).join(' - ');
  const watermark = `<div class="wm">${Array.from({ length: 18 }, () => `<div class="wmline">${wmLine}</div>`).join('')}</div>`;

  const bannerPad = (headerBanner ? 'padding-top: 88px;' : '') + (footerBanner ? 'padding-bottom: 100px;' : '');

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    :root { --blue: #1e56d6; --navy: #14498f; --line: #cdd9e8; --ink: #17202c; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Poppins', Arial, sans-serif; color: var(--ink); font-size: 12px; ${bannerPad} }
    h1 { text-align: center; font-size: 24px; margin: 6px 0 10px; }
    .intro { margin-bottom: 12px; }
    .secband { background: #cfe3f8; color: var(--navy); font-weight: 700; text-align: center; padding: 7px; font-size: 13px; margin: 18px 0 8px; border-radius: 3px; }
    table { width: 100%; border-collapse: collapse; }
    .kvt { margin-top: 12px; }
    .kvt td { border: 1px solid var(--line); padding: 7px 10px; }
    .kvt td.k { width: 16%; background: #fbfcfe; color: #444; }
    .kvt td.v { width: 34%; }
    .kvt td.thead { background: #cfe3f8; color: var(--navy); font-weight: 700; text-align: center; }
    .grid th { background: #eef4fb; color: var(--navy); border: 1px solid var(--line); padding: 7px 9px; text-align: left; font-size: 11.5px; }
    .grid td { border: 1px solid var(--line); padding: 7px 9px; vertical-align: top; }
    .grid td.dcol { background: #fbfcfe; }
    .grid td.amt, .grid th.amt { text-align: right; white-space: nowrap; }
    .grid.help th { background: #fef9c3; color: #854d0e; text-align: center; border-color: #eadfa2; }
    .grid.help td { border-color: #eadfa2; }
    .grid.ie th.inc { color: #15803d; text-align: center; }
    .grid.ie th.exc { color: #b91c1c; text-align: center; }
    .grid.ie td { width: 50%; }
    .dim { color: #6b7684; font-size: 11px; }
    .li { margin: 3px 0; line-height: 1.55; }
    .dayblk { margin: 10px 0 14px; }
    .dayhead { background: #f1f4f8; padding: 6px 10px; border-radius: 3px; margin-bottom: 6px; color: var(--navy); }
    .dayhead .daydate { color: #2563eb; }
    .dayhead .daytitle { font-weight: 700; color: var(--blue); }
    .dline { line-height: 1.65; text-align: justify; margin: 4px 0; }
    .tncsec { margin-bottom: 10px; }
    .tnchead { font-weight: 800; font-size: 14px; margin: 10px 0 4px; }
    /* Fixed elements repeat on every printed page. */
    .pghead { position: fixed; top: 0; left: 0; width: 100%; }
    .footbanner { position: fixed; bottom: 0; left: 0; width: 100%; }
    .wm { position: fixed; top: -12%; left: -30%; width: 170%; height: 130%; transform: rotate(-32deg); z-index: -1; overflow: hidden; }
    .wmline { white-space: nowrap; font-size: 22px; font-weight: 700; color: rgba(30, 86, 214, 0.055); line-height: 62px; }
  </style></head><body>
  ${watermark}
  ${headerBanner ? `<img class="pghead" src="${headerBanner}"/>` : ''}
  ${footerBanner ? `<img class="footbanner" src="${footerBanner}"/>` : ''}
  <h1>${esc(titles[type] || titles.trip)}</h1>
  <p class="intro">We are pleased to confirm the below booking. Please find confirmation details</p>
  ${body}
  </body></html>`;
}
