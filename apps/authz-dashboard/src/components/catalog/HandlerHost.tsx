// Catalog HandlerFrame renderer.
// Loads the named handler component from handlerRegistry and feeds it the
// page config (fetched via api.configExecPage). Mirrors the L4 dispatch
// path that ConfigEngine takes for handler_name pages.

import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../../api';
import { HANDLER_REGISTRY, type HandlerProps } from './handlerRegistry';
import type { CatalogStackAPI, HandlerFrame } from './types';

type HandlerHostProps = {
  frame: HandlerFrame;
  // api is part of the public contract; kept here so handler-side push works
  // once handlers grow to accept it. Phase 1 handlers use existing event
  // dispatchers; Phase 2 may upgrade them to call api.push directly.
  api?: CatalogStackAPI;
};

export function HandlerHost({ frame }: HandlerHostProps) {
  const [config, setConfig] = useState<HandlerProps['config'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setError(null);
    api.configExecPage(frame.pageId, {})
      .then((resp) => {
        if (cancelled) return;
        setConfig(resp.config as HandlerProps['config']);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load handler config');
      });
    return () => { cancelled = true; };
  }, [frame.pageId]);

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" />
        {error}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-6 text-sm text-zinc-500 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  }

  const Handler = HANDLER_REGISTRY[frame.handlerName];
  if (!Handler) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" />
        Unknown handler: <code className="font-mono">{frame.handlerName}</code>
      </div>
    );
  }

  return <Handler config={config} />;
}
