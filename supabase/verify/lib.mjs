// Stillroom live authorization helpers. Zero dependencies: uses the global fetch
// from Node 18+, so it runs without npm install and without touching the app.
//
// These functions talk to Supabase's REST (PostgREST) and Auth endpoints with the
// PUBLISHABLE key only. A request succeeds or fails exactly as a browser request
// would, which is the point: this file proves the browser-facing surface.
//
// Use only a publishable or legacy anon key here. A privileged admin key bypasses
// RLS, and every isolation check below would pass while protecting nothing.

const KEY_PREFIXES = ['sb_publishable_', 'sbp_', 'eyJ'];
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Normalise and validate configuration from the environment. */
export function loadConfig(env = process.env) {
  const url = (env.SR_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (env.SR_SUPABASE_KEY ?? '').trim();
  if (!url) throw new Error('SR_SUPABASE_URL is required');
  if (!/^https:\/\//.test(url)) throw new Error('SR_SUPABASE_URL must be an https URL');
  if (!key) throw new Error('SR_SUPABASE_KEY is required');
  if (!KEY_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error('SR_SUPABASE_KEY does not look like a publishable/anon key');
  }
  return { url, key };
}

/** A REST client bound to one identity: the anon role, or a signed-in user. */
export class SupabaseRest {
  constructor({ url, key, accessToken = null }) {
    this.url = url;
    this.key = key;
    this.accessToken = accessToken;
  }

  headers(extra = {}) {
    const headers = { apikey: this.key, ...extra };
    // Without a user token the publishable key also identifies the anon role.
    headers.Authorization = `Bearer ${this.accessToken ?? this.key}`;
    return headers;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const init = { method, headers: this.headers(headers), redirect: 'error' };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${this.url}${path}`, init);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, ok: response.ok, data };
  }

  // --- Auth ---------------------------------------------------------------
  async signInWithPassword(email, password) {
    const res = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`sign-in failed for ${email}: ${res.status} ${describe(res)}`);
    }
    return res.data.access_token;
  }

  async signUp(email, password) {
    const res = await this.request('/auth/v1/signup', {
      method: 'POST',
      body: { email, password },
    });
    return res;
  }

  async refreshSession(refreshToken) {
    return this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
  }

  async signOut() {
    return this.request('/auth/v1/logout', { method: 'POST' });
  }

  async currentUser() {
    return this.request('/auth/v1/user');
  }

  // --- PostgREST ----------------------------------------------------------
  /** Raw table select. `query` is a PostgREST query string without the "?". */
  async select(table, query = '') {
    return this.request(`/rest/v1/${table}${query ? `?${query}` : ''}`);
  }

  async insert(table, rows, { prefer = 'return=representation' } = {}) {
    return this.request(`/rest/v1/${table}`, {
      method: 'POST',
      body: rows,
      headers: { Prefer: prefer },
    });
  }

  async update(table, filters, values) {
    return this.request(`/rest/v1/${table}?${filters}`, {
      method: 'PATCH',
      body: values,
      headers: { Prefer: 'return=representation' },
    });
  }

  async remove(table, filters) {
    return this.request(`/rest/v1/${table}?${filters}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
  }

  /** Call a Postgres function. `args` are the named parameters. */
  async rpc(fn, args = {}) {
    return this.request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  }
}

export function describe(res) {
  const d = res.data;
  if (d && typeof d === 'object') {
    const msg = d.message ?? d.error_description ?? d.msg ?? d.error;
    if (msg) return String(msg);
    return JSON.stringify(d).slice(0, 200);
  }
  return String(d ?? '').slice(0, 200);
}

/** True when a response is a permission denial rather than a normal failure. */
export function isDenied(res) {
  return res.status === 401 || res.status === 403 || /permission denied|row-level security|JWT/i.test(describe(res));
}

export function isMissingFunction(res) {
  return res.status === 404 || /could not find the function|does not exist|schema cache/i.test(describe(res));
}

/** Deterministic-enough UUIDs for test ids (crypto.randomUUID needs no package). */
export function newId() {
  return crypto.randomUUID();
}

export function samplePayload(note = 'stillroom test entry') {
  return {
    title: 'Stillroom authorization test',
    type: 'Book',
    status: 'Planned',
    color: 'blue',
    progress: '',
    tags: ['auth-test'],
    notes: note,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** payload whose JSON encoding is at least `bytes`, for the size-limit check. */
export function payloadOfSize(bytes) {
  const payload = { notes: '' };
  // Approximate; the server measures pg_column_size, so overshoot deliberately.
  payload.notes = 'x'.repeat(bytes);
  return payload;
}

export const TABLES = { entries: 'account_entries', ops: 'sync_operations' };
export const RPCS = { apply: 'apply_entry_change', list: 'list_account_entries' };

export const eq = (column, value) => `${column}=eq.${encodeURIComponent(value)}`;
export const and = (...parts) => parts.join('&');
