/* Bootstraps the platform owner account from OWNER_EMAIL / OWNER_PASSWORD /
   OWNER_NAME env vars. Idempotent — safe to re-run; updates name/password and
   re-activates if the account already exists. Usage: npm run bootstrap:owner */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { User } from '../models/User.js';

// Shared with the migration script — expects an open mongoose connection.
export async function ensureOwner() {
  const { email, password, name } = env.owner;
  if (!email || !password) {
    throw new Error('OWNER_EMAIL and OWNER_PASSWORD must be set in server/.env');
  }
  let owner = await User.findOne({ email }).select('+password +isActive');
  if (owner) {
    owner.role = 'owner';
    owner.organization = undefined;
    owner.name = name || owner.name;
    owner.password = password; // re-hashed by pre-save hook
    owner.isActive = true;
    await owner.save();
    console.log(`[owner] Updated existing platform owner: ${email}`);
  } else {
    owner = await User.create({ name, email, password, role: 'owner' });
    console.log(`[owner] Created platform owner: ${email}`);
  }
  return owner;
}

// Run directly (not imported by the migration).
if (process.argv[1] && /create-owner\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  try {
    await connectDB();
    await ensureOwner();
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[owner] Failed:', err.message);
    process.exit(1);
  }
}
