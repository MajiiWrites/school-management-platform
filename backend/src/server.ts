import { app } from './app';
import { config } from './config';
import { getDb } from './lib/db';
import { registerJobs } from './jobs/registry';

// Scheduler: monthly fee reminders (1st), fee follow-ups, daily teacher
// reminders + pending-attendance check (see jobs/MOUNT.md). Started here so
// the API process owns the ticks; jobs never throw on a single school's
// failure (errors are recorded per school and the tick continues).
const jobs = registerJobs(getDb());

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${config.port} (env=${config.nodeEnv})`);
  // eslint-disable-next-line no-console
  console.log('[api] Prisma client loads lazily — run `npx prisma generate` in backend/ if you see a "client not generated" error on first request.');
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} received — shutting down`);
  jobs.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
