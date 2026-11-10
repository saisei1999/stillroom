/**
 * Run the real Stillroom migration SQL against a real PostgreSQL engine
 * (PGlite = Postgres compiled to WASM) and verify the RPC contract, account
 * isolation, tombstones and cursor paging actually behave as designed.
 *
 * Requires PGlite, which is deliberately NOT a project dependency (it is a large
 * WASM build). Install it just for this check, from the repo root:
 *
 *   npm install --no-save --ignore-scripts @electric-sql/pglite
 *   node supabase/verify/pg-local-verify.mjs
 *
 * It creates an auth stub (schema, users table, `auth.uid()` reading the
 * `stillroom.uid` GUC, and anon/authenticated roles) so the migration and RLS
 * can run. That makes this a strong check of the SQL itself, but NOT proof of
 * Supabase production: there is no GoTrue, no PostgREST, and the role/ACL
 * surface is emulated. The live two-account proof is authorization.mjs.
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

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass += 1;
  else fail += 1;
}

/** Splits SQL into statements, respecting dollar-quoted bodies and string literals. */
function splitStatements(sql) {
  // Drop `--` line comments first (outside strings) so a semicolon inside a
  // comment cannot split a statement.
  let cleaned = '';
  let inString = false;
  let dollarSkip = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (dollarSkip) {
      if (sql.startsWith(dollarSkip, i)) {
        cleaned += dollarSkip;
        i += dollarSkip.length - 1;
        dollarSkip = null;
        continue;
      }
      cleaned += ch;
      continue;
    }
    if (inString) {
      cleaned += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cleaned += "'";
          i += 1;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarSkip = match[0];
        cleaned += dollarSkip;
        i += dollarSkip.length - 1;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      cleaned += '\n';
      continue;
    }
    cleaned += ch;
  }

  const out = [];
  let current = '';
  let dollar = null;
  inString = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (dollar) {
      if (cleaned.startsWith(dollar, i)) {
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
        if (cleaned[i + 1] === "'") {
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
      const match = /^\$[A-Za-z_]*\$/.exec(cleaned.slice(i));
      if (match) {
        dollar = match[0];
        current += dollar;
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

async function main() {
  const db = new PGlite();

  // ---------------------------------------------------------------- bootstrap
  await db.exec(BOOTSTRAP);
  await db.exec(read('supabase/account-entries.sql'));

  const USER_A = '11111111-1111-4111-8111-111111111111';
  const USER_B = '22222222-2222-4222-8222-222222222222';
  await db.exec(`insert into auth.users (id, email) values ('${USER_A}','a@example.com'), ('${USER_B}','b@example.com')`);

  // ---------------------------------------------------------------- preflight
  let preflightOk = false;
  let preflightNotice = '';
  const notices = [];
  db.onNotice?.((n) => notices.push(n.message ?? String(n)));
  try {
    await db.exec(file('0000_preflight.sql'));
    preflightOk = true;
  } catch (error) {
    preflightNotice = String(error?.message ?? error).split('\n')[0];
  }
  const sawOk = notices.some((n) => /PREFLIGHT OK/.test(n));
  check('0000 preflight runs cleanly on the pre-0001 table', preflightOk, preflightNotice || (sawOk ? 'PREFLIGHT OK' : 'ran (notice not captured)'));

  // ---------------------------------------------------------------- migration
  let migrated = false;
  let migrateError = '';
  try {
    await db.exec(file('0001_account_sync.sql'));
    migrated = true;
  } catch (error) {
    migrateError = String(error?.message ?? error).split('\n').slice(0, 3).join(' | ');
  }
  check('0001 migration applies', migrated, migrateError);

  if (!migrated) return finish(db);

  // ---------------------------------------------------------------- 0002 audit
  const auditStatements = splitStatements(file('0002_account_sync_verify.sql'));
  let auditErrors = 0;
  const auditErrorText = [];
  for (const statement of auditStatements) {
    if (/^begin read only$/i.test(statement) || /^commit$/i.test(statement)) continue;
    try {
      await db.exec(statement);
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0];
      // The anon probe is EXPECTED to be denied; that denial is the pass.
      if (/permission denied/i.test(message)) continue;
      auditErrors += 1;
      auditErrorText.push(message);
      await db.exec('rollback').catch(() => undefined);
    }
  }
  check('0002 audit statements run (only anon-denial errors allowed)', auditErrors === 0, auditErrorText.slice(0, 3).join(' | '));

  // ---------------------------------------------------------------- shape
  const cols = (await db.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='account_entries' order by ordinal_position`,
  )).rows.map((r) => r.column_name);
  check('account_entries gained revision/deleted/sync_seq', ['revision', 'deleted', 'sync_seq'].every((c) => cols.includes(c)), cols.join(','));

  const fns = (await db.query(
    `select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig,','),'') as cfg
       from pg_proc p where p.pronamespace='public'::regnamespace order by p.proname`,
  )).rows;
  const applyFn = fns.find((f) => f.proname === 'apply_entry_change');
  const listFn = fns.find((f) => f.proname === 'list_account_entries');
  check('both RPCs exist, are security definer with an empty search_path',
    !!applyFn && !!listFn && applyFn.prosecdef && listFn.prosecdef && /search_path=""/.test(applyFn.cfg.replace(/'/g, '"')) && /search_path=""/.test(listFn.cfg.replace(/'/g, '"')),
    JSON.stringify(fns));

  const acl = (await db.query(
    `select coalesce(pg_get_userbyid(x.grantee),'PUBLIC') as grantee, x.privilege_type
       from pg_class c, aclexplode(c.relacl) x where c.oid='public.account_entries'::regclass order by 1,2`,
  )).rows;
  const authenticatedWrite = acl.some((r) => r.grantee === 'authenticated' && r.privilege_type !== 'SELECT');
  check('authenticated holds only SELECT on account_entries', !authenticatedWrite, acl.map((r) => `${r.grantee}:${r.privilege_type}`).join(','));

  // ---------------------------------------------------------------- helpers
  const asUser = async (uid, role = 'authenticated') => {
    await db.exec('reset role');
    await db.exec(`select set_config('stillroom.uid', '${uid}', false)`);
    await db.exec(`set role ${role}`);
  };
  const asOwner = async () => {
    await db.exec('reset role');
    await db.exec(`select set_config('stillroom.uid', '', false)`);
  };

  const apply = async (id, op, expected, payload, deleted = false) => {
    const { rows } = await db.query(
      `select * from public.apply_entry_change($1::uuid,$2::uuid,$3::bigint,$4::jsonb,$5::boolean)`,
      [id, op, expected, JSON.stringify(payload), deleted],
    );
    return rows[0];
  };
  const list = async (afterSeq, limit = 500) => {
    const { rows } = await db.query(`select * from public.list_account_entries($1::bigint,$2::integer)`, [afterSeq, limit]);
    return rows;
  };
  const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const opId = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

  // ---------------------------------------------------------------- A write path
  await asUser(USER_A);
  const created = await apply(uuid(1), opId(1), 0, { title: 'created by A' });
  check('A can create (applied, revision 1)', created?.outcome === 'applied' && Number(created.revision) === 1, JSON.stringify(created));

  const recreate = await apply(uuid(1), opId(2), 0, { title: 'smash attempt' });
  check('create with expected 0 cannot overwrite an existing row', recreate?.outcome === 'conflict', JSON.stringify(recreate));

  const updated = await apply(uuid(1), opId(3), 1, { title: 'updated by A' });
  check('A update at the right revision advances to 2', updated?.outcome === 'applied' && Number(updated.revision) === 2, JSON.stringify(updated));

  const stale = await apply(uuid(1), opId(4), 1, { title: 'stale edit' });
  check('stale expected revision returns a conflict with the current row',
    stale?.outcome === 'conflict' && Number(stale.revision) === 2 && stale.payload?.title === 'updated by A', JSON.stringify(stale));

  const replay = await apply(uuid(1), opId(3), 1, { title: 'updated by A' });
  check('replaying an operation id with identical content is already_applied',
    replay?.outcome === 'already_applied' && Number(replay.revision) === 2, JSON.stringify(replay));

  let reuseError = '';
  try {
    await apply(uuid(1), opId(3), 1, { title: 'DIFFERENT content' });
  } catch (error) {
    reuseError = String(error?.message ?? error);
  }
  check('reusing an operation id with different content is a controlled error',
    /already used for different content/i.test(reuseError), reuseError.slice(0, 120));

  const appliedSeq = (await db.query(`select sync_seq from public.account_entries where id = $1::uuid`, [uuid(1)])).rows[0]?.sync_seq;
  check('a committed write carries a positive sync_seq', Number(appliedSeq) >= 1, String(appliedSeq));

  // ---------------------------------------------------------------- B isolation
  await asUser(USER_B);
  const bList = await list(null);
  check('B list_account_entries cannot see A rows', !bList.some((r) => r.id === uuid(1)), `rows=${bList.length}`);

  const bSelect = await db.query(`select id from public.account_entries where id = $1::uuid`, [uuid(1)]);
  check('B plain select cannot see A rows', bSelect.rows.length === 0, `rows=${bSelect.rows.length}`);

  const bOverwrite = await apply(uuid(1), opId(9), 0, { title: 'B hijack' });
  // Ids are unique per OWNER, so B legitimately creates its own row under that
  // uuid. The security property (A's row unchanged) is asserted below as A.
  const bOwnRow = (await db.query(`select revision from public.account_entries where id=$1::uuid and owner_id=$2::uuid`, [uuid(1), USER_B])).rows[0];
  check('B may hold its own row with that uuid (ids are per owner)', Number(bOwnRow?.revision) >= 1, `outcome=${bOverwrite?.outcome} ${JSON.stringify(bOwnRow ?? null)}`);

  const bOverwrite2 = await apply(uuid(1), opId(10), 2, { title: 'B hijack 2' });
  check('B cannot overwrite A row with a valid revision', bOverwrite2?.outcome === 'conflict', JSON.stringify(bOverwrite2));

  let bDirect = '';
  try {
    await db.query(`update public.account_entries set payload='{}'::jsonb where id=$1::uuid`, [uuid(1)]);
  } catch (error) {
    bDirect = String(error?.message ?? error);
  }
  check('B direct UPDATE is denied', /permission denied/i.test(bDirect), bDirect.slice(0, 90));

  await asUser(USER_A);
  const aRow = await db.query(`select revision, payload->>'title' as title from public.account_entries where id=$1::uuid`, [uuid(1)]);
  check('A row is unchanged after all B attempts',
    Number(aRow.rows[0]?.revision) === 2 && aRow.rows[0]?.title === 'updated by A', JSON.stringify(aRow.rows[0]));

  // ---------------------------------------------------------------- tombstones
  const deleted = await apply(uuid(1), opId(5), 2, {}, true);
  check('delete applies a tombstone at revision 3', deleted?.outcome === 'applied' && Number(deleted.revision) === 3 && deleted.deleted === true, JSON.stringify(deleted));

  const visibleAfterDelete = await db.query(`select id from public.account_entries where id=$1::uuid`, [uuid(1)]);
  check('tombstone is hidden from a plain select', visibleAfterDelete.rows.length === 0, `rows=${visibleAfterDelete.rows.length}`);

  const pulledAfterDelete = await list(null);
  const tomb = pulledAfterDelete.find((r) => r.id === uuid(1));
  check('pull RPC still reports the tombstone', tomb?.deleted === true && Number(tomb?.revision) === 3, JSON.stringify(tomb ?? null).slice(0, 120));

  const revived = await apply(uuid(1), opId(6), 3, { title: 'resurrected by A' });
  check('a tombstone revives when the expected revision matches', revived?.outcome === 'applied' && Number(revived.revision) === 4, JSON.stringify(revived));

  // ---------------------------------------------------------------- pagination
  // Eight rows written so that several share an identical updated_at: the old
  // timestamp cursor could skip rows in this exact shape.
  await asOwner();
  await db.exec(`update public.account_entries set updated_at = '2026-01-01T00:00:00Z'`);
  await asUser(USER_A);
  for (let i = 20; i < 28; i += 1) await apply(uuid(i), opId(i), 0, { title: `tie ${i}` });
  await asOwner();
  await db.exec(`update public.account_entries set updated_at = '2026-01-01T00:00:00Z' where deleted = false`);
  await asUser(USER_A);

  const allRows = await list(null);
  const paged = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await list(cursor, 2);
    paged.push(...page);
    if (page.length < 2) break;
    cursor = page[page.length - 1].sync_seq;
  }
  const pagedIds = new Set(paged.map((r) => r.id));
  const allIds = allRows.map((r) => r.id);
  check('paging by sync_seq returns every row exactly once (no skipped ties)',
    paged.length === allIds.length && allIds.every((id) => pagedIds.has(id)),
    `paged=${paged.length} all=${allIds.length}`);
  check('paging never repeats a row', new Set(paged.map((r) => r.sync_seq)).size === paged.length, `unique=${new Set(paged.map((r) => r.sync_seq)).size} of ${paged.length}`);

  // ---------------------------------------------------------------- anon
  await asUser('', 'anon');
  let anonDenied = false;
  try {
    await db.exec(`select id from public.account_entries limit 1`);
    anonDenied = false;
  } catch (error) {
    anonDenied = /permission denied/i.test(String(error?.message ?? error));
  }
  let anonRpcDenied = false;
  try {
    await apply(uuid(99), opId(99), 0, { title: 'anon' });
    anonRpcDenied = false;
  } catch (error) {
    anonRpcDenied = /permission denied|not exist/i.test(String(error?.message ?? error));
  }
  check('anon cannot read the table or call the RPCs', anonDenied && anonRpcDenied, `select=${anonDenied} rpc=${anonRpcDenied}`);

  // ---------------------------------------------------------------- rollback
  await asOwner();
  let rollbackOk = false;
  let rollbackError = '';
  try {
    await db.exec(file('0001_account_sync_rollback.sql'));
    rollbackOk = true;
  } catch (error) {
    rollbackError = String(error?.message ?? error).split('\n')[0];
  }
  const afterRollback = (await db.query(
    `select count(*)::int as fns from pg_proc where pronamespace='public'::regnamespace and proname in ('apply_entry_change','list_account_entries')`,
  )).rows[0];
  check('rollback runs and removes both RPCs', rollbackOk && Number(afterRollback?.fns) === 0, rollbackError || JSON.stringify(afterRollback));

  const rowsSurvived = (await db.query(`select count(*)::int as n from public.account_entries`)).rows[0];
  check('rollback deletes no rows', Number(rowsSurvived?.n) > 0, JSON.stringify(rowsSurvived));

  return finish(db);
}

async function finish(db) {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log(`\n${'CHECK'.padEnd(width)}  RESULT`);
  console.log('-'.repeat(width + 10));
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.ok ? 'PASS' : 'FAIL'}${r.ok ? '' : `  ${r.detail}`}`);
  console.log(`\n${pass}/${results.length} passed, ${fail} failed`);
  await db.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
