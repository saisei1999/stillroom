import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static migration checks.
//
// These assertions read the SQL and shell scripts as text. They prove that the
// checked-in migration *says* the right things and that a regression to a known
// unsafe form fails CI. They do NOT prove the SQL runs, that RLS behaves, or that
// policies actually deny anything: only the live two-account run
// (supabase/verify/authorization.mjs) and the post-apply audit
// (supabase/migrations/0002_account_sync_verify.sql) can do that.
//
// Everything below is string analysis on purpose: CI has no database, no
// Docker and no network for these tests.

// Resolved from this file, not from the process cwd, so `npm test` works from
// any directory (vitest runs test files as ESM, so __dirname does not exist).
// `dir`/`join` are local helpers so this test needs no node:path types.
// On Windows `new URL('.', ...).pathname` is "/C:/repo/tests/": the leading slash
// must be dropped, otherwise fs resolves it as a path relative to the current
// drive ("C:\C:\repo\...").
const here = new URL('.', import.meta.url).pathname
  .replace(/\\/g, '/')
  .replace(/^\/(?=[A-Za-z]:)/, '')
  .replace(/\/+$/, '');
const dir = (path: string) => path.slice(0, path.lastIndexOf('/'));
const join = (base: string, rest: string) => `${base.replace(/\/+$/, '')}/${rest.replace(/^\/+/, '')}`;
const root = dir(here);
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = 'supabase/migrations/0001_account_sync.sql';
const VERIFY = 'supabase/migrations/0002_account_sync_verify.sql';
const ROLLBACK = 'supabase/migrations/0001_account_sync_rollback.sql';
const README = 'supabase/README.md';
const WORKFLOW = '.github/workflows/deploy.yml';
const VERIFY_LIB = 'supabase/verify/lib.mjs';
const VERIFY_AUTH = 'supabase/verify/authorization.mjs';

/** Lower-case, whitespace-collapsed copy for phrase matching that ignores layout. */
const flat = (sql: string) => sql.replace(/--[^\n]*/g, ' ').toLowerCase().replace(/\s+/g, ' ');
/** Like `flat` but also removes string literals and function bodies' literals. */
const flatNoLiterals = (sql: string) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''").toLowerCase().replace(/\s+/g, ' ');

/**
 * Strip SQL comments and string literals so that scanning for "dangerous" words
 * does not trip over prose in comments ("never a service_role key") or over
 * legitimate literals (an error message containing a word). Tests that look for
 * actual tokens use this; tests about documentation use the raw text.
 */
const code = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/g, ' FUNCTION_BODY ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .toLowerCase()
    .replace(/\s+/g, ' ');

const body = (sql: string, tag: string): string => {
  const start = sql.indexOf(`$${tag}$`);
  const end = sql.lastIndexOf(`$${tag}$`);
  if (start === -1 || end <= start) throw new Error(`body ${tag} not found`);
  return sql.slice(start + tag.length + 2, end);
};

