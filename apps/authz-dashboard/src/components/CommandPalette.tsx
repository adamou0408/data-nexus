import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ArrowRight, Settings2, User as UserIcon } from 'lucide-react';
import { navGroups, TabId } from './Layout';
import { useAuthz, UserProfile } from '../AuthzContext';

type Action =
  | { kind: 'tab'; id: TabId; label: string; group: string; shortcut?: string; icon: JSX.Element }
  | { kind: 'user'; user: UserProfile }
  | { kind: 'config'; label: string };

export function CommandPalette({
  open, onClose, onNavigate, onOpenConfigTools,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: TabId) => void;
  onOpenConfigTools: () => void;
}) {
  const { isAdmin, users, login } = useAuthz();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const allActions = useMemo<Action[]>(() => {
    const tabActions: Action[] = navGroups.flatMap(g =>
      g.items
        .filter(i => !i.adminOnly || isAdmin)
        .map(i => ({
          kind: 'tab' as const,
          id: i.id,
          label: i.label,
          group: g.label || 'General',
          shortcut: i.shortcut,
          icon: i.icon as JSX.Element,
        }))
    );
    const userActions: Action[] = users.slice(0, 50).map(u => ({ kind: 'user' as const, user: u }));
    const configActions: Action[] = isAdmin
      ? [{ kind: 'config' as const, label: 'Open Config Tools' }]
      : [];
    return [...tabActions, ...configActions, ...userActions];
  }, [users, isAdmin]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allActions.slice(0, 30);
    const score = (text: string): number => {
      const t = text.toLowerCase();
      if (t === q) return 100;
      if (t.startsWith(q)) return 50;
      if (t.includes(q)) return 25;
      // fuzzy: all chars present in order
      let i = 0;
      for (const c of t) { if (c === q[i]) i++; if (i === q.length) return 10; }
      return 0;
    };
    return allActions
      .map(a => {
        const text = a.kind === 'tab' ? `${a.label} ${a.group}`
          : a.kind === 'user' ? `${a.user.label} ${a.user.id}`
          : a.label;
        return { a, s: score(text) };
      })
      .filter(x => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 30)
      .map(x => x.a);
  }, [allActions, query]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return; }
      if (e.key === 'Enter')     { e.preventDefault(); runAction(filtered[cursor]); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cursor, filtered]);

  const runAction = async (a: Action | undefined) => {
    if (!a) return;
    if (a.kind === 'tab') { onNavigate(a.id); onClose(); return; }
    if (a.kind === 'config') { onOpenConfigTools(); onClose(); return; }
    if (a.kind === 'user') { await login(a.user); onClose(); return; }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
          <Search size={16} className="text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search tabs, users, actions..."
            className="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder-slate-400"
          />
          <kbd className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">ESC</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-slate-400">No matches.</div>
          )}
          {filtered.map((a, i) => {
            const active = i === cursor;
            const cls = `w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
              active ? 'bg-blue-50 text-blue-900' : 'text-slate-700 hover:bg-slate-50'
            }`;
            if (a.kind === 'tab') {
              return (
                <button key={`tab-${a.id}`} className={cls} onMouseEnter={() => setCursor(i)} onClick={() => runAction(a)}>
                  <span className="text-slate-400">{a.icon}</span>
                  <span className="flex-1 truncate">{a.label}</span>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider">{a.group}</span>
                  {a.shortcut && <kbd className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">{a.shortcut}</kbd>}
                </button>
              );
            }
            if (a.kind === 'user') {
              return (
                <button key={`user-${a.user.id}`} className={cls} onMouseEnter={() => setCursor(i)} onClick={() => runAction(a)}>
                  <UserIcon size={14} className="text-slate-400" />
                  <span className="flex-1 truncate">{a.user.label}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{a.user.id}</span>
                  <ArrowRight size={12} className="text-slate-300" />
                </button>
              );
            }
            return (
              <button key="config" className={cls} onMouseEnter={() => setCursor(i)} onClick={() => runAction(a)}>
                <Settings2 size={14} className="text-slate-400" />
                <span className="flex-1">{a.label}</span>
                <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">ADMIN</span>
              </button>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-slate-100 flex items-center gap-3 text-[10px] text-slate-500">
          <span><kbd className="bg-slate-100 px-1 rounded font-mono">↑↓</kbd> nav</span>
          <span><kbd className="bg-slate-100 px-1 rounded font-mono">↵</kbd> open</span>
          <span><kbd className="bg-slate-100 px-1 rounded font-mono">esc</kbd> close</span>
          <span className="ml-auto">tip: press <kbd className="bg-slate-100 px-1 rounded font-mono">g</kbd> then a letter to jump</span>
        </div>
      </div>
    </div>
  );
}
