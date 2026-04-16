import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

export type ConfirmState = { title: string; message: string; impact: string; onConfirm: () => void } | null;

export function DangerConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  if (!state) return null;
  const keyword = 'CONFIRM';
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-red-200 bg-red-50 rounded-t-xl flex gap-3">
          <AlertTriangle size={24} className="text-red-600 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-bold text-red-900">{state.title}</h3>
            <p className="text-sm text-red-700 mt-1">{state.message}</p>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="text-xs font-semibold text-amber-800 mb-1">Impact</div>
            <div className="text-sm text-amber-900">{state.impact}</div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">
              Type <span className="font-mono font-bold text-red-600">{keyword}</span> to proceed
            </label>
            <input className="input mt-1 font-mono" value={typed} onChange={e => setTyped(e.target.value)}
              placeholder={keyword} autoFocus />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={() => { state.onConfirm(); onClose(); setTyped(''); }}
              disabled={typed !== keyword}
              className="btn btn-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed">
              Execute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
