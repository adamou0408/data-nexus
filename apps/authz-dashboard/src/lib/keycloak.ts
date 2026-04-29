// ============================================================
// Keycloak SSO integration (M4-KEYCLOAK-SSO-S3)
//
// Activation: VITE_KEYCLOAK_URL / VITE_KEYCLOAK_REALM / VITE_KEYCLOAK_CLIENT_ID
// must all be set (see apps/authz-dashboard/.env.local). When unset, the
// dashboard falls back to the legacy X-User-Id user-picker dev mode.
//
// Behaviour when SSO active:
//   - main.tsx awaits initKeycloak() before rendering React
//   - init mode = 'login-required' → unauth users are redirected to Keycloak
//   - api.ts attaches Authorization: Bearer <token> on every request
//   - tokens auto-refresh 30s before expiry; refresh failure forces re-login
// ============================================================

import Keycloak from 'keycloak-js';
import type { KeycloakInstance, KeycloakTokenParsed } from 'keycloak-js';

const URL_ = import.meta.env.VITE_KEYCLOAK_URL as string | undefined;
const REALM = import.meta.env.VITE_KEYCLOAK_REALM as string | undefined;
const CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID as string | undefined;

export const ssoEnabled: boolean = Boolean(URL_ && REALM && CLIENT_ID);

export const keycloak: KeycloakInstance | null = ssoEnabled
  ? new Keycloak({ url: URL_!, realm: REALM!, clientId: CLIENT_ID! })
  : null;

let _initPromise: Promise<boolean> | null = null;

export function initKeycloak(): Promise<boolean> {
  if (!keycloak) return Promise.resolve(false);
  if (_initPromise) return _initPromise;
  _initPromise = keycloak
    .init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    })
    .then((authenticated) => {
      if (authenticated) {
        keycloak.onTokenExpired = () => {
          keycloak.updateToken(60).catch(() => keycloak.login());
        };
      }
      return authenticated;
    })
    .catch(() => false);
  return _initPromise;
}

export async function ensureFreshToken(minValidity = 30): Promise<string | null> {
  if (!keycloak?.authenticated) return null;
  try {
    await keycloak.updateToken(minValidity);
    return keycloak.token ?? null;
  } catch {
    keycloak.login();
    return null;
  }
}

export function ssoLogout(): void {
  if (!keycloak) return;
  keycloak.logout({ redirectUri: window.location.origin });
}

export type SsoProfile = {
  id: string;
  label: string;
  groups: string[];
  attrs: Record<string, string>;
};

export function ssoUserProfile(): SsoProfile | null {
  if (!keycloak?.authenticated || !keycloak.tokenParsed) return null;
  const t = keycloak.tokenParsed as KeycloakTokenParsed & {
    preferred_username?: string;
    name?: string;
    email?: string;
    department?: string;
    groups?: string[];
    realm_access?: { roles?: string[] };
  };
  const username = t.preferred_username || t.sub || 'unknown';
  const realmRoles = t.realm_access?.roles ?? [];
  const tokenGroups = t.groups ?? [];
  const attrs: Record<string, string> = {};
  if (t.email) attrs.email = t.email;
  if (t.department) attrs.department = t.department;
  return {
    id: username,
    label: t.name || username,
    groups: [...realmRoles, ...tokenGroups],
    attrs,
  };
}
