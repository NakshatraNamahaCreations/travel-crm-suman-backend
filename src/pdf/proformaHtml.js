import { company } from '../config/company.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => `INR ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Indian-system number → words ("Four Hundred Twenty Only").
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n) => `${Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${n % 100 ? two(n % 100) : ''}`;
export function amountInWords(num) {
  let n = Math.floor(Math.abs(Number(num) || 0));
  if (!n) return 'Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return `${parts.join(' ')} Only`;
}

// Proforma invoice document — used for the server PDF; the client preview
// mirrors this layout in JSX. Sembark-style: blue title band, seller/buyer,
// particulars table, amount in words, seller's bank details.
export function proformaHtml(inv, org = null) {
  const q = inv.query || {};
  const logo = org?.images?.logo;
  // Header banner intentionally NOT used here — the blue band + logo row is
  // the header (Sembark-style); only the footer banner renders.
  const footerBanner = org?.images?.footerBanner;
  const seller = inv.seller || {};
  const buyer = inv.buyer || {};
  // Bank block: invoice snapshot first (chosen from the org profile), static
  // config as the legacy fallback.
  const bank = inv.bank && (inv.bank.accNo || inv.bank.bank) ? { ...inv.bank, address: inv.bank.branch } : (company.bank || {});
  const rows = (inv.items || []).map((it, i) => `
    <tr>
      <td class="sno">${i + 1}.</td>
      <td class="part">${esc(it.particular).replace(/\n/g, '<br/>')}${it.hsn ? `<div class="hsn">HSN/SAC: ${esc(it.hsn)}</div>` : ''}</td>
      ${inv.hideTaxBreakup ? '' : `<td class="amt">${it.qty || 1}</td>`}
      <td class="amt">${inr(it.total ?? (it.qty || 1) * (it.amount || 0))}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    :root { --blue: #1e56d6; --navy: #14498f; --line: #d7e1ee; --ink: #17202c; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Poppins', Arial, sans-serif; color: var(--ink); font-size: 12.5px; }
    .band { background: var(--blue); color: #fff; text-align: center; font-weight: 800; letter-spacing: 0.06em; padding: 8px; font-size: 14px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; margin: 16px 0 6px; gap: 14px; }
    .logo { width: 44px; height: 44px; border-radius: 10px; background: var(--blue); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; }
    .bn { font-size: 16px; font-weight: 800; color: var(--navy); }
    .metas { display: flex; gap: 26px; text-align: right; }
    .metas .k { font-size: 11px; color: #6b7684; }
    .metas .v { font-weight: 700; }
    .parties { display: flex; justify-content: space-between; gap: 30px; margin: 14px 0 4px; }
    .lab { font-size: 10.5px; letter-spacing: 0.08em; color: #6b7684; font-weight: 700; margin-bottom: 3px; }
    .pname { font-size: 15px; font-weight: 800; color: var(--navy); }
    .addr { font-style: italic; color: #333; line-height: 1.5; }
    .muted { color: #6b7684; }
    .buyer { text-align: right; }
    hr { border: 0; border-top: 1.6px solid var(--navy); margin: 12px 0; opacity: 0.35; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th { background: #dbe8fb; color: var(--ink); border: 1px solid #b9cfec; padding: 7px 9px; font-size: 11.5px; letter-spacing: 0.06em; text-align: left; }
    th.amt, td.amt { text-align: right; white-space: nowrap; }
    td { border: 1px solid var(--line); padding: 8px 9px; vertical-align: top; }
    td.sno { width: 44px; }
    td.part { line-height: 1.55; }
    .hsn { color: #6b7684; font-size: 11px; margin-top: 3px; }
    tfoot td { font-weight: 800; border: 1px solid var(--line); }
    .words { display: flex; justify-content: space-between; align-items: flex-end; margin: 10px 0 2px; }
    .words .k { font-size: 10.5px; letter-spacing: 0.08em; color: #6b7684; font-weight: 700; }
    .words .v { font-weight: 800; }
    .eoe { color: #6b7684; font-size: 11.5px; }
    .bank { margin-top: 10px; padding: 4px 0 0 16px; }
    .bank .lab { margin-bottom: 5px; }
    .bank div { line-height: 1.6; }
    .notes { margin-top: 12px; }
    .notes p { line-height: 1.55; color: #333; }
    .foot { text-align: center; color: #6b7684; margin-top: 26px; font-size: 12px; }
    /* Fixed elements repeat on EVERY printed page — pins the footer banner to
       the bottom of each page; body padding reserves its space. */
    .footbanner { position: fixed; bottom: 0; left: 0; width: 100%; }
  </style>${footerBanner ? '<style>body { padding-bottom: 110px; }</style>' : ''}</head><body>
  <div class="band">PROFORMA INVOICE</div>
  <div class="head">
    <div style="display:flex;align-items:center;gap:10px">
      ${logo
        ? `<img src="${logo}" style="height:52px;max-width:220px;object-fit:contain"/>`
        : `<div class="logo">${esc((seller.name || company.name || 'T').charAt(0))}</div><div class="bn">${esc(seller.name || company.name)}</div>`}
    </div>
    <div class="metas">
      <div><div class="k">Issue Date</div><div class="v">${fmtDate(inv.createdAt)}</div></div>
      <div><div class="k">Due Date</div><div class="v">${fmtDate(inv.dueDate || inv.createdAt)}</div></div>
      <div><div class="k">Trip ID</div><div class="v">${esc(q.queryNumber ?? '')}</div></div>
    </div>
  </div>
  <div class="parties">
    <div>
      <div class="lab">SELLER</div>
      <div class="pname">${esc(seller.name || company.name)}</div>
      <div class="addr">${esc(seller.address || (company.address || []).join(' ')).replace(/\n/g, '<br/>')}</div>
      <div>${esc(seller.phone || company.phones?.[0] || '')} &bull; ${esc(seller.email || company.emails?.[0] || '')}</div>
      ${seller.gstin || company.gstin ? `<div class="muted">GSTIN: ${esc(seller.gstin || company.gstin)}</div>` : ''}
    </div>
    <div class="buyer">
      <div class="lab">BUYER (BILL TO)</div>
      <div class="pname">${esc(buyer.name || 'Guest')}</div>
      <div class="muted">${esc(buyer.address || 'N/A').replace(/\n/g, '<br/>')}</div>
    </div>
  </div>
  <hr/>
  ${inv.overview ? `<p style="margin-bottom:6px">${esc(inv.overview)}</p>` : ''}
  <table>
    <thead><tr><th>S.NO.</th><th>PARTICULARS</th>${inv.hideTaxBreakup ? '' : '<th class="amt">QTY</th>'}<th class="amt">AMOUNT (${esc(inv.currency || 'INR')})</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="${inv.hideTaxBreakup ? 2 : 3}" style="text-align:right">Total (${esc(inv.currency || 'INR')})</td><td class="amt">${inr(inv.total)}</td></tr></tfoot>
  </table>
  <div class="words">
    <div><div class="k">AMOUNT CHARGEABLE (IN WORDS)</div><div class="v">${esc(inv.currency || 'INR')}: ${esc(amountInWords(inv.total))}</div></div>
    <div class="eoe">E. &amp; O.E.</div>
  </div>
  <hr/>
  <div class="bank">
    <div class="lab">SELLER&rsquo;S BANK DETAILS</div>
    ${inv.bankAccount ? `<div><b>Account:</b> ${esc(inv.bankAccount)}</div>` : ''}
    <div>Bank Name: ${esc(bank.bank || '')}</div>
    <div>A/c Holder Name: ${esc(bank.holder || '')}</div>
    <div>A/c No. ${esc(bank.accNo || '')}</div>
    <div>IFSC: ${esc(bank.ifsc || '')}</div>
    ${bank.address ? `<div>Branch: ${esc(bank.address)}</div>` : ''}
  </div>
  ${inv.specialNotes ? `<div class="notes"><div class="lab">SPECIAL NOTES</div><p>${esc(inv.specialNotes).replace(/\n/g, '<br/>')}</p></div>` : ''}
  ${inv.terms ? `<div class="notes"><div class="lab">TERMS AND CONDITIONS</div><p>${esc(inv.terms).replace(/\n/g, '<br/>')}</p></div>` : ''}
  <div class="foot">This is a computer generated document. No signature required.</div>
  ${footerBanner ? `<img class="footbanner" src="${footerBanner}"/>` : ''}
  </body></html>`;
}
