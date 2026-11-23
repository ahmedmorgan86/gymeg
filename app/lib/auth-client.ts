'use client';

import { authFlowOrigin } from './auth-flow-origin';

async function sameOriginSignIn(email: string, password: string) {
  try {
    const r = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await r.json();
    return {
      data: { session: null },
      error: r.ok ? null : { code: typeof result.error === 'string' ? result.error : 'auth_failed' },
    };
  } catch {
    return { data: { session: null }, error: { code: 'connection' } };
  }
}

export function getBrowserSupabase() {
  return null;
}

export const authClient = {
  signIn: {
    email: ({ email, password }: { email: string; password: string }) => sameOriginSignIn(email, password),
    // Full-page redirect through the server-side Google OAuth flow; during a
    // domain migration the flow must start on the approved auth origin.
    google: (returnTo: '/clubs' | '/platform' = '/clubs') => {
      const target = '/api/auth/google?returnTo=' + encodeURIComponent(returnTo);
      const origin = authFlowOrigin();
      location.assign(origin && origin !== location.origin ? origin + target : target);
    },
  },
  signUp: {
    email: async ({ email, password, name }: { email: string; password: string; name: string; returnTo?: string }) => {
      try {
        const response = await fetch('/api/register', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password, name }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        return { data: { session: null }, error: response.ok ? null : { code: typeof result.error === 'string' ? result.error : 'auth_failed' } };
      } catch { return { data: { session: null }, error: { code: 'connection' } }; }
    },
  },
  signOut: async () => {
    try {
      const response = await fetch('/api/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      return { error: response.ok ? null : { code: 'signout_failed' } };
    } catch {
      return { error: { code: 'connection' } };
    }
  },
};