describe('static migration checks', () => {
  it('ships the migration, audit and rollback files', () => {
    for (const file of [MIGRATION, VERIFY, ROLLBACK, README, VERIFY_LIB, VERIFY_AUTH]) {
      expect(existsSync(join(root, file)), `${file} is missing`).toBe(true);
    }
  });

  it('keeps the historical drafts out of the apply path', () => {
    // schema-draft.sql is checked in; sync-draft.sql lives only on the handoff
    // branch, so assert it is absent rather than assume it was copied here.
    expect(existsSync(join(root, 'supabase/schema-draft.sql'))).toBe(true);
    expect(existsSync(join(root, 'supabase/sync-draft.sql'))).toBe(false);
    const readme = read(README);
    expect(readme).toMatch(/schema-draft\.sql/);
    expect(readme).toMatch(/sync-draft\.sql/);
    expect(readme.toLowerCase()).toContain('never');
    // The migration may name the draft in a comment ("supersedes ..."); only the
    // executable statements must not include it.
    expect(code(read(MIGRATION))).not.toMatch(/sync-draft|schema-draft/);
  });

  // --- transaction shape ---------------------------------------------------
  it('wraps every applied statement in one transaction', () => {
    const sql = read(MIGRATION);
    const first = sql.search(/^\s*begin\s*;/im);
    const last = sql.toLowerCase().lastIndexOf('commit;');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    expect((sql.match(/^\s*begin\s*;/gim) ?? []).length).toBe(1);
    expect((sql.match(/\bcommit\s*;/gi) ?? []).length).toBe(1);
    // Nothing that changes the database may appear after the commit.
    const afterCommit = code(sql.slice(last + 'commit;'.length));
    expect(afterCommit.trim()).not.toMatch(/\b(create|alter|drop|grant|revoke)\b/);
  });

  it('never drops a table and never removes user rows in the migration', () => {
    const sql = code(read(MIGRATION));
    expect(sql).not.toMatch(/drop\s+table/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/delete from public\.account_entries/);
  });

  it('does not mask a wrong schema with "if not exists" on the pre-existing table', () => {
    const sql = code(read(MIGRATION));
    // The pre-existing table must be ALTERed, never created.
    expect(sql).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?public\.account_entries/);
    expect(sql).toMatch(/alter\s+table\s+public\.account_entries\s+add\s+column\s+revision\s+bigint\s+not\s+null\s+default\s+1/);
    expect(sql).toMatch(/alter\s+table\s+public\.account_entries\s+add\s+column\s+deleted\s+boolean\s+not\s+null\s+default\s+false/);
    // sync_operations is owned by this migration and must be created explicitly;
    // a stale conflicting table has to fail, so no "if not exists" wrapper.
    expect(sql).toMatch(/create\s+table\s+public\.sync_operations/);
    expect(sql).not.toMatch(/create\s+table\s+if\s+not\s+exists/);
  });

  // --- RLS ----------------------------------------------------------------
  it('enables row level security on every table the migration creates or manages', () => {
    const sql = code(read(MIGRATION));
    const created = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(public\.[a-z_]+)/g)].map((m) => m[1]);
    const managed = new Set([...created, 'public.account_entries']);
    for (const table of managed) {
      expect(sql, `RLS missing on ${table}`).toMatch(
        new RegExp(`alter\\s+table\\s+${table.replace('.', '\\.')}\\s+enable\\s+row\\s+level\\s+security`),
      );
    }
  });

  it('leaves no client write path to account_entries', () => {
    const sql = code(read(MIGRATION));
    expect(sql).toMatch(/revoke\s+insert\s*,\s*update\s*,\s*delete\s+on\s+public\.account_entries\s+from\s+authenticated\s*,\s*anon\s*,\s*public/);
    // No INSERT/UPDATE/DELETE policy may be created on the entries table.
    expect(sql).not.toMatch(/create\s+policy[^;]*on\s+public\.account_entries\s+for\s+(insert|update|delete|all)/);
    // The known draft policy names must be retired explicitly.
    for (const name of ['account_insert_own', 'account_update_own', 'account_delete_own']) {
      expect(sql).toMatch(new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"${name}"`));
    }
    expect(sql).toMatch(/grant\s+select\s+on\s+public\.account_entries\s+to\s+authenticated/);
  });

  it('scopes the select policy to the owner and hides tombstones', () => {
    // The policy is written as ((select auth.uid()) = owner_id), so compare the
    // predicate after removing parentheses and the init-plan wrapper's spacing.
    const sql = flatNoLiterals(read(MIGRATION));
    const policy = sql.match(/create policy [^;]*on public\.account_entries [^;]*;/)?.[0] ?? '';
    const predicate = policy.replace(/[()]/g, '').replace(/\s+/g, ' ');
    expect(policy).toContain('for select');
    expect(policy).toContain('to authenticated');
    expect(predicate).toContain('select auth.uid = owner_id');
    expect(policy).toContain('not deleted');
    expect(policy).not.toMatch(/for (insert|update|delete|all)/);
  });

  it('revokes all privileges on sync_operations and creates no policy for it', () => {
    const sql = flat(read(MIGRATION));
    expect(sql).toMatch(/revoke all on public\.sync_operations from public, anon, authenticated/);
    expect(sql).not.toMatch(/create policy [^;]*on public\.sync_operations/);
  });

  // --- grants --------------------------------------------------------------
  it('never exposes execute of a definer function to public or anon', () => {
    const sql = code(read(MIGRATION));
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function[^;]*to\s+[^;]*\banon\b/);
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function[^;]*to\s+[^;]*\bpublic\b/);
    const grants = [...sql.matchAll(/grant\s+execute\s+on\s+function\s+([^(]+)\s*\([^)]*\)\s+to\s+([a-z_, ]+)/g)];
    expect(grants.length).toBeGreaterThanOrEqual(2);
    for (const grant of grants) {
      expect(grant[2].trim(), `unexpected grantee for ${grant[1]}`).toBe('authenticated');
    }
  });

  it('revokes execute on every created function before granting it', () => {
    const sql = code(read(MIGRATION));
    for (const fn of ['apply_entry_change', 'list_account_entries']) {
      const i = sql.indexOf(`create function public.${fn}(`);
      expect(i, `${fn} not defined`).toBeGreaterThan(-1);
      const j = sql.indexOf(`grant execute on function public.${fn}`, i);
      expect(j, `${fn} grant missing`).toBeGreaterThan(i);
      const chunk = sql.slice(i, j);
      expect(chunk, `${fn} has no revoke`).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon`));
    }
  });

  // --- secrets -------------------------------------------------------------
  it('contains no secret key material in the SQL, scripts or workflow', () => {
    for (const file of [MIGRATION, VERIFY, ROLLBACK, VERIFY_LIB, VERIFY_AUTH, WORKFLOW]) {
      const text = read(file);
      expect(text.toLowerCase(), `${file} mentions a secret role`).not.toMatch(/\bservice[_-]?role\b/);
      expect(text, `${file} mentions a secret key`).not.toMatch(/sb_secret_/);
      expect(text, `${file} looks like it embeds a JWT`).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(text, `${file} looks like it embeds a legacy service JWT`).not.toMatch(/sbp_[a-f0-9]{40}/);
    }
  });

  it('only the documentation may name the forbidden key types', () => {
    // The READMEs deliberately warn about these, so they are scanned differently:
    // they must not contain an actual value, only the warning words.
    for (const file of [README, 'supabase/verify/README.md']) {
      const text = read(file);
      expect(text, `${file} appears to embed a secret key`).not.toMatch(/sb_secret_[A-Za-z0-9]/);
      expect(text, `${file} appears to embed a JWT`).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    }
    expect(read(README).toLowerCase()).toContain('never a service-role key');
  });

  it('the deploy workflow never prints secrets and does not touch Supabase', () => {
    const yml = read(WORKFLOW);
    expect(yml).not.toMatch(/\$\{\{\s*secrets\./);
    expect(yml.toLowerCase()).not.toMatch(/echo\s+.*\$\{\{\s*secrets/);
    expect(yml.toLowerCase()).not.toMatch(/sb_secret_|service_role/);
    expect(yml.toLowerCase()).not.toMatch(/supabase\s+link|supabase\s+db\s+push/);
  });

  // --- the RPC -------------------------------------------------------------
  it('defines apply_entry_change as security definer with an empty search_path', () => {
    const sql = flat(read(MIGRATION));
    const head = sql.match(/create function public\.apply_entry_change \([^$]*?as \$apply\$/)?.[0]
      ?? sql.match(/create function public\.apply_entry_change[\s\S]*?as \$apply\$/)?.[0]
      ?? '';
    expect(head).not.toBe('');
    expect(head).toContain('security definer');
    expect(head).toContain("set search_path = ''");
  });

  it('defines list_account_entries as security definer with an empty search_path', () => {
    const sql = flat(read(MIGRATION));
    // Match at the signature, not the first literal in the file.
    const head = sql.match(/create function public\.list_account_entries\([\s\S]*?as \$list\$/)?.[0] ?? '';
    expect(head).not.toBe('');
    expect(head).toContain('security definer');
    expect(head).toContain("set search_path = ''");
    // The owner filter and tombstone visibility live in the function body.
    const listBody = body(read(MIGRATION), 'list').toLowerCase();
    expect(listBody).toContain('owner_id = auth.uid()');
    expect(listBody).toContain('deleted');
    expect(listBody).not.toContain('not deleted');
  });

  it('schema-qualifies every relation reference inside the definer bodies', () => {
    const sql = read(MIGRATION);
    // Words that can follow FROM/INTO/UPDATE in prose-like code without naming a
    // relation ("... from also", "update set ...").
    const stop = new Set(['set', 'values', 'select', 'where', 'conflict', 'also', 'v_row', 'v_applied']);
    for (const [tag, fn] of [['apply', 'apply_entry_change'], ['list', 'list_account_entries']]) {
      const text = body(sql, tag).toLowerCase();
      const targets = [
        ...new Set(
          [...text.matchAll(/\b(?:from|into|update|insert into)\s+([a-z_][a-z0-9_.]*)/g)]
            .map((m) => m[1])
            .filter((name) => !stop.has(name)),
        ),
      ];
      expect(targets.length, `${fn} references no relation`).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target, `${fn} references unqualified ${target}`).toMatch(/^(public|auth)\./);
      }
    }
  });

  it('the apply RPC requires an authenticated caller before doing anything', () => {
    const text = body(read(MIGRATION), 'apply');
    const uidCheck = text.indexOf('v_uid is null');
    expect(uidCheck).toBeGreaterThan(-1);
    // The null check must precede the first write and the first row read.
    for (const later of ['select * into v_row', 'insert into public.', 'update public.']) {
      const i = text.toLowerCase().indexOf(later);
      expect(i).toBeGreaterThan(uidCheck);
    }
  });

  it('the apply RPC filters every relation statement by owner_id = caller', () => {
    // Strip literals first: a random `;` inside an error message would otherwise
    // split a statement and hide the guard this test is looking for.
    const text = body(read(MIGRATION), 'apply')
      .replace(/--[^\n]*/g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''")
      .toLowerCase();
    // Only statements that actually touch a relation need an owner filter;
    // `return query select 'applied', v_revision, ...` returns scalars.
    const relationStatements = text
      .split(';')
      .filter((s) => /\b(from|into)\s+public\.|\bupdate\s+public\.|\binsert\s+into\s+public\./.test(s));
    expect(relationStatements.length).toBeGreaterThanOrEqual(5);
    for (const statement of relationStatements) {
      const guarded =
        statement.includes('owner_id = v_uid') ||
        statement.includes('(owner_id,') || // insert column list; values carry v_uid
        statement.includes('values (v_uid');
      expect(guarded, `unguarded statement: ${statement.trim().slice(0, 90)}`).toBe(true);
    }
    // And the uid itself comes from auth.uid(), never from a parameter.
    expect(text).toMatch(/v_uid uuid := auth\.uid\(\)/);
  });

  it('the apply RPC rejects missing and out-of-revision input explicitly', () => {
    const text = body(read(MIGRATION), 'apply').toLowerCase();
    expect(text).toMatch(/raise exception/);
    expect(text).toMatch(/errcode = '42501'/);
    expect(text).toMatch(/p_expected_revision < 0/);
    expect(text).toMatch(/jsonb_typeof\(p_payload\) <> 'object'/);
    expect(text).toMatch(/pg_catalog\.pg_column_size\(p_payload\) > 262144/);
  });

  it('bounds payload size both in the RPC and as a table constraint', () => {
    const sql = flat(read(MIGRATION));
    expect(sql).toMatch(/pg_catalog\.pg_column_size\(p_payload\) > 262144/);
    expect(sql).toMatch(/constraint account_entries_payload_size_check check \(pg_catalog\.pg_column_size\(payload\) <= 262144\)/);
  });

  it('checks idempotency before the revision conflict and reports already_applied', () => {
    const text = body(read(MIGRATION), 'apply').toLowerCase();
    const idempotency = text.indexOf('already_applied');
    const conflict = text.indexOf("'conflict'");
    expect(idempotency).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(idempotency);
    // The existing-row branch consults the operation log before comparing revisions.
    const existingBranch = text.slice(text.indexOf('if found then'));
    expect(existingBranch.indexOf('sync_operations')).toBeLessThan(existingBranch.indexOf('v_row.revision <> p_expected_revision'));
    // already_applied returns the row's current state, not the stored op payload.
    expect(text).toMatch(/return query select 'already_applied'[^;]*v_row\.payload/);
  });

  it('creates rows at revision 1 and requires expected revision 0 for a create', () => {
    const text = body(read(MIGRATION), 'apply').toLowerCase();
    expect(text).toMatch(/v_revision := 1/);
    expect(text).toMatch(/if p_expected_revision <> 0 then/);
    expect(text).toMatch(/v_revision := v_row\.revision \+ 1/);
  });

  it('stores tombstones as an empty object and revives them as normal updates', () => {
    const text = body(read(MIGRATION), 'apply');
    expect(text.toLowerCase()).toMatch(/case when p_deleted then '\{\}'::jsonb else p_payload end/);
    // The resurrect rule is documented, not a special branch that skips revision checks.
    expect(read(MIGRATION)).toMatch(/RESURRECT RULE/);
    expect(text.toLowerCase()).not.toMatch(/if v_row\.deleted then\s+.*insert/);
  });

  it('locks the entry before the operation log on every path', () => {
    const text = body(read(MIGRATION), 'apply').toLowerCase();
    const lock = text.indexOf('for update');
    expect(lock).toBeGreaterThan(-1);
    // The first operation-log read happens after the entry lock.
    expect(text.indexOf('from public.sync_operations')).toBeGreaterThan(lock);
  });

  it('returns exactly the documented outcome columns', () => {
    // Layout-independent: the signature spans several lines, so compare the
    // normalised column list rather than an exact one-line string.
    const sql = flatNoLiterals(read(MIGRATION));
    expect(sql).toMatch(
      /returns table \( outcome text, revision bigint, payload jsonb, deleted boolean, applied_revision bigint \)/,
    );
  });

  it('adds the revision check, ownership key and pull index', () => {
    const sql = flat(read(MIGRATION));
    expect(sql).toMatch(/constraint account_entries_revision_check check \(revision >= 1\)/);
    expect(sql).toMatch(/constraint account_entries_owner_id_id_key unique \(owner_id, id\)/);
    expect(sql).toMatch(/create index if not exists account_entries_owner_updated_idx on public\.account_entries \(owner_id, updated_at, id\)/);
  });

  it('sync_operations has the documented keys and cascade', () => {
    const sql = flat(read(MIGRATION));
    expect(sql).toMatch(/owner_id uuid not null references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/operation_id uuid not null/);
    expect(sql).toMatch(/constraint sync_operations_pkey primary key \(owner_id, operation_id\)/);
    expect(sql).toMatch(/created_at timestamptz not null default now\(\)/);
  });

  // --- the audit and the documentation -------------------------------------
  it('the audit file is read-only and checks the same invariants', () => {
    const sql = flat(read(VERIFY));
    expect(sql).toMatch(/begin read only/);
    expect(sql).not.toMatch(/\b(create|alter|drop|grant|revoke|insert|update|delete)\b (table|function|policy|index|on)/);
    expect(sql).toContain('row level security');
    expect(sql).toContain('search_path=""');
    expect(sql).toContain('has_table_privilege');
    expect(sql).toContain('has_function_privilege');
  });

  it('the rollback restores a select policy and destroys no user data', () => {
    const sql = code(read(ROLLBACK));
    // The only table it may drop is the derived operation log, never the entries.
    const dropped = [...sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(public\.[a-z_]+)/g)].map((m) => m[1]);
    expect(dropped).toEqual(['public.sync_operations']);
    expect(sql).not.toMatch(/drop\s+(column|table)[^;]*account_entries[^;]*(revision|payload|owner_id)/);
    expect(sql).not.toMatch(/delete from public\.account_entries/);
    expect(sql).toMatch(/drop function if exists public\.apply_entry_change/);
    expect(sql).toMatch(/drop function if exists public\.list_account_entries/);
    expect(sql).toMatch(/create policy "account_select_own"/);
  });

  it('the README documents the preconditions, order, rollback and security limits', () => {
    const text = read(README).toLowerCase();
    for (const phrase of ['precondition', 'rollback', 'redirect', 'confirm email', 'smtp', 'paus', 'publishable']) {
      expect(text, `README does not mention ${phrase}`).toContain(phrase);
    }
    expect(text).toContain('hmrmcpsrzrhwquyxdfta');
  });

  it('the live proof script documents every required isolation check', () => {
    const text = read(VERIFY_AUTH);
    for (const phrase of [
      'anon: select account_entries denied',
      'cannot plain-select',
      'cannot overwrite',
      'idempotent',
      'already_applied',
      'oversized payload rejected',
      'list_account_entries cannot see',
    ]) {
      expect(text, `authorization.mjs lacks a check for "${phrase}"`).toContain(phrase);
    }
    expect(text).toMatch(/process\.exitCode = 1/);
  });
});
