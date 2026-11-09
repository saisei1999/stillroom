import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Only publishable project keys belong in browser configuration. */
export function createAccountClient(url: string, publishableKey: string): SupabaseClient {
  if (!url.startsWith('https://') || !publishableKey.startsWith('sb_publishable_')) {
    throw new Error('A valid HTTPS project URL and publishable key are required. Never use a secret key in the browser.');
  }
  return createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
}
