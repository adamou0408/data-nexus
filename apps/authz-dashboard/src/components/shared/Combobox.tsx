import { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, X } from 'lucide-react';

export type ComboboxOption = { value: string; label: string; hint?: string };

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  clearable,
  disabled,
  size = 'sm',
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filtered = useMemo(() => {
    if (!query) return options.slice(0, 80);
    const q = query.toLowerCase();
    return options.filter(o => o.value.toLowerCase().includes(q) || (o.hint || '').toLowerCase().includes(q) || o.label.toLowerCase().includes(q)).slice(0, 80);
  }, [options, query]);

  const selected = options.find(o => o.value === value);
  const inputCls = size === 'md' ? 'text-sm py-2' : 'text-xs py-1.5';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        className={`input w-full ${inputCls} text-left flex items-center justify-between ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <span className={`truncate ${selected ? 'font-mono text-slate-800' : 'text-slate-400'}`}>
          {selected ? selected.value : (placeholder || 'Select...')}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {clearable && selected && !disabled && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
              className="text-slate-400 hover:text-slate-700 cursor-pointer"
              title="Clear"
            >
              <X size={12} />
            </span>
          )}
          <ChevronDown size={12} className="text-slate-400" />
        </div>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 flex flex-col">
          <div className="p-1.5 border-b border-slate-100">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to filter..."
              className="input text-xs py-1 w-full"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">No matches</div>
            ) : (
              filtered.map(o => (
                <button
                  key={o.value}
                  onClick={() => { onChange(o.value); setOpen(false); setQuery(''); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 flex items-center gap-2 ${o.value === value ? 'bg-blue-50' : ''}`}
                >
                  <span className="font-mono text-slate-800 truncate">{o.label}</span>
                  {o.hint ? <span className="text-slate-400 text-[10px] truncate ml-auto">{o.hint}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
