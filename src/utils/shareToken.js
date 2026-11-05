import crypto from 'node:crypto';

// Unguessable token used in customer-facing document links (quotation,
// receipt, GST invoice). 128 bits of entropy — the link itself is the
// credential, so it must not be enumerable. Clearing the field on a document
// revokes any link already shared for it.
export const newShareToken = () => crypto.randomBytes(16).toString('hex');

// Returns the doc's existing token, minting and saving one on first use.
export async function ensureShareToken(doc) {
  if (!doc.shareToken) {
    doc.shareToken = newShareToken();
    await doc.save();
  }
  return doc.shareToken;
}

// Schema fragment applied to every shareable document. Not `select: false` —
// CRM staff are allowed to see it (they generate the links); it's only the
// public routes that treat the token as the credential.
export const shareTokenField = {
  shareToken: { type: String, index: true },
};
