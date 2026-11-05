// Starter WhatsApp message templates copied into each new organization.
//
// These are DATA, not behaviour: a template names the Gallabox template it
// sends as, the message copy with {{placeholders}}, and — for each placeholder
// — which value source fills it. The sources themselves live on the client
// (client/src/lib/templateSources.js), because that is where a trip's query /
// quote / booking / instalment context is already assembled; here we only
// store the source's key.
//
// A tenant can edit, add or delete any of these from the WhatsApp module, so
// this catalog is only the starting point, never the live copy.

export const TEMPLATE_STAGES = [
  { key: 'quote', label: 'Quotation' },
  { key: 'payment', label: 'Payments' },
  { key: 'booking', label: 'Booking & Travel' },
  { key: 'other', label: 'Other' },
];

export const TEMPLATE_STAGE_KEYS = TEMPLATE_STAGES.map((s) => s.key);

// Document kinds a template can mint a public customer link for. `as` is the
// placeholder-source name that link is handed to.
export const TEMPLATE_DOC_KINDS = ['quote', 'receipt', 'invoice', 'voucher'];

const v = (name, source) => ({ name, source });

export const DEFAULT_WHATSAPP_TEMPLATES = [
  {
    key: 'quotation_sent',
    label: 'Quotation Sent',
    name: 'quotation_sent',
    stage: 'quote',
    needs: { kind: 'quote', as: 'quotation_link' },
    body: `🏝️ *Your {{destination}} Holiday Quotation Is Ready*

Hi {{customer_name}} 👋

Thank you for choosing {{company_short}}.

Your customized {{destination}} holiday quotation is ready:

📅 Travel dates: {{travel_dates}}
👨‍👩‍👧‍👦 Travellers: {{traveller_count}}
🏝️ Duration: {{duration}}
💰 Package value: ₹{{amount}}

📄 View your quotation: {{quotation_link}}

Please review the itinerary and let us know if you'd like any changes.`,
    variables: [
      v('destination', 'destination'),
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('travel_dates', 'travel_dates'),
      v('traveller_count', 'traveller_count'),
      v('duration', 'duration'),
      v('amount', 'package_value'),
      v('quotation_link', 'quotation_link'),
    ],
  },
  {
    key: 'enquiry_received',
    label: 'Enquiry Received',
    name: 'enquiry_received',
    stage: 'quote',
    body: `🙏 *Thank You for Your Enquiry*

Hi {{customer_name}} 👋

We've received your enquiry for {{destination}} and our holiday expert is already working on it.

🔖 Reference: {{trip_no}}
📅 Travel dates: {{travel_dates}}
👨‍👩‍👧‍👦 Travellers: {{traveller_count}}

You'll receive a customized quotation shortly. For anything urgent, call us on {{company_phone}}.`,
    variables: [
      v('customer_name', 'guest_name'),
      v('destination', 'destination'),
      v('trip_no', 'trip_no'),
      v('travel_dates', 'travel_dates'),
      v('traveller_count', 'traveller_count'),
      v('company_phone', 'company_phone'),
    ],
  },
  {
    key: 'quotation_followup',
    label: 'Quotation Follow-up',
    name: 'quotation_followup',
    stage: 'quote',
    needs: { kind: 'quote', as: 'quotation_link' },
    body: `*Quotation Follow-up*

Hi {{customer_name}} 👋

Just checking in regarding your {{company_short}} holiday quotation for {{travel_dates}}. 🏝️

If you'd like changes to hotels, itinerary, activities, duration or budget, our team will be happy to customize it.

📄 View your quotation: {{quotation_link}}

If everything looks good, reply "APPROVE" and we'll take you through the next steps.`,
    variables: [
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('travel_dates', 'travel_dates'),
      v('quotation_link', 'quotation_link'),
    ],
  },
  {
    key: 'payment_request',
    label: 'Quotation Approved — Payment Request',
    name: 'payment_request',
    stage: 'payment',
    body: `*Quotation Approved - Payment Request*

Hi {{customer_name}} 👋

Your {{company_short}} package has been approved and is ready for booking.

💰 Amount payable: ₹{{payment_amount}}

💳 Make Payment: {{payment_link}}

Once payment is received, we'll proceed with the hotel, transfer and travel arrangements.`,
    variables: [
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('payment_amount', 'amount_due'),
      v('payment_link', 'payment_link'),
    ],
  },
  {
    key: 'payment_receipt',
    label: 'Payment Receipt',
    name: 'payment_receipt',
    stage: 'payment',
    needs: { kind: 'receipt', as: 'receipt_link' },
    body: `✅ *Payment Receipt*

Hi {{customer_name}},

Thank you for your payment towards your {{company_short}} holiday package.

💰 Amount received: ₹{{amount}}
🧾 Receipt No.: {{receipt_number}}
📅 Payment Date: {{payment_date}}

📄 View / Download Receipt: {{receipt_link}}

Your booking arrangements will continue as planned. 🏝️`,
    variables: [
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('amount', 'amount_paid'),
      v('receipt_number', 'receipt_number'),
      v('payment_date', 'payment_date'),
      v('receipt_link', 'receipt_link'),
    ],
  },
  {
    key: 'next_instalment',
    label: 'Next Instalment Reminder',
    name: 'next_instalment_reminder',
    stage: 'payment',
    body: `🏝️ *Next Instalment Reminder – {{company_short}}*

Hi {{customer_name}},

Thank you for your initial payment. ❤️

The next instalment of ₹{{pending_amount}} is now due, so our team can confirm your hotels, transfers and tickets.

📅 Travel dates: {{travel_dates}}
💰 Next instalment: ₹{{pending_amount}}

💳 Complete Payment: {{payment_link}}

If you've already paid, simply share the payment reference with us.`,
    variables: [
      v('company_short', 'company_short'),
      v('customer_name', 'guest_name'),
      v('pending_amount', 'balance_due'),
      v('travel_dates', 'travel_dates'),
      v('payment_link', 'payment_link'),
    ],
  },
  {
    key: 'instalment_overdue',
    label: 'Instalment Overdue',
    name: 'instalment_overdue',
    stage: 'payment',
    body: `⏰ *Payment Reminder – {{company_short}}*

Hi {{customer_name}},

Your instalment of ₹{{pending_amount}} was due on {{due_date}} and we haven't received it yet.

📅 Travel dates: {{travel_dates}}
💰 Amount pending: ₹{{pending_amount}}

💳 Complete Payment: {{payment_link}}

Hotels and transfers are held only until this payment clears, so please complete it at the earliest. If you've already paid, share the payment reference and we'll update our records.`,
    variables: [
      v('company_short', 'company_short'),
      v('customer_name', 'guest_name'),
      v('pending_amount', 'balance_due'),
      v('due_date', 'due_date'),
      v('travel_dates', 'travel_dates'),
      v('payment_link', 'payment_link'),
    ],
  },
  {
    key: 'balance_cleared',
    label: 'Full Payment Received',
    name: 'balance_cleared',
    stage: 'payment',
    needs: { kind: 'receipt', as: 'receipt_link' },
    body: `✅ *Full Payment Received — Thank You!*

Hi {{customer_name}},

We've received the full payment for your {{destination}} holiday package. There is nothing further pending. 🎉

💰 Total paid: ₹{{amount_paid}}
🧾 Booking No.: {{booking_no}}

📄 View / Download Receipt: {{receipt_link}}

Your travel documents will reach you shortly before departure. 🏝️`,
    variables: [
      v('customer_name', 'guest_name'),
      v('destination', 'destination'),
      v('amount_paid', 'amount_paid'),
      v('booking_no', 'booking_no'),
      v('receipt_link', 'receipt_link'),
    ],
  },
  {
    key: 'proforma_invoice',
    label: 'Proforma Invoice',
    name: 'proforma_invoice',
    stage: 'payment',
    needs: { kind: 'invoice', as: 'invoice_link' },
    body: `📄 *Proforma Invoice*

Hi {{customer_name}},

Your proforma invoice for the {{destination}} holiday package is ready.

Invoice No.: {{invoice_number}}
Invoice Date: {{invoice_date}}
Amount: ₹{{invoice_amount}}

📄 View / Download: {{invoice_link}}

This is a proforma for your approval — the tax invoice follows once payment is received.`,
    variables: [
      v('customer_name', 'guest_name'),
      v('destination', 'destination'),
      v('invoice_number', 'invoice_number'),
      v('invoice_date', 'invoice_date'),
      v('invoice_amount', 'invoice_amount'),
      v('invoice_link', 'invoice_link'),
    ],
  },
  {
    key: 'gst_invoice',
    label: 'GST Invoice',
    name: 'gst_invoice',
    stage: 'payment',
    needs: { kind: 'invoice', as: 'invoice_link' },
    body: `🧾 *GST Invoice*

Hi {{customer_name}},

Your GST Invoice for your {{destination}} holiday package has been generated.

Invoice No.: {{invoice_number}}
Invoice Date: {{invoice_date}}
Invoice Amount: ₹{{invoice_amount}}

📄 View / Download Invoice: {{invoice_link}}

Please keep this invoice for your records.`,
    variables: [
      v('customer_name', 'guest_name'),
      v('destination', 'destination'),
      v('invoice_number', 'invoice_number'),
      v('invoice_date', 'invoice_date'),
      v('invoice_amount', 'invoice_amount'),
      v('invoice_link', 'invoice_link'),
    ],
  },
  {
    key: 'package_confirmed',
    label: 'Package Confirmed',
    name: 'package_confirmed',
    stage: 'booking',
    needs: { kind: 'quote', as: 'booking_link' },
    body: `🎉 *Your {{destination}} Holiday Is Confirmed!*

Hi {{customer_name}},

We're happy to officially confirm your {{company_short}} holiday package.

🏝️ Package: {{package_name}}
📅 Travel dates: {{travel_dates}}
👨‍👩‍👧‍👦 Travellers: {{traveller_count}}
🏨 Hotels: {{hotel_summary}}
🛥️ Transfers: {{transfer_summary}}

📄 View confirmed package: {{booking_link}}`,
    variables: [
      v('destination', 'destination'),
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('package_name', 'package_name'),
      v('travel_dates', 'travel_dates'),
      v('traveller_count', 'traveller_count'),
      v('hotel_summary', 'hotel_summary'),
      v('transfer_summary', 'transfer_summary'),
      v('booking_link', 'booking_link'),
    ],
  },
  {
    key: 'travel_documents',
    label: 'Final Travel Documents',
    name: 'travel_documents',
    stage: 'booking',
    needs: { kind: 'voucher', as: 'document_link' },
    body: `🏝️ *Your {{destination}} Travel Documents Are Ready!*

Hi {{customer_name}},

Your final travel documents are ready — hotel details, transfer details, sightseeing plan, day-wise itinerary and activity details.

📄 View Your Travel Documents: {{document_link}}

Please keep these accessible during your trip. Our local team will assist you throughout. 🌊`,
    variables: [
      v('destination', 'destination'),
      v('customer_name', 'guest_name'),
      v('document_link', 'document_link'),
    ],
  },
  {
    key: 'pre_departure',
    label: 'Pre-Departure Reminder',
    name: 'pre_departure',
    stage: 'booking',
    needs: { kind: 'voucher', as: 'document_link' },
    body: `✈️ *Your {{destination}} Trip Starts Soon!*

Hi {{customer_name}},

Your holiday begins on {{start_date}} — here's everything in one place.

🏨 Hotels: {{hotel_summary}}
🛥️ Transfers: {{transfer_summary}}
👨‍👩‍👧‍👦 Travellers: {{traveller_count}}

📄 Travel Documents: {{document_link}}

Please carry a valid photo ID for every traveller and keep your documents handy. Anything you need, call us on {{company_phone}}. 🌊`,
    variables: [
      v('destination', 'destination'),
      v('customer_name', 'guest_name'),
      v('start_date', 'start_date'),
      v('hotel_summary', 'hotel_summary'),
      v('transfer_summary', 'transfer_summary'),
      v('traveller_count', 'traveller_count'),
      v('document_link', 'document_link'),
      v('company_phone', 'company_phone'),
    ],
  },
  {
    key: 'post_trip_review',
    label: 'Post-Trip / Review',
    name: 'post_trip_review',
    stage: 'booking',
    body: `❤️ *We Hope You Had an Amazing {{destination}} Journey*

Hi {{customer_name}},

We hope you had a wonderful time exploring {{destination}} with {{company_short}}. 🏝️🌊

If you enjoyed your experience, we'd truly appreciate a review.

⭐ Share your experience: {{review_link}}

Thank you once again — we hope to welcome you back soon!`,
    variables: [
      v('destination', 'destination'),
      v('customer_name', 'guest_name'),
      v('company_short', 'company_short'),
      v('review_link', 'review_link'),
    ],
  },
];
