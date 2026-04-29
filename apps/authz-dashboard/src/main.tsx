import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { ssoEnabled, initKeycloak } from './lib/keycloak';

async function bootstrap() {
  // When Keycloak env vars are set, await SSO init before rendering so that
  // unauthenticated users are redirected to the Keycloak login page first.
  // When unset, fall through to the legacy X-User-Id user-picker dev mode.
  if (ssoEnabled) {
    await initKeycloak();
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
