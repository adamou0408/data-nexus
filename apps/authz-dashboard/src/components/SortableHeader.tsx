import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import type { SortDir } from '../hooks/useSort';

export function SortableHeader({
  label,
  sortKey,
  currentSortKey,
  sortDir,
  onToggle,
  className = '',
}: {
  label: string;
  sortKey: string;
  currentSortKey: string;
  sortDir: SortDir;
  onToggle: (key: string) => void;
  className?: string;
}) {
  const isActive = sortKey === currentSortKey;
  return (
    <th
      className={`cursor-pointer select-none hover:bg-slate-100 transition-colors ${className}`}
      onClick={() => onToggle(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />
        ) : (
          <ChevronsUpDown size={14} className="text-slate-300" />
        )}
      </span>
    </th>
  );
}
