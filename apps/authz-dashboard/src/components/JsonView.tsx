import { useState } from 'react';

export function JsonView({ data, defaultOpen = false }: { data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-blue-600 hover:text-blue-800 mb-1"
      >
        {open ? 'Hide' : 'Show'} Raw JSON
      </button>
      {open && (
        <pre className="bg-gray-900 text-green-300 p-4 rounded-lg text-xs overflow-auto max-h-96">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
