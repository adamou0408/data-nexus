// catalog/UsageBadge.tsx
//
// Tiny one-pill rendering for the per-target usage stats fetched by
// useUsageStats. Priority: orange (high bounce) > green (top quartile open
// count) > grey (default).
//
// We intentionally keep this dumb — caller supplies stats, we only paint.
// useUsageStats decides the threshold (top-quartile open_count).

import type { CatalogPreset } from './types';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

export type UsageStat = {
  open_count: number;
  bounce_rate: number;
  avg_dwell_ms: number | null;
  is_top_quartile: boolean;
};

export type UsageStatsMap = Map<string, UsageStat>;

const HIGH_BOUNCE_THRESHOLD = 0.3;

export function UsageBadge({ stat }: { stat: UsageStat | undefined }) {
  if (!stat) return null;
  if (stat.open_count === 0) return null;

  if (stat.bounce_rate > HIGH_BOUNCE_THRESHOLD && stat.open_count >= 3) {
    return (
      <span
        className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200"
        title={`${stat.open_count} opens · ${Math.round(stat.bounce_rate * 100)}% bounce`}
        data-testid="usage-badge-bounce"
      >
        ⚠ {Math.round(stat.bounce_rate * 100)}%
      </span>
    );
  }

  if (stat.is_top_quartile) {
    return (
      <span
        className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
        title={`${stat.open_count} opens (top 25%)`}
        data-testid="usage-badge-hot"
      >
        ↑ {stat.open_count}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
      title={`${stat.open_count} opens`}
      data-testid="usage-badge-default"
    >
      {stat.open_count}
    </span>
  );
}

/** Fetch usage stats for a preset, return a Map keyed by target_id (group_key
 *  from the API). Silently returns an empty map if the user lacks
 *  AUTHZ_ADMIN/DATA_STEWARD — badges should never break the workspace for
 *  regular users.
 */
export function useUsageStats(preset: CatalogPreset, window: string = '7d'): UsageStatsMap {
  const [rows, setRows] = useState<Array<{ group_key: string | null; open_count: number; bounce_rate: number; avg_dwell_ms: number | null }>>([]);

  useEffect(() => {
    let cancelled = false;
    api.catalogUsageStats(preset, window)
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [preset, window]);

  return useMemo(() => {
    const m: UsageStatsMap = new Map();
    if (rows.length === 0) return m;
    // Compute top-quartile threshold over open_count.
    const counts = rows.map((r) => r.open_count).filter((n) => n > 0).sort((a, b) => a - b);
    const idx = Math.floor(counts.length * 0.75);
    const threshold = counts.length > 3 ? counts[idx] ?? 0 : Infinity;
    for (const r of rows) {
      if (!r.group_key) continue;
      m.set(String(r.group_key), {
        open_count: r.open_count,
        bounce_rate: r.bounce_rate,
        avg_dwell_ms: r.avg_dwell_ms,
        is_top_quartile: r.open_count >= threshold && r.open_count > 0,
      });
    }
    return m;
  }, [rows]);
}
