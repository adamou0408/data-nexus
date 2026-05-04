// catalog/useStack.ts
//
// Reducer-driven stack hook. Owns frames + viewStates + inspector.
// Owner: Agent A. See catalog-workspace-unified-design.md §4 item 2.
//
// LRU policy is enforced by CatalogWorkspace at render time, not here:
// useStack keeps the full frame array intact, but the renderer only
// mounts the top-3-deepest frames as siblings (display:none for non-top).
// This keeps state restoration cheap on goBack within the LRU window
// and lets deeper frames re-mount + re-fetch on demand.

import { useReducer, useCallback, useRef } from 'react';
import type {
  CatalogFrame,
  CatalogStackAPI,
  InspectorTarget,
  ViewState,
} from './types';
import { makeDefaultViewState } from './types';

type State = {
  frames: CatalogFrame[];
  viewStates: ViewState[];      // parallel to frames
  topIndex: number;             // == frames.length - 1 except during goTo
  inspector: InspectorTarget | null;
};

type Action =
  | { type: 'push'; frame: CatalogFrame }
  | { type: 'pop' }
  | { type: 'goTo'; index: number }
  | { type: 'replaceTop'; frame: CatalogFrame }
  | { type: 'reset'; frame: CatalogFrame }
  | { type: 'setViewState'; index: number; next: ViewState }
  | { type: 'setInspector'; target: InspectorTarget | null }
  // Used by urlSync popstate sync to install a fresh stack without
  // dispatching push/pop one by one.
  | { type: 'replaceAll'; frames: CatalogFrame[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'push': {
      const frames = [...state.frames, action.frame];
      const viewStates = [...state.viewStates, makeDefaultViewState(action.frame.kind)];
      return { ...state, frames, viewStates, topIndex: frames.length - 1 };
    }
    case 'pop': {
      if (state.frames.length <= 1) return state;
      const frames = state.frames.slice(0, -1);
      const viewStates = state.viewStates.slice(0, -1);
      return { ...state, frames, viewStates, topIndex: frames.length - 1 };
    }
    case 'goTo': {
      const i = Math.max(0, Math.min(action.index, state.frames.length - 1));
      // goTo collapses the stack down to index i (forward stack discarded —
      // history forward will repopulate via popstate).
      const frames = state.frames.slice(0, i + 1);
      const viewStates = state.viewStates.slice(0, i + 1);
      return { ...state, frames, viewStates, topIndex: i };
    }
    case 'replaceTop': {
      if (state.frames.length === 0) {
        return {
          frames: [action.frame],
          viewStates: [makeDefaultViewState(action.frame.kind)],
          topIndex: 0,
          inspector: state.inspector,
        };
      }
      const frames = [...state.frames];
      const viewStates = [...state.viewStates];
      frames[frames.length - 1] = action.frame;
      // Replace its viewState with a fresh default for the new kind.
      viewStates[viewStates.length - 1] = makeDefaultViewState(action.frame.kind);
      return { ...state, frames, viewStates, topIndex: frames.length - 1 };
    }
    case 'reset': {
      return {
        frames: [action.frame],
        viewStates: [makeDefaultViewState(action.frame.kind)],
        topIndex: 0,
        inspector: state.inspector,
      };
    }
    case 'setViewState': {
      if (action.index < 0 || action.index >= state.viewStates.length) return state;
      const viewStates = [...state.viewStates];
      viewStates[action.index] = action.next;
      return { ...state, viewStates };
    }
    case 'setInspector':
      return { ...state, inspector: action.target };
    case 'replaceAll': {
      if (action.frames.length === 0) return state;
      const viewStates = action.frames.map(f => makeDefaultViewState(f.kind));
      return {
        ...state,
        frames: [...action.frames],
        viewStates,
        topIndex: action.frames.length - 1,
      };
    }
  }
}

export type UseStackResult = CatalogStackAPI & {
  /** Internal: parallel array of view states (for LRU/render). */
  viewStates: readonly ViewState[];
  /** Internal: bulk replace, used by popstate sync. */
  replaceAll: (frames: CatalogFrame[]) => void;
  /** Internal: install a query-param mutator (urlSync supplies it). */
  setQueryParamMutator: (fn: (key: string, val: string | null) => void) => void;
};

export function useStack(initialFrame: CatalogFrame): UseStackResult {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    frames: [initialFrame],
    viewStates: [makeDefaultViewState(initialFrame.kind)],
    topIndex: 0,
    inspector: null,
  }));

  // Query-param mutator is injected by CatalogWorkspace from installHistorySync.
  // Until installed it's a no-op (we never want frames to touch window.history).
  const queryMutatorRef = useRef<(key: string, val: string | null) => void>(() => {});
  const setQueryParamMutator = useCallback(
    (fn: (key: string, val: string | null) => void) => {
      queryMutatorRef.current = fn;
    },
    [],
  );

  const push = useCallback((frame: CatalogFrame) => dispatch({ type: 'push', frame }), []);
  const pop = useCallback(() => dispatch({ type: 'pop' }), []);
  const goTo = useCallback((index: number) => dispatch({ type: 'goTo', index }), []);
  const replace = useCallback(
    (frame: CatalogFrame) => dispatch({ type: 'replaceTop', frame }),
    [],
  );
  const reset = useCallback(
    (frame: CatalogFrame) => dispatch({ type: 'reset', frame }),
    [],
  );
  const replaceAll = useCallback(
    (frames: CatalogFrame[]) => dispatch({ type: 'replaceAll', frames }),
    [],
  );
  const setInspector = useCallback(
    (target: InspectorTarget | null) => dispatch({ type: 'setInspector', target }),
    [],
  );

  const setViewState = useCallback(
    (next: ViewState | ((prev: ViewState) => ViewState)) => {
      // Resolve functional update against the latest top viewState.
      // We read from a ref-like closure: dispatch with a thunk-style action
      // is unavailable in useReducer, so we resolve here using current state.
      const top = state.viewStates[state.topIndex];
      const resolved = typeof next === 'function'
        ? (next as (p: ViewState) => ViewState)(top)
        : next;
      dispatch({ type: 'setViewState', index: state.topIndex, next: resolved });
    },
    [state.topIndex, state.viewStates],
  );

  const replaceQueryParam = useCallback(
    (key: string, val: string | null) => queryMutatorRef.current(key, val),
    [],
  );

  return {
    frames: state.frames,
    topIndex: state.topIndex,
    push,
    pop,
    goTo,
    replace,
    reset,
    viewState: state.viewStates[state.topIndex],
    setViewState,
    inspector: state.inspector,
    setInspector,
    replaceQueryParam,
    // Internal extras
    viewStates: state.viewStates,
    replaceAll,
    setQueryParamMutator,
  };
}
