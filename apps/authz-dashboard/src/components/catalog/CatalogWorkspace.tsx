// catalog/CatalogWorkspace.tsx
//
// Catalog Workspace shell. Mounts the stack hook, installs URL sync,
// and renders the top-3 LRU-mounted frames + breadcrumb + inspector.
//
// Owner: Agent A. See catalog-workspace-unified-design.md §4 item 5.

import { useEffect, useRef } from 'react';
import type { CatalogFrame, CatalogPreset, CatalogStackAPI } from './types';
import { getPreset } from './presets';
import { useStack } from './useStack';
import {
  installHistorySync,
  readInitialStack,
  serializeFrame,
  serializeHash,
} from './urlSync';
import { Breadcrumbs } from './Breadcrumbs';
import { Inspector } from './Inspector';
import { CardGridView } from './CardGridView';
import { GridView } from './GridView';
import { TreeView } from './TreeView';
import { DetailView } from './DetailView';
import { SchemaView } from './SchemaView';
import { HandlerHost } from './HandlerHost';
import { useTelemetry, type TelemetryTrigger } from './useTelemetry';
// Inspector registrations — side-effect import. Each registerInspector call
// overwrites; safe to import multiple times.
import { registerInspector } from './InspectorRegistry';
import { PageInspector } from './inspectors/PageInspector';
import { TableInspector } from './inspectors/TableInspector';
import { ResourceInspector } from './inspectors/ResourceInspector';
import { ModuleInspector } from './inspectors/ModuleInspector';

registerInspector('page', PageInspector);
registerInspector('table', TableInspector);
registerInspector('resource', ResourceInspector);
registerInspector('module', ModuleInspector);

type Props = {
  preset: CatalogPreset;
  /** Optional override of the initial root frame (rare — used for deep links). */
  initialFrameOverride?: CatalogFrame;
  /**
   * Cross-tab open: when a page id is pushed (e.g. from DiscoverTab Generate App
   * or DagTab publish), open it as a `page-detail` frame on top of the current
   * stack. Only honored when preset === 'pages'. Caller clears via onPendingConsumed.
   */
  pendingPageId?: string | null;
  onPendingConsumed?: () => void;
};

/**
 * LRU-bound: number of frames kept mounted (top-most n).
 * Fixed at 3 per design decision §1 "Design decisions locked" item 5.
 * Deeper frames are unmounted; their viewState snapshot is retained so
 * a goBack restores scroll/expansion/form values, but the frame body
 * re-mounts and may re-fetch.
 */
const LRU_BOUND = 3;

function FrameRenderer({
  frame,
  api,
}: {
  frame: CatalogFrame;
  api: CatalogStackAPI;
}) {
  switch (frame.kind) {
    case 'card-grid':     return <CardGridView api={api} />;
    case 'module-tree':   return <TreeView    frame={frame} api={api} />;
    case 'module-detail': return <DetailView  frame={frame} api={api} />;
    case 'page-grid':     return <GridView    frame={frame} api={api} />;
    case 'page-detail':   return <DetailView  frame={frame} api={api} />;
    case 'table-grid':    return <GridView    frame={frame} api={api} />;
    case 'table-schema':  return <SchemaView  frame={frame} api={api} />;
    case 'resource-grid': return <GridView    frame={frame} api={api} />;
    case 'handler':       return <HandlerHost frame={frame} api={api} />;
    default: {
      // Exhaustiveness check — TS errors here if a new kind is added
      // without updating the switch.
      const _never: never = frame;
      void _never;
      return null;
    }
  }
}

