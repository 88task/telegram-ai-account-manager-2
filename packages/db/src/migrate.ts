import { initDb, pool } from './index.js';

async function migrate(): Promise<void> {
  try {
    await initDb();
  } finally {
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error('[DB] Schema initialization failed:', error);
  process.exitCode = 1;
});
