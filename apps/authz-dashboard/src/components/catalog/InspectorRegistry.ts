// catalog/InspectorRegistry.ts
//
// Mutable registry for inspector renderers. Owner: Agent A.
// Phase-1 ships empty; Phase 2 wires:
//   registerInspector('page',     PageInspector);     // from B
//   registerInspector('table',    TableInspector);    // from B
//   registerInspector('resource', ResourceInspector); // from C
//   registerInspector('module',   ModuleInspector);   // from C

import type {
  InspectorRegistry,
  InspectorRenderer,
  InspectorTarget,
} from './types';

const registry: InspectorRegistry = {};

export function registerInspector(
  kind: InspectorTarget['kind'],
  renderer: InspectorRenderer,
): void {
  registry[kind] = renderer;
}

export function getInspector(
  kind: InspectorTarget['kind'],
): InspectorRenderer | undefined {
  return registry[kind];
}

/** Test/debug helper — returns a snapshot of the current registry. */
export function inspectorRegistrySnapshot(): InspectorRegistry {
  return { ...registry };
}
