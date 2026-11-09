import { describe, it, expect } from 'vitest';
import { createAccountClient } from '../src/account-client';
describe('account client configuration', () => {
  it('rejects a secret key and non-HTTPS endpoint', () => {
    expect(() => createAccountClient('https://example.supabase.co', 'sb_secret_example')).toThrow();
    expect(() => createAccountClient('http://example.test', 'sb_publishable_example')).toThrow();
  });
});