export function CatalogWorkspace({ preset, initialFrameOverride, pendingPageId, onPendingConsumed }: Props) {
  // Compute initial stack: deep-link parse > preset root > override.
  const initialStack = (() => {
    if (initialFrameOverride) return [initialFrameOverride];
    return readInitialStack(preset).frames;
  })();

  const stack = useStack(initialStack[0]);

  // ── Telemetry ───────────────────────────────────────────────────────────
  const telemetry = useTelemetry();
  // Marks the trigger for the NEXT stack mutation. Set by history/cross-tab
  // effects before they dispatch; consumed (and reset to 'click') by the
  // diff effect below. Avoids infering trigger from React effect ordering.
  const nextTriggerRef = useRef<TelemetryTrigger>('initial');
  // Maps absolute stack index -> performance.now() at open time, so close
  // events can record dwell_ms. Index-based because frames may be re-ordered
  // by replaceAll (popstate); we re-key on diff.
  const openedAtRef = useRef<Map<number, number>>(new Map());
  const prevFramesRef = useRef<readonly CatalogFrame[]>([]);

  // Hydrate any extra deep-link frames after first mount (preserves URL on refresh).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (initialStack.length > 1) {
      stack.replaceAll(initialStack);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Install history sync — pushState on each new top frame, popstate -> goTo (preferred) or replaceAll.
  const historyRef = useRef<ReturnType<typeof installHistorySync> | null>(null);
  useEffect(() => {
    const handle = installHistorySync((parsed) => {
      // Any stack mutation triggered by hash navigation should be tagged.
      nextTriggerRef.current = 'history';
      if (!parsed) {
        // Hash cleared — reset to preset root.
        stack.reset(getPreset(preset).rootFrame);
        return;
      }
      if (parsed.preset !== preset) {
        // Different workspace; let the host (App) switch tabs. Keep our
        // current state to avoid races.
        return;
      }
      // Diff: if frames identical, skip.
      const currentHash = serializeHash(preset, stack.frames);
      const targetHash  = serializeHash(parsed.preset, parsed.frames);
      if (currentHash === targetHash) return;

      // Prefix-detect: if the target frames are a strict prefix of our
      // current stack, use goTo to preserve viewStates (scroll, formValues,
      // expandedIds) within the LRU window. Only fall back to replaceAll
      // for non-prefix navigation (deep-link paste, forward to new stack).
      const target = parsed.frames;
      const cur = stack.frames;
      const isPrefix =
        target.length > 0 &&
        target.length <= cur.length &&
        target.every((f, i) => serializeFrame(f) === serializeFrame(cur[i]));

      if (isPrefix && target.length < cur.length) {
        stack.goTo(target.length - 1);
      } else {
        stack.replaceAll(target);
      }
    });
    historyRef.current = handle;
    stack.setQueryParamMutator(handle.replaceQueryParam);
    // Ensure URL reflects current stack on mount.
    handle.syncToHash(preset, stack.frames, 'replace');
    return () => {
      handle.dispose();
      historyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  // Sync URL on stack changes.
  useEffect(() => {
    historyRef.current?.syncToHash(preset, stack.frames, 'push');
  }, [preset, stack.frames]);

  // Cross-tab open: consume `pendingPageId` by pushing a page-detail frame.
  // Only the 'pages' preset honors it; other workspaces ignore.
  useEffect(() => {
    if (!pendingPageId) return;
    if (preset !== 'pages') return;
    nextTriggerRef.current = 'cross-tab';
    stack.push({ kind: 'page-detail', pageId: pendingPageId, params: {} });
    onPendingConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPageId, preset]);

  // Diff effect: emit telemetry whenever the frame stack changes.
  // First mount → 'initial' open for the bottom frame. Pushes get the
  // currently-pending trigger (default 'click'); pops get a synthesized
  // close with dwell_ms.
  useEffect(() => {
    const prev = prevFramesRef.current;
    const curr = stack.frames;
    const trigger: TelemetryTrigger = nextTriggerRef.current;
    nextTriggerRef.current = 'click';

    const now = performance.now();

    // Find common prefix length (where serialized frames match).
    let common = 0;
    const minLen = Math.min(prev.length, curr.length);
    while (common < minLen && serializeFrame(prev[common]) === serializeFrame(curr[common])) {
      common++;
    }

    // Closes: anything popped above the common prefix in `prev`.
    for (let i = prev.length - 1; i >= common; i--) {
      const openedAt = openedAtRef.current.get(i);
      if (openedAt !== undefined) {
        telemetry.recordClose(preset, prev[i], now - openedAt);
        openedAtRef.current.delete(i);
      }
    }

    // Opens: anything new at index >= common in `curr`. The bottom-most
    // frame on first mount uses the 'initial' trigger; subsequent opens
    // share whichever trigger was pre-marked (or 'click' default).
    for (let i = common; i < curr.length; i++) {
      telemetry.recordOpen(preset, curr[i], trigger);
      openedAtRef.current.set(i, now);
    }

    prevFramesRef.current = curr;
    // Also reset openedAt entries above curr.length to keep the map clean.
    for (const idx of Array.from(openedAtRef.current.keys())) {
      if (idx >= curr.length) openedAtRef.current.delete(idx);
    }
  }, [stack.frames, preset, telemetry]);

  // On preset change (different workspace), tag the next mutation.
  useEffect(() => {
    nextTriggerRef.current = 'initial';
  }, [preset]);

  // LRU window: render the top-3 frames as siblings; deeper ones return null.
  // Top frame visible, the (up to 2) below it mounted but display:none.
  const lruStart = Math.max(0, stack.frames.length - LRU_BOUND);
  const lruFrames = stack.frames.slice(lruStart);

  return (
    <div
      className="flex"
      style={{ height: 'calc(100vh - 200px)', minHeight: 560 }}
      data-testid="catalog-workspace"
      data-preset={preset}
    >
      <div className="flex-1 flex flex-col min-w-0">
        <Breadcrumbs
          preset={preset}
          frames={stack.frames}
          onGoTo={(i) => stack.goTo(i)}
        />
        <div className="flex-1 relative overflow-hidden">
          {lruFrames.map((frame, idx) => {
            const absoluteIndex = lruStart + idx;
            const isTop = absoluteIndex === stack.topIndex;
            // key by position+kind so React reuses mounts when the slot's frame
            // is logically the same across re-renders.
            const key = `${absoluteIndex}:${frame.kind}`;
            return (
              <div
                key={key}
                className="absolute inset-0 overflow-auto"
                style={{ display: isTop ? 'block' : 'none' }}
                data-frame-index={absoluteIndex}
                data-frame-kind={frame.kind}
                data-lru="mounted"
              >
                <FrameRenderer frame={frame} api={stack} />
              </div>
            );
          })}
        </div>
      </div>
      <Inspector
        target={stack.inspector}
        onClose={() => stack.setInspector(null)}
        onOpen={(f) => {
          stack.setInspector(null);
          stack.push(f);
        }}
      />
    </div>
  );
}
