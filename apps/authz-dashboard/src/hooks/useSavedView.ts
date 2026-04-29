// ============================================================
// useSavedView — Tier A primitive #2 client hook
//
// Owns ConfigEngine's filters/sort/hidden_cols state when a saved
// view is active; falls back to internal useState patterns when
// nothing is loaded.
//
// Plan: .claude/plans/v3-phase-1/tier-a-saved-view-plan.md
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { api, SavedView, SavedViewConfig } from '../api';

export interface UseSavedViewResult {
  views: SavedView[];
  activeView: SavedView | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  applyView: (view_id: string) => void;
  saveAsView: (name: string, config: SavedViewConfig, makeDefault?: boolean) => Promise<SavedView>;
  updateActiveView: (config: SavedViewConfig) => Promise<void>;
  renameView: (view_id: string, name: string) => Promise<void>;
  setDefault: (view_id: string) => Promise<void>;
  deleteView: (view_id: string) => Promise<void>;
  clearActive: () => void;
}

interface Options {
  pageId: string;
  // Read-only signal for the URL ?view=<id> hint (parent owns the URL).
  initialViewId?: string;
}

export function useSavedView({ pageId, initialViewId }: Options): UseSavedViewResult {
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const reload = useCallback(async () => {
    if (!pageId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.savedViewList(pageId);
      setViews(r.views);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => { reload(); }, [reload]);

  // Bootstrap: ?view=<id> wins over is_default.
  useEffect(() => {
    if (bootstrapped || views.length === 0) return;
    if (initialViewId) {
      const hit = views.find(v => v.view_id === initialViewId);
      if (hit) {
        setActiveView(hit);
        setBootstrapped(true);
        return;
      }
      // Cross-user / wrong page → server returns 404 in list (it filters
      // by user). Fall through to default.
    }
    const def = views.find(v => v.is_default);
    if (def) setActiveView(def);
    setBootstrapped(true);
  }, [views, initialViewId, bootstrapped]);

  const applyView = useCallback((view_id: string) => {
    const hit = views.find(v => v.view_id === view_id) || null;
    setActiveView(hit);
  }, [views]);

  const saveAsView = useCallback(async (name: string, config: SavedViewConfig, makeDefault?: boolean) => {
    const r = await api.savedViewCreate({ page_id: pageId, name, config_json: config, is_default: makeDefault });
    await reload();
    setActiveView(r.view);
    return r.view;
  }, [pageId, reload]);

  const updateActiveView = useCallback(async (config: SavedViewConfig) => {
    if (!activeView) return;
    const r = await api.savedViewUpdate(activeView.view_id, { config_json: config });
    setActiveView(r.view);
    await reload();
  }, [activeView, reload]);

  const renameView = useCallback(async (view_id: string, name: string) => {
    const r = await api.savedViewUpdate(view_id, { name });
    if (activeView?.view_id === view_id) setActiveView(r.view);
    await reload();
  }, [activeView, reload]);

  const setDefault = useCallback(async (view_id: string) => {
    const r = await api.savedViewSetDefault(view_id);
    if (activeView?.view_id === view_id) setActiveView(r.view);
    await reload();
  }, [activeView, reload]);

  const deleteView = useCallback(async (view_id: string) => {
    await api.savedViewDelete(view_id);
    if (activeView?.view_id === view_id) setActiveView(null);
    await reload();
  }, [activeView, reload]);

  const clearActive = useCallback(() => setActiveView(null), []);

  return {
    views, activeView, loading, error,
    reload, applyView, saveAsView, updateActiveView,
    renameView, setDefault, deleteView, clearActive,
  };
}
