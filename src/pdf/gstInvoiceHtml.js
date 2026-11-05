import { company } from '../config/company.js';
import { amountInWords } from './proformaHtml.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

// GST tax invoice for a single payment received. Layout mirrors a standard
// Indian tax-invoice format: dark header band with invoice no/date, seller
// letterhead, "Bill To" panel with payment terms alongside it, an items
// table, then CGST+SGST (same state) or IGST (different state) added on top
// of the taxable value, amount in words, and a signatory block.
export function gstInvoiceHtml(inv, org = null) {
  const q = inv.query || {};
  const logo = org?.images?.logo;
  const seller = inv.seller || {};
  const buyer = inv.buyer || {};
  const cur = inv.currency || 'INR';
  const isInter = inv.taxType === 'inter';

  const taxRows = isInter
    ? `<tr><td class="tk">Add : IGST @ ${esc(String(inv.gstPercent ?? 0))}%</td><td class="tv">${inr(inv.igst)}</td></tr>`
    : `<tr><td class="tk">Add : CGST @ ${esc(String((inv.gstPercent ?? 0) / 2))}%</td><td class="tv">${inr(inv.cgst)}</td></tr>
       <tr><td class="tk">Add : SGST @ ${esc(String((inv.gstPercent ?? 0) / 2))}%</td><td class="tv">${inr(inv.sgst)}</td></tr>`;

  const terms = String(inv.terms || '').split('\n').map((l) => l.trim()).filter(Boolean);

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    :root { --navy: #14284f; --line: #17284f; --ink: #17202c; --tint: #e3edf7; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Poppins', Arial, sans-serif; color: var(--ink); font-size: 12.5px; }
    .outer { border: 2px solid var(--navy); }
    .band { background: var(--navy); color: #fff; display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; }
    .band .title { font-size: 20px; font-weight: 800; letter-spacing: 0.08em; }
    .band .meta { text-align: right; font-size: 11.5px; font-weight: 600; }
    .letterhead { text-align: center; padding: 14px 18px 12px; border-bottom: 2px solid var(--navy); }
    .letterhead img { max-height: 54px; max-width: 260px; object-fit: contain; margin-bottom: 4px; }
    .letterhead .name { font-size: 20px; font-weight: 800; }
    .letterhead .line { color: #333; font-size: 11.5px; margin-top: 2px; }
    .parties { display: flex; border-bottom: 2px solid var(--navy); }
    .parties > div { flex: 1; padding: 10px 16px; background: var(--tint); }
    .parties > div + div { border-left: 2px solid var(--navy); }
    .parties .lab { font-weight: 800; font-size: 12px; margin-bottom: 4px; }
    .parties .line { line-height: 1.55; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { border-bottom: 2px solid var(--navy); padding: 7px 10px; font-size: 11px; letter-spacing: 0.04em; text-align: left; font-weight: 800; }
    table.items td { border-bottom: 1px solid #cdd8e6; padding: 8px 10px; vertical-align: top; }
    table.items th.amt, table.items td.amt { text-align: right; white-space: nowrap; }
    table.items tr.total td { border-top: 2px solid var(--navy); border-bottom: none; font-weight: 800; }
    .split { display: flex; border-top: 2px solid var(--navy); }
    .terms { flex: 1; padding: 10px 16px; background: var(--tint); border-right: 2px solid var(--navy); }
    .terms .lab { font-weight: 800; margin-bottom: 6px; }
    .terms ol { padding-left: 18px; }
    .terms li { margin-bottom: 3px; }
    .totals { width: 260px; }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 7px 12px; }
    .totals td.tk { color: #333; }
    .totals td.tv { text-align: right; font-weight: 700; }
    .totals tr.grand td { background: var(--navy); color: #fff; font-weight: 800; font-size: 14px; }
    .words { padding: 12px 18px; border-top: 2px solid var(--navy); }
    .words .lab { font-weight: 800; font-size: 11px; text-decoration: underline; margin-bottom: 4px; }
    .sign { display: flex; justify-content: space-between; align-items: flex-end; padding: 30px 18px 16px; }
    .sign .for { font-weight: 700; }
    .sign .auth { text-decoration: underline; font-size: 11.5px; }
  </style></head><body>
  <div class="outer">
    <div class="band">
      <div class="title">TAX INVOICE</div>
      <div class="meta">INVOICE NO : ${esc(inv.invoiceNumber ?? '')}<br/>DATE : ${fmtDate(inv.invoiceDate || inv.createdAt)}</div>
    </div>
    <div class="letterhead">
      ${logo ? `<img src="${logo}"/>` : ''}
      <div class="name">${esc(seller.name || company.name)}</div>
      <div class="line">${esc(seller.address || (company.address || []).join(', '))}</div>
      <div class="line">GSTIN: ${esc(seller.gstin || company.gstin || '')}${seller.pan ? ` &nbsp; PAN NO. ${esc(seller.pan)}` : ''}</div>
      <div class="line">${seller.email ? `Email ID: ${esc(seller.email)}` : ''}${seller.phone ? ` &nbsp; ${esc(seller.phone)}` : ''}</div>
    </div>
    <div class="parties">
      <div>
        <div class="lab">Bill To: ${esc(buyer.name || 'Guest')}</div>
        <div class="line">${esc(buyer.address || '').replace(/\n/g, '<br/>')}</div>
        ${buyer.email ? `<div class="line">Email ID: ${esc(buyer.email)}</div>` : ''}
        ${buyer.gstin ? `<div class="line">GSTIN: ${esc(buyer.gstin)}</div>` : ''}
        ${inv.placeOfSupply ? `<div class="line">Place of Supply: ${esc(inv.placeOfSupply)}</div>` : ''}
      </div>
      <div>
        <div class="line">Payment Date: ${inv.paymentDate ? fmtDate(inv.paymentDate) : fmtDate(inv.invoiceDate || inv.createdAt)}</div>
        <div class="line">Payment Mode: ${esc(inv.paymentMode || '—')}</div>
      </div>
    </div>
    <table class="items">
      <thead><tr><th>Description</th><th>HSN Code</th><th class="amt">Qty</th><th class="amt">Rate</th><th class="amt">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td>${esc(inv.particulars || 'Payment received')}</td>
          <td>${esc(inv.hsn || '')}</td>
          <td class="amt">1</td>
          <td class="amt">${inr(inv.taxableValue)}</td>
          <td class="amt">${inr(inv.taxableValue)}</td>
        </tr>
        <tr class="total"><td colspan="4" style="text-align:right">Total</td><td class="amt">${inr(inv.taxableValue)}</td></tr>
      </tbody>
    </table>
    <div class="split">
      <div class="terms">
        <div class="lab">Terms &amp; conditions</div>
        ${terms.length ? `<ol>${terms.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : '<div class="line">&mdash;</div>'}
      </div>
      <div class="totals">
        <table>
          ${taxRows}
          <tr><td class="tk">Amount Received :</td><td class="tv">${inr(inv.amountReceived)}</td></tr>
          <tr><td class="tk">Balance Due :</td><td class="tv">${inr(Math.max(0, (inv.amount || 0) - (inv.amountReceived || 0)))}</td></tr>
          <tr class="grand"><td>Grand Total</td><td class="tv">${inr(inv.amount)}</td></tr>
        </table>
      </div>
    </div>
    <div class="words">
      <div class="lab">Total Amount (${esc(cur)} &ndash; In Words) :</div>
      <div>${esc(cur)}: ${esc(amountInWords(inv.amount))}</div>
    </div>
    ${inv.specialNotes ? `<div class="words" style="border-top:none"><div class="lab">Notes</div><div>${esc(inv.specialNotes).replace(/\n/g, '<br/>')}</div></div>` : ''}
    <div class="sign">
      <div></div>
      <div style="text-align:center">
        <div class="for">For : ${esc(seller.name || company.name)}</div>
        <div style="height:46px"></div>
        <div class="auth">Authorised Signatory</div>
      </div>
    </div>
  </div>
  </body></html>`;
}
