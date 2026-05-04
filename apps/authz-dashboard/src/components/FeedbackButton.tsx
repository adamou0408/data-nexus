// ============================================================
// FeedbackButton — Tier A primitive #3 floating UI
//
// Bottom-right floating button + modal dialog. v1 page-level only
// (target_path = 'page'). Column / filter triggers deferred to v2.
//
// Plan: .claude/plans/v3-phase-1/tier-a-feedback-plan.md
// ============================================================
import { useEffect, useState } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { useFeedback } from '../hooks/useFeedback';
import type { FeedbackKind } from '../api';

interface FeedbackButtonProps {
  pageId: string;
  // Future v2: target_path defaults to 'page'; column-level / filter-level
  // triggers can pass their own (e.g., 'column:lot_id') and reuse the dialog.
  targetPath?: string;
}

const KIND_OPTIONS: { value: FeedbackKind; label: string; hint: string }[] = [
  { value: 'data_wrong',      label: '資料錯誤 / Data wrong',           hint: '某格 / 某欄資料顯示錯了' },
  { value: 'feature_request', label: '功能需求 / Feature request',      hint: '想要新增功能或加強現有 filter / sort' },
  { value: 'confusing',       label: '說明不清 / Confusing',            hint: '欄位名 / help_text 看不懂' },
  { value: 'other',           label: '其他 / Other',                    hint: '不確定屬哪類' },
];

export function FeedbackButton({ pageId, targetPath = 'page' }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>('data_wrong');
  const [body, setBody] = useState('');
  const [justSent, setJustSent] = useState(false);
  const { submit, submitting, error, reset } = useFeedback();

  useEffect(() => {
    if (!open) {
      // Reset form state when dialog closes
      setBody('');
      setKind('data_wrong');
      reset();
    }
  }, [open, reset]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      await submit({ page_id: pageId, target_path: targetPath, kind, body: trimmed });
      setJustSent(true);
      setTimeout(() => {
        setJustSent(false);
        setOpen(false);
      }, 1200);
    } catch {
      // error surfaced via hook
    }
  };

  const remaining = 4000 - body.length;
  const overLimit = remaining < 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        aria-label="Send feedback"
        title="Send feedback about this page"
      >
        <MessageSquarePlus size={18} />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-dialog-title"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 id="feedback-dialog-title" className="text-base font-semibold text-gray-900">
                Send feedback
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-gray-500 hover:bg-gray-100"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={onSubmit} className="space-y-4 px-5 py-4">
              <div>
                <label className="block text-xs font-medium text-gray-600">Page</label>
                <div className="mt-1 truncate rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700">
                  {pageId}
                  {targetPath !== 'page' && <span className="ml-2 text-gray-400">· {targetPath}</span>}
                </div>
              </div>

              <div>
                <label htmlFor="feedback-kind" className="block text-xs font-medium text-gray-600">
                  Type
                </label>
                <select
                  id="feedback-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as FeedbackKind)}
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={submitting}
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {KIND_OPTIONS.find((o) => o.value === kind)?.hint}
                </p>
              </div>

              <div>
                <label htmlFor="feedback-body" className="block text-xs font-medium text-gray-600">
                  Detail
                </label>
                <textarea
                  id="feedback-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={4500}
                  placeholder="描述你看到了什麼、預期看到什麼、或想要怎樣的改善"
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={submitting}
                  required
                />
                <div className={`mt-1 text-right text-xs ${overLimit ? 'text-red-600' : 'text-gray-400'}`}>
                  {body.length} / 4000
                </div>
              </div>

              {error && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}
              {justSent && (
                <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">
                  Thanks — feedback sent.
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitting || !body.trim() || overLimit}
                >
                  {submitting ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
