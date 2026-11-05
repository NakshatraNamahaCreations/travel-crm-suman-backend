import mongoose from 'mongoose';

// Atomic sequence generator for human-friendly IDs (query numbers, invoice numbers...).
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // sequence key, e.g. 'query'
  seq: { type: Number, default: 0 },
});

counterSchema.statics.next = async function next(key, start = 1) {
  // Single atomic operation: increment by 1, but never go below `start`.
  // Uses MongoDB 4.2+ aggregation pipeline update — no race window.
  const floor = Math.max(start - 1, 0);
  const doc = await this.findOneAndUpdate(
    { _id: key },
    [{ $set: { seq: { $add: [{ $max: [{ $ifNull: ['$seq', floor] }, floor] }, 1] } } }],
    { new: true, upsert: true }
  );
  return doc.seq;
};

// Per-organization sequence: each tenant gets independent numbering under a
// composite key like '<orgId>:query'. The migration renames the old global
// keys to the default org's composite keys so its sequences continue.
counterSchema.statics.nextFor = function nextFor(orgId, key, start = 1) {
  if (!orgId) throw new Error(`Counter.nextFor: missing organization for key '${key}'`);
  return this.next(`${orgId}:${key}`, start);
};

// Raise a sequence to at least `floor` (never lowers it). Used to self-heal
// when a unique-number collision reveals the counter fell behind the numbers
// already present in the collection.
counterSchema.statics.syncFloor = function syncFloor(orgId, key, floor) {
  return this.findOneAndUpdate(
    { _id: `${orgId}:${key}` },
    [{ $set: { seq: { $max: [{ $ifNull: ['$seq', 0] }, floor] } } }],
    { upsert: true, new: true }
  );
};

export const Counter = mongoose.model('Counter', counterSchema);
