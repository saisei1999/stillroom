/**
 * Verify the migration's FAIL-CLOSED behaviour against a real PostgreSQL engine.
 *
 * These are negative tests: each one sets up a database shape the migration must
 * refuse, runs the SQL, and asserts it raises a clear error instead of silently
 * "repairing" a table it does not own. This is the property that would have
 * prevented the earlier session's mistake of dropping columns to make an apply
 * succeed.
 *
 * Requires PGlite, which is deliberately NOT a project dependency:
 *   npm install --no-save --ignore-scripts @electric-sql/pglite
 *   node supabase/verify/pg-refusal-verify.mjs
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = (p) => readFileSync(p, 'utf8');
const file = (name) => read(`supabase/migrations/${name}`);

const BOOTSTRAP = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text unique);
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('stillroom.uid', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
`;

const HISTORICAL = read('supabase/account-entries.sql');

/** A pre-existing table that already carries the sync columns (the shape that bit us). */
const ALREADY_HAS_REVISION = `
create table public.account_entries (
  owner_id uuid not null,
  id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  revision bigint not null default 1,
  deleted boolean not null default false,
  primary key (owner_id, id)
);
alter table public.account_entries enable row level security;
`;

/** A table missing the payload column entirely. */
const MISSING_PAYLOAD = `
create table public.account_entries (
  owner_id uuid not null,
  id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);
alter table public.account_entries enable row level security;
`;

/**
 * No primary key, only a PARTIAL unique index that does not cover the rows, and
 * duplicate (owner_id, id) rows. `on conflict (owner_id, id)` could not infer a
 * safe arbiter here, so the migration must refuse rather than guess.
 */
const PARTIAL_KEY_WITH_DUPLICATES = `
create table public.account_entries (
  owner_id uuid not null,
  id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.account_entries enable row level security;
create unique index account_entries_partial_key on public.account_entries (owner_id, id) where id is null;
insert into public.account_entries (owner_id, id, payload) values
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','{}'::jsonb),
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','{}'::jsonb);
`;

/** The historical table plus an unexplained third-party grant. */
const EXTRA_GRANTEE = `${HISTORICAL}
do $$ begin if not exists (select 1 from pg_roles where rolname = 'stranger') then create role stranger nologin; end if; end $$;
grant select on public.account_entries to stranger;
`;

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass += 1;
  else fail += 1;
}

async function freshDb(preSql) {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  if (preSql) await db.exec(preSql);
  return db;
}

async function closeQuietly(db) {
  await db.exec('rollback').catch(() => undefined);
  await db.close().catch(() => undefined);
}

/** Splits SQL on semicolons outside dollar-quoted bodies and string literals. */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let dollar = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length - 1;
        dollar = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += "'";
          i += 1;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollar = match[0];
        current += dollar;
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }
    if (ch === ';') {
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => s.length > 0 && !/^(begin|commit)\b/i.test(s));
}

/**
 * Runs the SQL statement by statement and returns the FIRST error message.
 * Executing the whole file in one call hides the informative `raise` behind a
 * follow-on "current transaction is aborted" error.
 */
async function firstError(db, sql) {
  for (const statement of splitStatements(sql)) {
    try {
      await db.exec(statement);
    } catch (error) {
      await db.exec('rollback').catch(() => undefined);
      // The preflight reports a generic top-line message with the specific
      // problems in `detail`/`hint`; include them so a weak refusal is visible.
      const parts = [error?.message, error?.detail, error?.hint].filter((p) => typeof p === 'string' && p.length > 0);
      return parts.join(' :: ');
    }
  }
  return '';
}

async function expectRefusal(label, preSql, sql, pattern) {
  const db = await freshDb(preSql);
  let error = '';
  try {
    error = await firstError(db, sql);
  } finally {
    await closeQuietly(db);
  }
  const refused = error.length > 0;
  const explains = pattern.test(error);
  check(label, refused && explains, error
    ? error.split('\n')[0].slice(0, 150)
    : 'NO ERROR - the SQL accepted a shape it should refuse');
}

async function expectAccepted(label, preSql, sql) {
  const db = await freshDb(preSql);
  let error = '';
  try {
    error = await firstError(db, sql);
  } finally {
    await closeQuietly(db);
  }
  check(label, error.length === 0, error.split('\n')[0]?.slice(0, 150) ?? '');
}

async function main() {
  console.log('== the migration refuses shapes it does not own ==\n');

  const scenarios = [
    ['preflight refuses a table that already has revision/deleted', ALREADY_HAS_REVISION, /revision|deleted|sync_seq/i],
    ['preflight refuses a table missing the payload column', MISSING_PAYLOAD, /payload/i],
    ['preflight refuses a partial key with duplicate (owner_id, id) rows', PARTIAL_KEY_WITH_DUPLICATES, /duplicate|partial|unique|primary/i],
    ['preflight refuses an unexplained extra grantee', EXTRA_GRANTEE, /grantee|stranger/i],
  ];
  for (const [label, preSql, pattern] of scenarios) {
    process.stdout.write(`  ... ${label}\n`);
    try {
      await expectRefusal(label, preSql, file('0000_preflight.sql'), pattern);
    } catch (error) {
      check(label, false, `harness error: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  process.stdout.write('  ... re-apply guard\n');

  // Re-applying 0001 must refuse and must not damage what is already installed.
  {
    const db = await freshDb(HISTORICAL);
    let error = '';
    try {
      await db.exec(file('0001_account_sync.sql'));
      const before = (await db.query(
        `select count(*)::int as n from information_schema.columns
          where table_schema='public' and table_name='account_entries'`,
      )).rows[0].n;
      try {
        await db.exec(file('0001_account_sync.sql'));
      } catch (e) {
        error = String(e?.message ?? e);
      }
      // The refused apply aborts its own transaction; clear it before querying.
      await db.exec('rollback').catch(() => undefined);
      const after = (await db.query(
        `select count(*)::int as n from information_schema.columns
          where table_schema='public' and table_name='account_entries'`,
      )).rows[0].n;
      const fns = (await db.query(
        `select count(*)::int as n from pg_proc
          where pronamespace='public'::regnamespace
            and proname in ('apply_entry_change','list_account_entries')`,
      )).rows[0].n;
      check('re-applying 0001 is refused', error.length > 0, error
        ? error.split('\n')[0].slice(0, 140)
        : 'NO ERROR - 0001 re-applied over an existing install');
      check('a refused re-apply leaves the schema unchanged', before === after && Number(fns) === 2,
        `columns ${before}->${after}, fns=${fns}`);
    } finally {
      await closeQuietly(db);
    }
  }

  // Control: a healthy table must NOT be refused, so the checks above mean something.
  await expectAccepted('control: the preflight accepts the real pre-0001 table', HISTORICAL, file('0000_preflight.sql'));

  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log(`${'CHECK'.padEnd(width)}  RESULT`);
  console.log('-'.repeat(width + 10));
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.ok ? 'PASS' : 'FAIL'}${r.ok ? '' : `  ${r.detail}`}`);
  console.log(`\n${pass}/${results.length} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
