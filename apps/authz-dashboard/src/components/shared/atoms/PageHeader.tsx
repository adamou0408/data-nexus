import { ReactNode } from 'react';

export type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional right-side slot (actions, status badge) */
  action?: ReactNode;
};

/**
 * Page header atom — uses global .page-title / .page-desc classes.
 * Consistent h1 + subtitle pattern for top-level pages.
 */
export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-1">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-desc">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
