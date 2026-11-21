import { cookies } from 'next/headers';
import { authBackend } from './auth-backend.ts';
import { firebaseServerAuth } from './firebase-server-auth.ts';
import { supabaseServerAuth } from './supabase-server-auth.ts';

// Auth provider dispatch. The Firebase implementation is the legacy default;
// the fresh build sets GYMOS_AUTH_BACKEND=supabase explicitly. Both return
// the same interface consumed by the session, register, password, callback
// and Google OAuth routes.
export async function serverAuth() {
  const store = await cookies();
  return authBackend() === 'supabase' ? supabaseServerAuth(store) : firebaseServerAuth(store);
}
