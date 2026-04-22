// ============================================================
// FEAT-01: LISTEN authz_policy_changed → clear policy cache
//
// Mirrors resource-events.ts shape. V012 triggers fire pg_notify
// on authz_policy / authz_role_permission / authz_subject_role
// mutations. Until this listener landed, no in-process consumer
// existed for the channel.
//
// Conservative invalidation: full clear on any payload, not
// per-user. Cheaper than reasoning about which user_id+groups
// combinations are affected by a role/permission edit.
// ============================================================

import { Client } from 'pg';
import * as policyCache from './policy-cache';

const CHANNEL = 'authz_policy_changed';

let listener: Client | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

// Debounce: bursts of policy edits (e.g. bulk import) collapse to one clear.
const DEBOUNCE_MS = 200;

function scheduleClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    const cleared = policyCache.clearAll();
    if (cleared > 0) {
      console.log(`[policy-events] Cleared ${cleared} cached resolve entries`);
    }
  }, DEBOUNCE_MS);
}

export async function startPolicyEventListener(): Promise<void> {
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
        scheduleClear();
      }
    });

    listener.on('error', (err) => {
      console.warn('[policy-events] Listener error, reconnecting:', err.message);
      reconnect();
    });

    console.log(`[policy-events] Listening on ${CHANNEL}`);
  } catch (err) {
    console.warn('[policy-events] Failed to start listener:', err);
  }
}

function reconnect() {
  listener = null;
  setTimeout(() => startPolicyEventListener(), 5000);
}

export async function stopPolicyEventListener(): Promise<void> {
  if (clearTimer) clearTimeout(clearTimer);
  if (listener) {
    try { await listener.end(); } catch { /* ignore */ }
    listener = null;
  }
}
