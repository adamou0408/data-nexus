// catalog/useTelemetry.ts
//
// Buffered, fire-and-forget telemetry for the Catalog Workspace. One
// session_id per page-load, events flushed in batches of <=10, idle-flush
// after 2s, and a final sendBeacon flush on pagehide so dwell-on-tab-close
// still lands in the DB.
//
// Failures are swallowed — telemetry never blocks UI or surfaces toasts.

import { useEffect, useRef } from 'react';
import type { CatalogFrame, CatalogPreset } from './types';

const SESSION_KEY = 'catalog.session_id';
const FLUSH_BATCH = 10;
const FLUSH_IDLE_MS = 2000;
const ENDPOINT = '/api/catalog/usage-event';

export type TelemetryTrigger =
  | 'click'
  | 'breadcrumb'
  | 'history'
  | 'cross-tab'
  | 'palette'
  | 'initial';

type EventPayload = {
  session_id: string;
  preset: CatalogPreset;
  frame_kind: CatalogFrame['kind'];
  target_id: string | null;
  action: 'open' | 'close';
  dwell_ms?: number;
  trigger?: TelemetryTrigger;
  context?: Record<string, unknown>;
};

function getSessionId(): string {
  if (typeof window === 'undefined') return 'ssr';
  try {
    let s = window.sessionStorage.getItem(SESSION_KEY);
    if (!s) {
      s = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.sessionStorage.setItem(SESSION_KEY, s);
    }
    return s;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

/** Derive a stable target_id from a frame. card-grid and module-tree map to
 *  null because their identity is the preset itself, not a row.
 *  TODO(catalog-telemetry): module-tree could carry the selectedModuleId, but
 *  that changes as the user clicks within the same frame — using it would
 *  inflate distinct-target counts. Leaving null until we have a stable
 *  per-source key on ModuleTreeFrame. */
export function targetIdForFrame(frame: CatalogFrame): string | null {
  switch (frame.kind) {
    case 'module-detail': return frame.moduleId;
    case 'page-detail':   return frame.pageId;
    case 'table-schema':  return frame.table;
    case 'page-grid':     return frame.filter?.module_id ?? null;
    case 'table-grid':    return frame.filter?.module_id ?? null;
    case 'resource-grid': return frame.resourceType ?? null;
    case 'handler':       return frame.handlerName;
    case 'card-grid':
    case 'module-tree':
    default:              return null;
  }
}

type TelemetryAPI = {
  recordOpen:  (preset: CatalogPreset, frame: CatalogFrame, trigger: TelemetryTrigger) => void;
  recordClose: (preset: CatalogPreset, frame: CatalogFrame, dwellMs: number) => void;
  /** Best-effort synchronous flush via sendBeacon. Caller is responsible for
   *  appending synthesized close events first (e.g. on pagehide). */
  flushBeacon: () => void;
};

export function useTelemetry(): TelemetryAPI {
  const sessionId = useRef<string>(getSessionId());
  const buffer = useRef<EventPayload[]>([]);
  const idleTimer = useRef<number | null>(null);

  const sendBatch = (events: EventPayload[]): void => {
    if (events.length === 0) return;
    const body = JSON.stringify({ events });
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Swallow — telemetry must never break UX.
    });
  };

  const sendBeacon = (events: EventPayload[]): boolean => {
    if (events.length === 0) return true;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    try {
      // 'application/json' would trigger a CORS preflight; same-origin calls
      // here so it's still fine, but Blob is what most browsers prefer for
      // beacon JSON. Fallback to sendBatch on failure.
      const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' });
      return navigator.sendBeacon(ENDPOINT, blob);
    } catch {
      return false;
    }
  };

  const flushNow = (): void => {
    if (buffer.current.length === 0) return;
    const batch = buffer.current.splice(0, buffer.current.length);
    sendBatch(batch);
  };

  const scheduleIdleFlush = (): void => {
    if (typeof window === 'undefined') return;
    if (idleTimer.current !== null) {
      window.clearTimeout(idleTimer.current);
    }
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      flushNow();
    }, FLUSH_IDLE_MS);
  };

  const enqueue = (ev: EventPayload): void => {
    buffer.current.push(ev);
    if (buffer.current.length >= FLUSH_BATCH) {
      flushNow();
    } else {
      scheduleIdleFlush();
    }
  };

  const recordOpen: TelemetryAPI['recordOpen'] = (preset, frame, trigger) => {
    enqueue({
      session_id: sessionId.current,
      preset,
      frame_kind: frame.kind,
      target_id: targetIdForFrame(frame),
      action: 'open',
      trigger,
    });
  };

  const recordClose: TelemetryAPI['recordClose'] = (preset, frame, dwellMs) => {
    enqueue({
      session_id: sessionId.current,
      preset,
      frame_kind: frame.kind,
      target_id: targetIdForFrame(frame),
      action: 'close',
      dwell_ms: Math.max(0, Math.round(dwellMs)),
    });
  };

  const flushBeacon: TelemetryAPI['flushBeacon'] = () => {
    if (buffer.current.length === 0) return;
    const batch = buffer.current.splice(0, buffer.current.length);
    const ok = sendBeacon(batch);
    if (!ok) sendBatch(batch);
  };

  // Cleanup: idle timer + final flush on pagehide.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPageHide = () => flushBeacon();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      if (idleTimer.current !== null) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      // Best-effort flush on unmount.
      flushNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { recordOpen, recordClose, flushBeacon };
}
