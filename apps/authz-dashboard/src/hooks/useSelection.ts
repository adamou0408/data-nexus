import { useState, useCallback, useMemo, useEffect } from 'react';

export function useSelection<T extends Record<string, unknown>>(data: T[], idKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Clear selection when data changes
  useEffect(() => {
    setSelected(new Set());
  }, [data]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (prev.size === data.length) return new Set();
      return new Set(data.map(row => String(row[idKey])));
    });
  }, [data, idKey]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const isAllSelected = data.length > 0 && selected.size === data.length;

  const selectedItems = useMemo(
    () => data.filter(row => selected.has(String(row[idKey]))),
    [data, selected, idKey],
  );

  return { selected, toggle, toggleAll, isAllSelected, clearSelection, selectedItems, count: selected.size };
}
