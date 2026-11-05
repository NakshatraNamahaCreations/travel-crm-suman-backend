import { company } from '../config/company.js';
import { amountInWords } from './proformaHtml.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => `INR: ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Payment receipt for a paid customer instalment (Sembark-style):
 * header banner/logo, blue "Payment Receipt" band, payment table, trip table,
 * paid-so-far status. `totals` = { paid, scheduled } across the trip's
 * incoming instalments including this payment.
 */
export function paymentReceiptHtml(inst, { org = null, mode = '', pax = '', totals = null } = {}) {
  const logo = org?.images?.logo;
  const headerBanner = org?.images?.headerBanner;
  const footerBanner = org?.images?.footerBanner;
  const orgName = org?.officialName || company.name;
  const guestName = [inst.guest?.salutation, inst.guest?.name].filter(Boolean).join(' ') || 'Guest';
  const tripId = inst.tripId || '';
  const row = (k, v, extra = '') => `<tr><td class="k">${k}${extra ? `<div class="sub">${extra}</div>` : ''}</td><td class="v">${v}</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    :root { --blue: #1e56d6; --navy: #14498f; --line: #c8d4e4; --ink: #17202c; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Poppins', Arial, sans-serif; color: var(--ink); font-size: 12.5px; }
    .band { background: var(--blue); color: #fff; text-align: center; font-weight: 800; letter-spacing: 0.05em; padding: 7px; font-size: 14px; }
    .logoRow { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .logo { width: 42px; height: 42px; border-radius: 10px; background: var(--blue); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 21px; font-weight: 800; }
    .bn { font-size: 15.5px; font-weight: 800; color: var(--navy); }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    td { border: 1px solid var(--line); padding: 7px 11px; vertical-align: top; }
    td.k { width: 34%; background: #f2f6fb; font-weight: 700; color: var(--ink); }
    td.k .sub { font-weight: 400; font-size: 10.5px; color: #6b7684; margin-top: 2px; }
    td.v { font-weight: 600; }
    .gen { text-align: right; color: #6b7684; font-size: 10.5px; margin-top: 14px; }
    .foot { text-align: center; color: #6b7684; margin-top: 8px; font-size: 11.5px; }
    /* Fixed elements repeat on EVERY printed page — pins the footer banner to
       the bottom of each page; body padding reserves its space. */
    .footbanner { position: fixed; bottom: 0; left: 0; width: 100%; }
  </style>${footerBanner ? '<style>body { padding-bottom: 110px; }</style>' : ''}</head><body>
  ${headerBanner
    ? `<img src="${headerBanner}" style="width:100%;display:block;margin-bottom:8px"/>`
    : `<div class="logoRow">${logo ? `<img src="${logo}" style="height:46px;max-width:210px;object-fit:contain"/>` : `<div class="logo">${esc(orgName.charAt(0))}</div><div class="bn">${esc(orgName)}</div>`}</div>`}
  <div class="band">Payment Receipt</div>
  <table>
    ${row('Payment Date', esc(fmtDate(inst.paidOn)))}
    ${row('Paid By', `${esc(guestName)}${tripId ? ` &ndash; Trip ID: ${esc(tripId)}` : ''}`)}
    ${inst.creditAccount ? row('Credit Account', esc(inst.creditAccount)) : ''}
    ${mode ? row('Mode Of Payment', esc(mode)) : ''}
    ${inst.reference ? row('Reference', esc(inst.reference)) : ''}
    ${row('Amount Paid', inr(inst.paidAmount || inst.amount))}
    ${row('Amount In Words', `INR: ${esc(amountInWords(inst.paidAmount || inst.amount))}`)}
  </table>
  <table>
    ${row('Trip ID', `#${esc(tripId || '—')}`)}
    ${row('Destination', esc((inst.destinations || []).join(', ') || '—'))}
    ${row('Guest Details', `${esc(guestName)}${pax ? ` &ndash; ${esc(pax)}` : ''}`)}
    ${row('Travel Date', inst.startDate ? `From <b>${esc(fmtDate(inst.startDate))}</b>${inst.endDate ? ` to <b>${esc(fmtDate(inst.endDate))}</b>` : ''}` : '—')}
    ${totals ? row('Payment Status', `${inr(totals.paid)} / ${Number(totals.scheduled || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, '(including this payment)') : ''}
  </table>
  <div class="gen">Receipt Generated On ${esc(fmtDateTime(new Date()))}</div>
  <div class="foot">This is a computer generated document. No signature required.</div>
  ${footerBanner ? `<img class="footbanner" src="${footerBanner}"/>` : ''}
  </body></html>`;
}
