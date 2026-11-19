'use client';

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
  },
  signUp: {
    email: async ({ email, password }: { email: string; password: string; name: string; returnTo?: string }) => {
      return sameOriginSignIn(email, password);
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
