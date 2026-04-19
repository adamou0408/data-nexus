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
    // Refresh all resource-derived read models in parallel
    await Promise.allSettled([
      pool.query('SELECT refresh_module_tree_stats()'),
      pool.query('SELECT refresh_resource_ancestors()'),
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const name = i === 0 ? 'module_tree_stats' : 'resource_ancestors';
          console.warn(`[resource-events] Failed to refresh ${name}:`, r.reason);
        }
      });
    });
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
