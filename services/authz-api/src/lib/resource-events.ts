import { Client } from 'pg';
import { pool } from '../db';

const CHANNEL = 'authz_resource_changed';

let listener: Client | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Debounce: batch rapid mutations into a single refresh (500ms window)
const DEBOUNCE_MS = 500;

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      await pool.query('SELECT refresh_module_tree_stats()');
    } catch (err) {
      console.warn('[resource-events] Failed to refresh module_tree_stats:', err);
    }
  }, DEBOUNCE_MS);
}

export async function startResourceEventListener(): Promise<void> {
  try {
    listener = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '15432'),
      database: process.env.DB_NAME || 'nexus_authz',
      user: process.env.DB_USER || 'nexus_admin',
      password: process.env.DB_PASSWORD || 'nexus_dev_password',
    });

    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);

    listener.on('notification', (msg) => {
      if (msg.channel === CHANNEL) {
        scheduleRefresh();
      }
    });

    listener.on('error', (err) => {
      console.warn('[resource-events] Listener error, reconnecting:', err.message);
      reconnect();
    });

    console.log(`[resource-events] Listening on ${CHANNEL}`);
  } catch (err) {
    console.warn('[resource-events] Failed to start listener:', err);
  }
}

function reconnect() {
  listener = null;
  setTimeout(() => startResourceEventListener(), 5000);
}

export async function stopResourceEventListener(): Promise<void> {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (listener) {
    try { await listener.end(); } catch { /* ignore */ }
    listener = null;
  }
}
