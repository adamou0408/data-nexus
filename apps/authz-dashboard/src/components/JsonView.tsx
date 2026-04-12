import { useState } from 'react';
import { Code2, ChevronDown, ChevronRight } from 'lucide-react';

export function JsonView({ data, defaultOpen = false }: { data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full card-header hover:bg-slate-50 transition-colors"
      >
        <span className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Code2 size={14} className="text-slate-500" />
          Raw JSON
        </span>
        {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
      </button>
      {open && (
        <pre className="bg-slate-900 text-emerald-400 p-5 text-xs overflow-auto max-h-96 leading-relaxed rounded-b-xl">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
