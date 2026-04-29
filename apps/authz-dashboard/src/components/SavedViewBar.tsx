// ============================================================
// SavedViewBar — Tier A primitive #2 toolbar
//
// Renders above DataTable. Lets the user:
//   • pick a saved view (dropdown)
//   • save the current state as a new view
//   • promote / rename / delete
//
// Plan: .claude/plans/v3-phase-1/tier-a-saved-view-plan.md §3.6
// ============================================================
import { useState } from 'react';
import { Bookmark, Star, Trash2, Pencil, Save, Plus, X } from 'lucide-react';
import { SavedView, SavedViewConfig } from '../api';

interface Props {
  views: SavedView[];
  active: SavedView | null;
  loading: boolean;
  // Current ConfigEngine state — used by "save as" / "update active"
  currentConfig: SavedViewConfig;
  onApply: (view_id: string) => void;
  onClear: () => void;
  onSaveAs: (name: string, config: SavedViewConfig, makeDefault: boolean) => Promise<void>;
  onUpdateActive: (config: SavedViewConfig) => Promise<void>;
  onRename: (view_id: string, name: string) => Promise<void>;
  onSetDefault: (view_id: string) => Promise<void>;
  onDelete: (view_id: string) => Promise<void>;
}

export function SavedViewBar({
  views, active, loading, currentConfig,
  onApply, onClear, onSaveAs, onUpdateActive, onRename, onSetDefault, onDelete,
}: Props) {
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const submitSave = async () => {
    if (!saveName.trim()) return;
    setBusy(true);
    try {
      await onSaveAs(saveName.trim(), currentConfig, makeDefault);
      setShowSave(false);
      setSaveName('');
      setMakeDefault(false);
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const submitRename = async (id: string) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    setBusy(true);
    try {
      await onRename(id, renameValue.trim());
      setRenamingId(null);
    } catch (e) {
      alert(`Rename failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const onDeleteClick = async (v: SavedView) => {
    if (!confirm(`Delete saved view "${v.name}"?`)) return;
    setBusy(true);
    try { await onDelete(v.view_id); }
    catch (e) { alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  const onUpdateClick = async () => {
    if (!active) return;
    if (!confirm(`Overwrite "${active.name}" with current filters/sort?`)) return;
    setBusy(true);
    try { await onUpdateActive(currentConfig); }
    catch (e) { alert(`Update failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 p-2 border border-slate-200 rounded-lg bg-slate-50/60">
      <Bookmark className="w-4 h-4 text-slate-500" />
      <span className="text-xs font-medium text-slate-600">Saved views:</span>

      {loading && <span className="text-xs text-slate-400">loading…</span>}

      <select
        value={active?.view_id || ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onClear();
          else onApply(v);
        }}
        className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white max-w-[240px]"
        disabled={busy}
      >
        <option value="">— none —</option>
        {views.map(v => (
          <option key={v.view_id} value={v.view_id}>
            {v.is_default ? '★ ' : ''}{v.name}
          </option>
        ))}
      </select>

      {active && (
        <>
          <button
            onClick={onUpdateClick}
            disabled={busy}
            title="Overwrite current view with current filters/sort"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-slate-200 rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
          >
            <Save className="w-3 h-3" /> Update
          </button>
          <button
            onClick={() => onSetDefault(active.view_id)}
            disabled={busy || active.is_default}
            title={active.is_default ? 'Already default' : 'Set as default for this page'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-slate-200 rounded-md bg-white hover:bg-amber-50 disabled:opacity-50"
          >
            <Star className={`w-3 h-3 ${active.is_default ? 'text-amber-500 fill-amber-500' : 'text-slate-400'}`} />
            {active.is_default ? 'Default' : 'Set default'}
          </button>
          {renamingId === active.view_id ? (
            <span className="inline-flex items-center gap-1">
              <input
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') submitRename(active.view_id); if (e.key === 'Escape') setRenamingId(null); }}
              />
              <button onClick={() => submitRename(active.view_id)} disabled={busy}
                className="inline-flex items-center text-xs px-1.5 py-1 border border-slate-200 rounded-md bg-white hover:bg-slate-100">
                <Save className="w-3 h-3" />
              </button>
              <button onClick={() => setRenamingId(null)} disabled={busy}
                className="inline-flex items-center text-xs px-1.5 py-1 border border-slate-200 rounded-md bg-white hover:bg-slate-100">
                <X className="w-3 h-3" />
              </button>
            </span>
          ) : (
            <button
              onClick={() => { setRenamingId(active.view_id); setRenameValue(active.name); }}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-slate-200 rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
            >
              <Pencil className="w-3 h-3" /> Rename
            </button>
          )}
          <button
            onClick={() => onDeleteClick(active)}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-rose-200 rounded-md bg-white text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </>
      )}

      <div className="grow" />

      {!showSave ? (
        <button
          onClick={() => setShowSave(true)}
          disabled={busy}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-blue-200 rounded-md bg-white text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Save as new view
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <input
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            placeholder="View name"
            autoFocus
            className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
            onKeyDown={e => { if (e.key === 'Enter') submitSave(); if (e.key === 'Escape') setShowSave(false); }}
          />
          <label className="text-xs inline-flex items-center gap-1">
            <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />
            Default
          </label>
          <button onClick={submitSave} disabled={busy || !saveName.trim()}
            className="inline-flex items-center text-xs px-2 py-1 border border-blue-200 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            <Save className="w-3 h-3 mr-1" /> Save
          </button>
          <button onClick={() => { setShowSave(false); setSaveName(''); setMakeDefault(false); }} disabled={busy}
            className="inline-flex items-center text-xs px-2 py-1 border border-slate-200 rounded-md bg-white hover:bg-slate-100">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
    </div>
  );
}
