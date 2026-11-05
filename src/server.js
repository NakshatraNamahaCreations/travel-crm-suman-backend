import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';

async function start() {
  try {
    await connectDB();
  } catch {
    // Surface clearly but keep the process up so the API can report 500s
    // (useful during local dev before the DB URI is configured).
    // eslint-disable-next-line no-console
    console.error('[server] Starting WITHOUT a database connection.');
  }

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });
}

start();

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});
