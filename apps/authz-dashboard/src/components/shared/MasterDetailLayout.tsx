import { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

export type MasterDetailLayoutProps = {
  /** Whether an item is selected (controls mobile view toggling) */
  hasSelection: boolean;
  /** Master panel (left side — tree, list, etc.) */
  master: ReactNode;
  /** Detail panel (right side) */
  detail: ReactNode;
  /** Empty state when nothing is selected */
  emptyState: ReactNode;
  /** Callback to clear selection (mobile back button) */
  onBack: () => void;
  /** Back button label for mobile */
  backLabel?: string;
  /** Master panel width (default: 320px) */
  masterWidth?: number;
  /** Minimum height (default: 480px) */
  minHeight?: number;
};

export function MasterDetailLayout({
  hasSelection, master, detail, emptyState,
  onBack, backLabel = 'Back', masterWidth = 320, minHeight = 480,
}: MasterDetailLayoutProps) {
  return (
    <div className="flex flex-col lg:flex-row gap-4" style={{ minHeight }}>
      {/* Master panel — hidden on mobile when detail is open */}
      <div
        className={`shrink-0 ${hasSelection ? 'hidden lg:block' : ''}`}
        style={{ width: masterWidth }}
      >
        {master}
      </div>

      {/* Detail panel */}
      <div className={`flex-1 min-w-0 ${!hasSelection ? 'hidden lg:block' : ''}`}>
        {hasSelection ? (
          <>
            {/* Mobile back button */}
            <button
              onClick={onBack}
              className="lg:hidden flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 mb-2"
            >
              <ArrowLeft size={14} /> {backLabel}
            </button>
            {detail}
          </>
        ) : (
          emptyState
        )}
      </div>
    </div>
  );
}
