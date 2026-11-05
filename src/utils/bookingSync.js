import { Booking } from '../models/Booking.js';
import { Installment } from '../models/Installment.js';
import { Query } from '../models/Query.js';
import { healCounterFromDup } from '../controllers/installment.controller.js';

const sumAmounts = (items) => (items || []).reduce((s, it) => s + (Number(it.amount) || 0), 0);

// The trip (query) shows the dates and pax of the quote it was converted on.
// A lead may start as "20 Sep, 6 nights" and be sold as "21 Sep, 7 nights";
// once converted, the trip header, hotel lines and vouchers must all agree.
export function tripBasicsFrom(quote) {
  const out = {};
  if (quote.startDate) out.startDate = quote.startDate;
  if (quote.nights != null) out.nights = quote.nights;
  if (quote.pax?.adults) {
    out.pax = { adults: quote.pax.adults, children: (quote.pax.children || []).map((c) => ({ age: c.age })) };
  }
  return out;
}

/**
 * Work out how a direction's UNPAID instalments absorb a change in the amount
 * they must add up to. Pure: takes plain rows, returns a plan.
 *
 * @param {{_id:any, amount:number, paidAmount:number}[]} open  unpaid instalments, latest due first
 * @param {number} delta  new required total − current scheduled total
 * @returns {{updates:{_id:any,amount:number}[], removes:any[], create:number, leftover:number}}
 *   create   — amount for a brand-new instalment (increase with nothing open to absorb it)
 *   leftover — part of a decrease that could not be absorbed (customer already paid more)
 */
export function rebalanceInstalments(open, delta) {
  const plan = { updates: [], removes: [], create: 0, leftover: 0 };
  delta = Math.round(delta || 0);
  if (!delta) return plan;

  if (delta > 0) {
    // The last-due instalment grows; with nothing open, a new one is added.
    const last = open[0];
    if (last) plan.updates.push({ _id: last._id, amount: Math.round(last.amount + delta) });
    else plan.create = delta;
    return plan;
  }

  // Decrease: shrink from the last-due instalment backwards, never below what
  // has already been paid against it. Rows that reach zero are dropped.
  let remaining = -delta;
  for (const inst of open) {
    if (remaining <= 0) break;
    const floor = Math.max(0, inst.paidAmount || 0);
    const reducible = Math.max(0, inst.amount - floor);
    const take = Math.min(reducible, remaining);
    if (!take) continue;
    const next = Math.round(inst.amount - take);
    remaining -= take;
    if (next <= 0 && !floor) plan.removes.push(inst._id);
    else plan.updates.push({ _id: inst._id, amount: next });
  }
  plan.leftover = -remaining;
  return plan;
}

async function createInstalment(data) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await Installment.create({ ...data });
    } catch (err) {
      if (err.code === 11000 && attempt < 3) {
        // eslint-disable-next-line no-await-in-loop
        await healCounterFromDup(err, Installment, 'installment', 'installmentNumber');
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function instalmentBase(bookingId, userId) {
  const b = await Booking.findById(bookingId).populate('destinations', 'name').populate('query', 'queryNumber');
  return {
    booking: b._id,
    query: b.query?._id || b.query,
    tripId: b.query?.queryNumber ? String(b.query.queryNumber) : undefined,
    guest: b.guest,
    destinations: (b.destinations || []).map((d) => d.name).filter(Boolean),
    startDate: b.startDate,
    endDate: b.endDate,
    currency: b.currency || 'INR',
    dueDate: b.startDate || new Date(),
    createdBy: userId,
  };
}

// Bring one direction's schedule to `target` by adjusting unpaid instalments.
// Instalments that collect admin-added extras are not part of the package
// schedule, so they are left out of both the sum and the rebalancing.
async function adjustSchedule(booking, direction, target, userId) {
  const extraIds = new Set((booking.extras || []).map((e) => String(e.installment)));
  const all = (await Installment.find({ booking: booking._id, direction }).sort('-dueDate -createdAt'))
    .filter((i) => !extraIds.has(String(i._id)));
  const scheduled = sumAmounts(all);
  const delta = Math.round(target - scheduled);
  const result = { direction, scheduled, target, delta, updated: 0, removed: 0, created: 0, leftover: 0 };
  if (!delta) return result;

  const open = all.filter((i) => !i.paid).map((i) => ({ _id: i._id, amount: i.amount || 0, paidAmount: i.paidAmount || 0 }));
  const plan = rebalanceInstalments(open, delta);

  for (const u of plan.updates) {
    // eslint-disable-next-line no-await-in-loop
    await Installment.updateOne({ _id: u._id }, { amount: u.amount });
  }
  if (plan.removes.length) await Installment.deleteMany({ _id: { $in: plan.removes } });
  if (plan.create > 0) {
    const base = await instalmentBase(booking._id, userId);
    await createInstalment({
      ...base,
      direction,
      amount: plan.create,
      ...(direction === 'outgoing' ? { supplierName: `Suppliers (Trip ${base.tripId || ''})`.trim() } : {}),
    });
  }
  Object.assign(result, { updated: plan.updates.length, removed: plan.removes.length, created: plan.create, leftover: plan.leftover });
  return result;
}

/**
 * A converted (accepted) quote is the live contract behind its booking. When
 * it is edited in place, copy the new price / itinerary / cost snapshot onto
 * the booking and rebalance the unpaid instalments so Accounting shows the
 * same figure as the quote. No-op when the quote has no booking.
 */
export async function syncBookingFromQuote(quote, userId) {
  const booking = await Booking.findOne({ quote: quote._id });
  if (!booking) return null;

  // Package price comes from the quote; admin-added extras sit on top of it.
  const extras = sumAmounts(booking.extras);
  const packageTotal = Math.round(quote.pricing?.total || 0);
  const before = { total: booking.totalAmount || 0, cost: sumAmounts(booking.costItems) };
  const after = { total: packageTotal + extras, cost: sumAmounts(quote.costItems) };

  const newStart = quote.startDate ? new Date(quote.startDate) : null;
  const datesChanged = (newStart && +newStart !== +(booking.startDate || 0)) || (quote.nights != null && quote.nights !== booking.nights);

  if (quote.title) booking.title = quote.title;
  if (quote.currency) booking.currency = quote.currency;
  if (newStart) booking.startDate = newStart;
  if (quote.nights != null) booking.nights = quote.nights;
  if (datesChanged) booking.endDate = undefined; // pre-validate recomputes it
  if (quote.pax) booking.pax = quote.pax;
  booking.days = quote.days || [];
  booking.costItems = quote.costItems || [];
  booking.totalAmount = after.total;
  await booking.save();

  // The trip header follows the converted quote's dates / nights / pax.
  const basics = tripBasicsFrom(quote);
  let tripChanged = false;
  if (Object.keys(basics).length) {
    const trip = await Query.findById(quote.query).select('startDate nights pax');
    tripChanged = !!trip && (
      (basics.startDate && +new Date(basics.startDate) !== +(trip.startDate || 0))
      || (basics.nights != null && basics.nights !== trip.nights)
    );
    await Query.findByIdAndUpdate(quote.query, basics);
  }

  const incoming = await adjustSchedule(booking, 'incoming', packageTotal, userId);
  const outgoing = await adjustSchedule(booking, 'outgoing', after.cost, userId);
  if (datesChanged) {
    await Installment.updateMany({ booking: booking._id }, { startDate: booking.startDate, endDate: booking.endDate });
  }
  return { booking, before, after, incoming, outgoing, tripChanged, basics };
}
