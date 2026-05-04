// Copy of ConfigEngine.tsx HANDLER_REGISTRY (lines 161-167).
// Phase 2 deletes the original constant from ConfigEngine.

import type { ComponentType } from 'react';
import { ModulesTab } from '../modules/ModulesTab';
import { AuditTab } from '../AuditTab';
import { NpiGateConsoleTab } from '../NpiGateConsoleTab';

// Mirror of ConfigEngine.HandlerProps so this module is self-contained.
// PageConfig is intentionally widened to a structural shape — handlers in
// the registry only consume the fields they need.
export type HandlerProps = {
  config: {
    page_id: string;
    title: string;
    subtitle?: string;
    layout: string;
    handler_name?: string;
    [k: string]: unknown;
  };
};

export const HANDLER_REGISTRY: Record<string, ComponentType<HandlerProps>> = {
  'modules_home_handler': ModulesTab as unknown as ComponentType<HandlerProps>,
  'audit_home_handler': AuditTab as unknown as ComponentType<HandlerProps>,
  'npi_gate_console_handler': NpiGateConsoleTab as unknown as ComponentType<HandlerProps>,
};
