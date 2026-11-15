import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { transportOf } from '../src/sync-control';
import { SyncIdentityError } from '../src/account-sync';

describe('account-pinned requests', () => {
  it('does not claim an in-flight request was never sent', () => {
    expect(new SyncIdentityError().message).not.toMatch(/nothing was sent/i);
  });
  it('refuses to send if the current session belongs to another account', async () => {
    const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: 'B' }, access_token: 'token-B' } }, error: null });
    const makeClient = vi.fn();
    const client = { auth: { getSession } } as unknown as SupabaseClient;
    await expect(transportOf(client, 'A', makeClient).rpc('apply_entry_change', {})).rejects.toThrow();
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('uses the intended account token even if the session changes before the request completes', async () => {
    let account = 'A';
    const getSession = vi.fn(async () => ({ data: { session: { user: { id: account }, access_token: `token-${account}` } }, error: null }));
    const rpc = vi.fn(async () => { account = 'B'; return { data: [{ outcome: 'applied' }], error: null }; });
    const makeClient = vi.fn(() => ({ rpc }) as unknown as Pick<SupabaseClient, 'rpc'>);
    const client = { auth: { getSession } } as unknown as SupabaseClient;
    const transport = transportOf(client, 'A', makeClient);
    await transport.rpc('apply_entry_change', {});
    expect(makeClient).toHaveBeenCalledWith('token-A');
    expect(await transport.currentUserId()).toBe('B');
  });
});
