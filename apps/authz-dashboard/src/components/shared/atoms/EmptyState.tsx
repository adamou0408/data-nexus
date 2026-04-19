import { ReactNode } from 'react';

export type EmptyStateProps = {
  /** Lucide icon element, e.g. <Table2 size={32} /> — size controlled by caller */
  icon: ReactNode;
  /** Primary message */
  message: ReactNode;
  /** Optional secondary hint text */
  hint?: ReactNode;
  /** Optional action slot (button, link) */
  action?: ReactNode;
  /** Padding variant: 'sm' (py-8) or 'lg' (py-16). Default: 'sm' */
  size?: 'sm' | 'lg';
};

/**
 * Empty state atom — centered icon + message pattern used across panels.
 * Replaces repeated inline "text-center py-N text-slate-400" blocks.
 */
export function EmptyState({
  icon, message, hint, action, size = 'sm',
}: EmptyStateProps) {
  const padding = size === 'lg' ? 'py-16' : 'py-8';
  return (
    <div className={`text-center ${padding} text-slate-400 text-sm`}>
      <div className="mx-auto mb-2 text-slate-300 flex justify-center">{icon}</div>
      <div>{message}</div>
      {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
