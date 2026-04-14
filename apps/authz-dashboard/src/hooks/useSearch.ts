import { useState, useMemo } from 'react';

export function useSearch(data: Record<string, unknown>[], keys: string[]) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    if (!query.trim()) return data;
    const q = query.toLowerCase();
    return data.filter(row => keys.some(k => String(row[k] ?? '').toLowerCase().includes(q)));
  }, [data, query, keys]);
  return { query, setQuery, filtered };
}
