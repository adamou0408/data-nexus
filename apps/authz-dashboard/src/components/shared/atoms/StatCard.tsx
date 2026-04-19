import { ReactNode } from 'react';

export type StatCardProps = {
  icon: ReactNode;
  value: string | number;
  label: string;
  /** Sub-label shown after main label in parentheses, e.g. "(3 root)" */
  sub?: string;
  /** Tailwind bg class for icon container, e.g. "bg-blue-50" */
  iconBg?: string;
  /** If provided, renders as a clickable button */
  onClick?: () => void;
};

/**
 * Stat card atom — uses global .stat-card / .stat-icon / .stat-value / .stat-label classes.
 * Renders as <button> if onClick provided, else as <div>.
 */
export function StatCard({
  icon, value, label, sub, iconBg = 'bg-slate-50', onClick,
}: StatCardProps) {
  const content = (
    <>
      <div className={`stat-icon ${iconBg}`}>{icon}</div>
      <div className="min-w-0">
        <div className="stat-value">{value}</div>
        <div className="stat-label truncate">{label}{sub ? ` (${sub})` : ''}</div>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="stat-card hover:border-slate-300 transition-colors text-left w-full"
      >
        {content}
      </button>
    );
  }

  return <div className="stat-card">{content}</div>;
}
