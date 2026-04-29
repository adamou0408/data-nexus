// ============================================================
// useFeedback — Tier A primitive #3 client hook
//
// Minimal v1: just submit. Curator-side list-mine / inbox kept out
// (FU commit FEEDBACK-V01-INBOX-FU).
//
// Plan: .claude/plans/v3-phase-1/tier-a-feedback-plan.md
// ============================================================
import { useCallback, useState } from 'react';
import { api, FeedbackKind, FeedbackRow } from '../api';

export interface UseFeedbackResult {
  submit: (input: {
    page_id: string;
    target_path: string;
    kind: FeedbackKind;
    body: string;
  }) => Promise<FeedbackRow>;
  submitting: boolean;
  error: string | null;
  lastSubmitted: FeedbackRow | null;
  reset: () => void;
}

export function useFeedback(): UseFeedbackResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<FeedbackRow | null>(null);

  const submit = useCallback<UseFeedbackResult['submit']>(async (input) => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.feedbackCreate(input);
      setLastSubmitted(r.feedback);
      return r.feedback;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setLastSubmitted(null);
  }, []);

  return { submit, submitting, error, lastSubmitted, reset };
}
