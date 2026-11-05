// One-off repair for trip #0195 (booking 7100012). Root cause: the instalment
// number counter fell 11 behind the numbers already used (seq 3800047 vs max
// 3800058), so every instalment insert collided and conversion silently lost
// the schedule. This script:
//   1. resyncs the instalment + payment counters to the max used numbers
//   2. recreates the schedule (49,500 collected + 1,00,000 due at trip start)
//   3. logs the collected 49,500 (ledger mirror + booking paid total),
//      left Pending Verification for the admin to confirm in-app.
// Attributed to the real ATC Admin account. Safe to re-run. Delete afterwards.
import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { runWithTenant } from './src/tenant/context.js';

await mongoose.connect(env.mongoUri);
await import('./src/app.js');
const { generateForBooking } = await import('./src/controllers/installment.controller.js');
const { Counter } = await import('./src/models/Counter.js');
const Booking = mongoose.model('Booking');
const Installment = mongoose.model('Installment');
const Payment = mongoose.model('Payment');
const Quote = mongoose.model('Quote');

const ORG = new mongoose.Types.ObjectId('6a6729205062fecc93834660');
const ADMIN = new mongoose.Types.ObjectId('6a884bffd8b851b3247f67f1'); // ATC Admin
const BOOKING_ID = '6aa54b5e3cf265cf76bcdb67';
const QUOTE_ID = '6aa54b403cf265cf76bcd7f7';

await new Promise((resolve, reject) => {
  runWithTenant(ORG, async () => {
    try {
      // 1. Resync desynced sequence counters (never lowers them).
      const maxInst = await Installment.findOne().sort('-installmentNumber').select('installmentNumber');
      if (maxInst) {
        const c = await Counter.syncFloor(ORG, 'installment', maxInst.installmentNumber);
        console.log('installment counter resynced to', c.seq, '(max used', maxInst.installmentNumber + ')');
      }
      const maxPay = await Payment.findOne().sort('-paymentNumber').select('paymentNumber');
      if (maxPay) {
        const c = await Counter.syncFloor(ORG, 'payment', maxPay.paymentNumber);
        console.log('payment counter resynced to', c.seq, '(max used', maxPay.paymentNumber + ')');
      }

      const booking = await Booking.findById(BOOKING_ID);
      const quote = await Quote.findById(QUOTE_ID);
      console.log('booking total:', booking.totalAmount, '| start:', booking.startDate);

      // 2. The schedule the conversion should have created (skips any
      //    direction that already exists, so re-running is safe).
      const n = await generateForBooking(booking, quote, ADMIN, {
        instalments: [
          { amount: 49500, dueDate: booking.createdAt },
          { amount: 100000, dueDate: booking.startDate },
        ],
      });
      console.log('instalments generated:', n);

      // 3. Log the collected 49,500 on the first instalment (idempotent).
      const rows = await Installment.find({ booking: booking._id, direction: 'incoming' }).sort('dueDate');
      const first = rows[0];
      if (!first) throw new Error('No incoming instalments found after generation');
      if (first.paid) {
        console.log('first instalment already marked paid — skipping payment step');
      } else {
        first.paid = true;
        first.verified = false; // admin verifies in-app
        first.paidAmount = 49500;
        first.paidOn = new Date();
        let payment;
        for (let i = 0; i < 6; i++) {
          try {
            payment = await Payment.create({
              party: 'customer', booking: booking._id, query: booking.query,
              amount: 49500, currency: booking.currency || 'INR', mode: 'Bank Transfer',
              date: first.paidOn, notes: `Installment #${first.installmentNumber}`, createdBy: ADMIN,
            });
            break;
          } catch (e) { if (e.code === 11000 && i < 5) continue; throw e; }
        }
        first.payment = payment._id;
        await first.save();
        await Booking.findByIdAndUpdate(booking._id, { paidAmount: 49500 });
      }

      const final = await Installment.find({ booking: booking._id }).sort('dueDate');
      for (const r of final) console.log(`#${r.installmentNumber} | ${r.direction} | amount ${r.amount} | due ${String(r.dueDate).slice(0, 15)} | paid ${r.paid}${r.paid ? ` (${r.paidAmount}, ${r.verified ? 'verified' : 'pending verification'})` : ''}`);

      // 4. Every conversion since the counter desynced (12 Sep) lost its
      //    schedule the same way — regenerate the default schedule (one
      //    full-amount instalment + supplier outgoing) for each affected
      //    booking. Agents can re-split via Update Payment / Instalments.
      const all = await Booking.find({ totalAmount: { $gt: 0 } }).select('bookingNumber totalAmount quote guest');
      for (const b2 of all) {
        if (String(b2._id) === BOOKING_ID) continue;
        const has = await Installment.countDocuments({ booking: b2._id, direction: 'incoming' });
        if (has > 0) continue;
        const q2 = b2.quote ? await Quote.findById(b2.quote) : null;
        const made = await generateForBooking(b2, q2, ADMIN, {});
        console.log(`repaired booking #${b2.bookingNumber} (${b2.guest?.name || 'Guest'}) — instalments created: ${made}`);
      }
      resolve();
    } catch (e) { reject(e); }
  });
});
console.log('DONE — refresh the trip Accounting tab.');
process.exit(0);
