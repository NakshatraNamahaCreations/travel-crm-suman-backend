/**
 * Picks which quotation layout an organization's document uses.
 *
 * One dispatcher rather than a choice repeated at each of the six places a quotation is
 * rendered (preview, PDF, pre-warm, email, share link): with the choice spread out, the
 * customer-facing share link would sooner or later serve a different layout from the one the
 * agent approved on screen.
 *
 * Unknown or missing values fall back to 'classic', which is what every existing
 * organization has been receiving.
 */

import { quotationHtml } from './quotationHtml.js';
import { quotationModernHtml } from './quotationModernHtml.js';

export const QUOTATION_TEMPLATES = [
  {
    key: 'classic',
    label: 'Classic brochure',
    description: 'The original full-bleed brochure cover with the services strip and gallery pages.',
  },
  {
    key: 'modern',
    label: 'Modern letterhead',
    description: 'Letterhead on every page, a quote summary, accommodation cards, a day table and a closing contact page.',
  },
];

const RENDERERS = { classic: quotationHtml, modern: quotationModernHtml };

/** @param {object} quote plain quote object  @param {object|null} org plain OrgProfile */
export function renderQuotation(quote, org = null) {
  const key = org?.quotation?.template;
  return (RENDERERS[key] || quotationHtml)(quote, org);
}
