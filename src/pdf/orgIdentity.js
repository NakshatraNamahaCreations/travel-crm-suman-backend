// Who the printed document says it comes from.
//
// Every renderer used to fall back to the single company baked into config/company.js when a
// field was missing. On a multi-tenant deployment that is not a harmless default: an agency
// that had not yet filled in its bank details had another agency's account number printed on
// its proforma invoice, and a guest paying that invoice would have wired the money to the
// wrong company. The same went for the GSTIN on tax invoices.
//
// So there is no shared fallback here. Details come from the document's own snapshot (taken
// when it was created) and then from the tenant's profile. Anything nobody has filled in comes
// back empty, and the caller omits that block rather than printing someone else's.

const clean = (v) => String(v ?? '').trim();
const first = (...vals) => vals.map(clean).find(Boolean) || '';
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

/** Picks the address marked primary, else the first one. */
function pickAddress(addresses) {
  const arr = Array.isArray(addresses) ? addresses : [];
  return arr.find((a) => a?.primary) || arr[0] || {};
}

/**
 * The agency's identity for a document.
 * @param org   the tenant's OrgProfile (may be null — a brand-new tenant has none yet)
 * @param snap  the seller snapshot the document stored at creation, which wins when present
 *              so a reissued invoice still shows the details it was issued under
 */
export function orgIdentity(org, snap = null) {
  const s = snap || {};
  const billing = pickAddress(org?.billingAddresses);
  const contact = pickAddress(org?.contactAddresses);

  const phones = list(org?.supportPhones);
  const emails = list(org?.emails);
  const addressText = first(s.address, contact.address, billing.address);

  const website = first(org?.website);
  return {
    // `brandName` is what guests know the agency as; `officialName` is the registered entity.
    name: first(s.name, org?.brandName, org?.officialName),
    officialName: first(org?.officialName, org?.brandName),
    website,
    // Printed on the letterhead pill, where the scheme is noise.
    websiteLabel: website.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
    phones: phones.length ? phones : list([s.phone, contact.phone, billing.phone]),
    emails: emails.length ? emails : list([s.email, contact.email, billing.email]),
    phone: first(s.phone, phones[0], contact.phone, billing.phone),
    email: first(s.email, emails[0], contact.email, billing.email),
    addressLines: addressText ? addressText.split('\n').map(clean).filter(Boolean) : [],
    addressLine: addressText ? addressText.split('\n').map(clean).filter(Boolean).join(', ') : '',
    gstin: first(s.gstin, billing.gstin),
    pan: first(s.pan),
    logo: first(org?.images?.logo),
    tagline: first(org?.quotation?.tagline),
  };
}

/**
 * The account a guest is asked to pay into. Returns null when the tenant has not set one, so
 * the caller leaves the payment block out entirely. Printing a partially-filled or borrowed
 * account is worse than printing none: the guest would act on it.
 */
export function orgBank(org, snap = null) {
  const s = snap || {};
  if (s.accNo || s.bank) {
    return {
      holder: clean(s.holder), bank: clean(s.bank),
      branch: first(s.branch, s.address), ifsc: clean(s.ifsc), accNo: clean(s.accNo),
    };
  }
  const acc = (Array.isArray(org?.bankAccounts) ? org.bankAccounts : [])[0];
  if (!acc || !(clean(acc.accNo) || clean(acc.bank))) return null;
  return {
    holder: clean(acc.holder), bank: clean(acc.bank),
    branch: first(acc.branch, acc.address), ifsc: clean(acc.ifsc), accNo: clean(acc.accNo),
  };
}
