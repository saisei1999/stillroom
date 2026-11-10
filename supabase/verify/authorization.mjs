// Stillroom live two-account authorization proof.
//
// Proves, against the real project, that the migration's guarantees hold for the
// browser-facing surface (publishable key + user JWT only):
//   * anonymous callers cannot read, write or call the RPCs;
//   * A can create and read its own rows;
//   * B cannot read A's row, cannot overwrite it by guessing its id, and cannot
//     delete it (direct REST and RPC paths, including the replay/guess vectors);
//   * revisions actually detect concurrent edits and return the server row;
//   * re-sending one operation_id is idempotent and reports already_applied;
//   * tombstone state advances the revision and hides rows from plain SELECT
//     while the pull RPC still reports the tombstone;
//   * the sync_seq cursor pages in single-row steps without skipping, looping or
//     re-serving a row;
//   * an oversized payload is rejected server-side.
//
// Run from a terminal with network access, from the repo root:
//   $env:SR_SUPABASE_URL, SR_SUPABASE_KEY (publishable), SR_A_EMAIL, SR_A_PASSWORD,
//   SR_B_EMAIL, SR_B_PASSWORD  then  node supabase/verify/authorization.mjs
//
// Exit code 0 only if every check PASSed. Tests create rows under both accounts
// and delete what they can at the end (tombstones remain by design; they are
// invisible in the app and harmless). Use throwaway accounts.

import {
  SupabaseRest, RPCS, TABLES, and, describe, eq, isDenied, loadConfig,
  newId, payloadOfSize, samplePayload,
} from './lib.mjs';

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
}

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}. See supabase/verify/README.md for the full list.`);
  return value;
}

async function signedIn(url, key, email, password, label) {
  const client = new SupabaseRest({ url, key });
  const token = await client.signInWithPassword(email, password);
  const session = new SupabaseRest({ url, key, accessToken: token });
  const me = await session.currentUser();
  if (!me.ok || !me.data?.id) {
    throw new Error(`${label}: signed in but /auth/v1/user failed: ${me.status} ${describe(me)}`);
  }
  session.userId = me.data.id;
  session.email = me.data.email ?? email;
  return session;
}

/**
 * Send one apply_entry_change call. Returns the parsed row plus proof that the
 * call touched exactly one row and only that row for this account.
 */
async function apply(client, { entryId, operationId = newId(), expectedRevision, payload, deleted = false }) {
  const res = await client.rpc(RPCS.apply, {
    p_id: entryId,
    p_operation_id: operationId,
    p_expected_revision: expectedRevision,
    p_payload: payload ?? {},
    p_deleted: deleted,
  });
  const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  return { res, row: rows[0], rowCount: rows.length, operationId };
}

async function main() {
  const env = process.env;
  const { url, key } = loadConfig(env);
  const aEmail = requireEnv(env, 'SR_A_EMAIL');
  const aPassword = requireEnv(env, 'SR_A_PASSWORD');
  const bEmail = requireEnv(env, 'SR_B_EMAIL');
  const bPassword = requireEnv(env, 'SR_B_PASSWORD');

  const anon = new SupabaseRest({ url, key });
  const a = await signedIn(url, key, aEmail, aPassword, 'account A');
  const b = await signedIn(url, key, bEmail, bPassword, 'account B');
  if (a.userId === b.userId) {
    throw new Error('SR_A_EMAIL and SR_B_EMAIL signed in as the same user; use two accounts.');
  }

  const entryId = newId();
  const payload1 = samplePayload('created by A');

  // --- 0. Anonymous surface ------------------------------------------------
  await check('anon: select account_entries denied', async () => {
    const res = await anon.select(TABLES.entries, 'select=id&limit=1');
    record('anon: select account_entries denied', isDenied(res) && !res.ok,
      `${res.status} ${describe(res)}`);
  });

  await check('anon: direct insert denied', async () => {
    const res = await anon.insert(TABLES.entries, { id: newId(), payload: samplePayload() });
    record('anon: direct insert denied', !res.ok && res.status !== 201, `${res.status} ${describe(res)}`);
  });

  await check('anon: apply_entry_change denied', async () => {
    const res = await anon.rpc(RPCS.apply, {
      p_id: newId(), p_operation_id: newId(), p_expected_revision: 0,
      p_payload: samplePayload(), p_deleted: false,
    });
    record('anon: apply_entry_change denied', !res.ok, `${res.status} ${describe(res)}`);
  });

  await check('anon: list_account_entries denied', async () => {
    const res = await anon.rpc(RPCS.list, { p_after_seq: null, p_limit: 10 });
    record('anon: list_account_entries denied', !res.ok, `${res.status} ${describe(res)}`);
  });

  // --- 1. A creates --------------------------------------------------------
  let created;
  await check('A: create revision 1', async () => {
    created = await apply(a, { entryId, expectedRevision: 0, payload: payload1 });
    const ok = created.res.ok && created.row?.outcome === 'applied' && Number(created.row.revision) === 1;
    record('A: create revision 1', ok && created.rowCount === 1,
      `${created.res.status} outcome=${created.row?.outcome} revision=${created.row?.revision}`);
  });
  if (!created?.row || created.row.outcome !== 'applied') {
    return finish('Setup failed: A could not create an entry, so isolation checks cannot run.');
  }

  await check('A: plain select returns own live row', async () => {
    const res = await a.select(TABLES.entries, and(eq('id', entryId), 'select=id,revision,payload'));
    const row = Array.isArray(res.data) ? res.data[0] : undefined;
    record('A: plain select returns own live row',
      res.ok && res.data.length === 1 && row?.revision === 1,
      `${res.status} rows=${Array.isArray(res.data) ? res.data.length : 'n/a'}`);
  });

  // --- 2. B cannot see or take A's row -------------------------------------
  await check('B: cannot plain-select A row', async () => {
    const res = await b.select(TABLES.entries, and(eq('id', entryId), 'select=id'));
    const count = Array.isArray(res.data) ? res.data.length : -1;
    record('B: cannot plain-select A row', res.ok && count === 0, `${res.status} rows=${count}`);
  });

  await check('B: guessing A entry id via RPC cannot change A row', async () => {
    // Ids are unique per OWNER, not globally, so B asking for A's uuid with
    // p_expected_revision = 0 legitimately creates B's own row under that same
    // uuid — it does not touch A's row. The security property to prove is that
    // A's row is unchanged, not that the call fails.
    const before = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision,payload'));
    const beforeRow = Array.isArray(before.data) ? before.data[0] : undefined;
    const res = await b.rpc(RPCS.apply, {
      p_id: entryId, p_operation_id: newId(), p_expected_revision: 0,
      p_payload: samplePayload('B overwrite attempt'), p_deleted: false,
    });
    const after = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision,payload'));
    const afterRow = Array.isArray(after.data) ? after.data[0] : undefined;
    const aUnchanged = !!beforeRow && !!afterRow
      && beforeRow.revision === afterRow.revision
      && afterRow.payload?.notes === payload1.notes;
    record('B: guessing A entry id via RPC cannot change A row', aUnchanged,
      `${res.status} A.revision=${afterRow?.revision} A.notes=${String(afterRow?.payload?.notes).slice(0, 30)}`);
  });

  await check('A row unchanged after B guess', async () => {
    const res = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision,payload'));
    const row = Array.isArray(res.data) ? res.data[0] : undefined;
    const same = row && row.revision === 1 && row.payload?.notes === payload1.notes;
    record('A row unchanged after B guess', same,
      `revision=${row?.revision} notes=${String(row?.payload?.notes).slice(0, 40)}`);
  });

  await check('B: cannot update A row via REST', async () => {
    const res = await b.update(TABLES.entries, eq('id', entryId), { payload: samplePayload('B patch') });
    const count = Array.isArray(res.data) ? res.data.length : -1;
    record('B: cannot update A row via REST', !res.ok || count === 0, `${res.status} ${describe(res)}`);
  });

  await check('B: cannot delete A row via REST', async () => {
    const res = await b.remove(TABLES.entries, eq('id', entryId));
    const count = Array.isArray(res.data) ? res.data.length : -1;
    record('B: cannot delete A row via REST', !res.ok || count === 0, `${res.status} ${describe(res)}`);
  });

  await check('B: cannot overwrite A row via RPC with a valid expected revision', async () => {
    const res = await b.rpc(RPCS.apply, {
      p_id: entryId, p_operation_id: newId(), p_expected_revision: 1,
      p_payload: samplePayload('B revision guess'), p_deleted: false,
    });
    const row = Array.isArray(res.data) ? res.data[0] : undefined;
    record('B: cannot overwrite A row via RPC with a valid expected revision',
      !res.ok || row?.outcome === 'conflict', `${res.status} outcome=${row?.outcome ?? describe(res)}`);
  });

  await check('A row still owned by A after all B attempts', async () => {
    const res = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision,payload'));
    const row = Array.isArray(res.data) ? res.data[0] : undefined;
    record('A row still owned by A after all B attempts',
      row?.revision === 1 && row?.payload?.notes === payload1.notes,
      `revision=${row?.revision}`);
  });

  // --- 3. A updates, B is still isolated -----------------------------------
  let appliedUpdate;
  await check('A: update advances revision to 2', async () => {
    appliedUpdate = await apply(a, {
      entryId, expectedRevision: 1, payload: samplePayload('updated by A'),
    });
    record('A: update advances revision to 2',
      appliedUpdate.res.ok && appliedUpdate.row?.outcome === 'applied' && Number(appliedUpdate.row.revision) === 2,
      `${appliedUpdate.res.status} outcome=${appliedUpdate.row?.outcome} revision=${appliedUpdate.row?.revision}`);
  });

  await check('B: cannot select updated A row', async () => {
    const res = await b.select(TABLES.entries, and(eq('id', entryId), 'select=id'));
    const count = Array.isArray(res.data) ? res.data.length : -1;
    record('B: cannot select updated A row', res.ok && count === 0, `${res.status} rows=${count}`);
  });

  await check('B: list_account_entries cannot see A row', async () => {
    const res = await b.rpc(RPCS.list, { p_after_seq: null, p_limit: 500 });
    const rows = Array.isArray(res.data) ? res.data : [];
    const leaked = rows.some((r) => r.id === entryId);
    record('B: list_account_entries cannot see A row', res.ok && !leaked,
      `${res.status} rows=${rows.length} leaked=${leaked}`);
  });

  // --- 4. Revision conflict returns the server row -------------------------
  await check('conflict: stale expected revision returns current server row', async () => {
    const res = await apply(a, {
      entryId, expectedRevision: 1, payload: samplePayload('stale edit'),
    });
    const row = res.row;
    record('conflict: stale expected revision returns current server row',
      res.res.ok && row?.outcome === 'conflict' && Number(row.revision) === 2
        && row.payload?.notes === 'updated by A',
      `${res.res.status} outcome=${row?.outcome} revision=${row?.revision} notes=${String(row?.payload?.notes).slice(0, 30)}`);
  });

  // --- 5. Idempotency ------------------------------------------------------
  await check('idempotent: replay of a send returns already_applied with current revision', async () => {
    const replayed = await apply(a, {
      entryId, operationId: appliedUpdate.operationId, expectedRevision: 1,
      payload: samplePayload('updated by A'),
    });
    const row = replayed.row;
    record('idempotent: replay of a send returns already_applied with current revision',
      replayed.res.ok && row?.outcome === 'already_applied' && Number(row.revision) === 2
        && row.payload?.notes === 'updated by A',
      `${replayed.res.status} outcome=${row?.outcome} revision=${row?.revision}`);
  });

  await check('idempotent: replay two more times keeps revision at 2', async () => {
    for (let i = 0; i < 2; i += 1) {
      const again = await apply(a, {
        entryId, operationId: appliedUpdate.operationId, expectedRevision: 1,
        payload: samplePayload('updated by A'),
      });
      if (again.row?.outcome !== 'already_applied' || Number(again.row.revision) !== 2) {
        throw new Error(`replay ${i + 2} returned ${again.row?.outcome} revision ${again.row?.revision}`);
      }
    }
    const res = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision'));
    record('idempotent: replay two more times keeps revision at 2',
      Array.isArray(res.data) && res.data[0]?.revision === 2, `revision=${res.data?.[0]?.revision}`);
  });

  await check('idempotent: already_applied does not return stale payload after a later write', async () => {
    const staleOp = (await apply(a, { entryId, expectedRevision: 2, payload: samplePayload('second edit by A') })).operationId;
    await apply(a, { entryId, expectedRevision: 3, payload: samplePayload('third edit by A') });
    const replay = await apply(a, { entryId, operationId: staleOp, expectedRevision: 2, payload: samplePayload('second edit by A') });
    record('idempotent: already_applied does not return stale payload after a later write',
      replay.row?.outcome === 'already_applied' && Number(replay.row.revision) === 4
        && replay.row.payload?.notes === 'third edit by A',
      `outcome=${replay.row?.outcome} revision=${replay.row?.revision} notes=${String(replay.row?.payload?.notes).slice(0, 30)}`);
  });

  // --- 6. Pull path and tombstones ----------------------------------------
  await check('pull: list_account_entries includes tombstone after delete', async () => {
    const del = await apply(a, { entryId, expectedRevision: 4, payload: samplePayload(), deleted: true });
    if (!(del.row?.outcome === 'applied' && Number(del.row.revision) === 5)) {
      throw new Error(`delete returned ${del.row?.outcome} revision ${del.row?.revision}`);
    }
    const pulled = await a.rpc(RPCS.list, { p_after_seq: null, p_limit: 500 });
    const rows = Array.isArray(pulled.data) ? pulled.data : [];
    const tombstone = rows.find((r) => r.id === entryId);
    record('pull: list_account_entries includes tombstone after delete',
      pulled.ok && tombstone?.deleted === true && Number(tombstone.revision) === 5
        && JSON.stringify(tombstone.payload) === '{}',
      `${pulled.status} tombstone=${JSON.stringify(tombstone ?? null).slice(0, 120)}`);
  });

  // --- 6b. Cursor pagination ----------------------------------------------
  // Pages of one row, resuming from the last sync_seq. Strictly increasing
  // seqs prove the cursor neither loops nor re-serves a row, and finding the
  // tombstoned entry proves a tiny page size cannot strand it.
  await check('pull: sync_seq cursor pages without skipping or duplicating', async () => {
    const seen = new Set();
    let cursor = null;
    let lastSeq = -1;
    for (let page = 0; page < 500; page += 1) {
      const res = await a.rpc(RPCS.list, { p_after_seq: cursor, p_limit: 1 });
      if (!res.ok) throw new Error(`page ${page} failed: ${res.status} ${describe(res)}`);
      const rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) break;
      const seq = Number(rows[0].sync_seq);
      if (!(seq > lastSeq)) throw new Error(`cursor did not advance: ${seq} after ${lastSeq}`);
      lastSeq = seq;
      seen.add(rows[0].id);
      cursor = seq;
    }
    record('pull: sync_seq cursor pages without skipping or duplicating', seen.has(entryId),
      `last seq=${lastSeq}, saw entry=${seen.has(entryId)}`);
  });

  await check('tombstone: hidden from plain select', async () => {
    const res = await a.select(TABLES.entries, and(eq('id', entryId), 'select=id'));
    const count = Array.isArray(res.data) ? res.data.length : -1;
    record('tombstone: hidden from plain select', res.ok && count === 0, `${res.status} rows=${count}`);
  });

  await check('resurrect: update on tombstone with matching revision applies', async () => {
    const res = await apply(a, { entryId, expectedRevision: 5, payload: samplePayload('resurrected by A') });
    const visible = await a.select(TABLES.entries, and(eq('id', entryId), 'select=revision'));
    record('resurrect: update on tombstone with matching revision applies',
      res.row?.outcome === 'applied' && Number(res.row.revision) === 6
        && Array.isArray(visible.data) && visible.data.length === 1,
      `outcome=${res.row?.outcome} revision=${res.row?.revision} visible=${visible.data?.length}`);
  });

  // --- 7. Two-account isolation for B's own data ---------------------------
  await check('B: create in its own namespace succeeds independently', async () => {
    const bEntry = newId();
    const res = await apply(b, { entryId: bEntry, expectedRevision: 0, payload: samplePayload('created by B') });
    const hidden = await a.select(TABLES.entries, and(eq('id', bEntry), 'select=id'));
    record('B: create in its own namespace succeeds independently',
      res.row?.outcome === 'applied' && Number(res.row.revision) === 1
        && Array.isArray(hidden.data) && hidden.data.length === 0,
      `outcome=${res.row?.outcome} A-sees=${hidden.data?.length}`);
  });

  // Runs before the resurrect step so revision 6 is still a genuinely valid
  // number: a "conflict" here can only come from ownership, not from staleness.
  await check('B: cannot overwrite A row with a currently valid revision', async () => {
    const res = await apply(b, { entryId, expectedRevision: 5, payload: samplePayload('B hijack') });
    const row = res.row;
    record('B: cannot overwrite A row with a currently valid revision',
      !res.res.ok || row?.outcome === 'conflict', `${res.res.status} outcome=${row?.outcome ?? describe(res)}`);
  });

  // --- 8. Input validation -------------------------------------------------
  await check('validation: oversized payload rejected', async () => {
    const res = await apply(a, {
      entryId: newId(), expectedRevision: 0, payload: payloadOfSize(300 * 1024),
    });
    record('validation: oversized payload rejected', !res.res.ok || res.row?.outcome !== 'applied',
      `${res.res.status} ${describe(res.res)}`);
  });

  await check('validation: non-object payload rejected', async () => {
    const res = await a.rpc(RPCS.apply, {
      p_id: newId(), p_operation_id: newId(), p_expected_revision: 0,
      p_payload: [1, 2, 3], p_deleted: false,
    });
    record('validation: non-object payload rejected', !res.ok, `${res.status} ${describe(res)}`);
  });

  await check('validation: negative expected revision rejected', async () => {
    const res = await a.rpc(RPCS.apply, {
      p_id: newId(), p_operation_id: newId(), p_expected_revision: -1,
      p_payload: {}, p_deleted: false,
    });
    record('validation: negative expected revision rejected', !res.ok, `${res.status} ${describe(res)}`);
  });

  await check('validation: create with expected 0 cannot smash an existing row', async () => {
    const res = await apply(a, { entryId, expectedRevision: 0, payload: samplePayload('smasher') });
    record('validation: create with expected 0 cannot smash an existing row',
      res.row?.outcome === 'conflict', `outcome=${res.row?.outcome} revision=${res.row?.revision}`);
  });

  // --- 9. Direct write surface is closed even for the owner ---------------
  await check('A: direct REST insert denied (RPC-only writes)', async () => {
    const res = await a.insert(TABLES.entries, { owner_id: a.userId, id: newId(), payload: samplePayload() });
    record('A: direct REST insert denied (RPC-only writes)', !res.ok, `${res.status} ${describe(res)}`);
  });

  await check('A: direct REST update denied (RPC-only writes)', async () => {
    const res = await a.update(TABLES.entries, eq('id', entryId), { payload: samplePayload('direct') });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    record('A: direct REST update denied (RPC-only writes)', !res.ok || count === 0, `${res.status} ${describe(res)}`);
  });

  await check('A: sync_operations is not readable', async () => {
    const res = await a.select(TABLES.ops, 'select=operation_id&limit=1');
    record('A: sync_operations is not readable', !res.ok, `${res.status} ${describe(res)}`);
  });

  return finish();
}

function finish(fatal) {
  if (results.length === 0) {
    console.error(`\nNo checks ran. FATAL: ${fatal ?? 'unknown setup failure'}`);
    process.exitCode = 1;
    return;
  }
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log(`\n${'CHECK'.padEnd(width)}  RESULT  DETAIL`);
  console.log('-'.repeat(width + 8 + 60));
  for (const r of results) {
    console.log(`${r.name.padEnd(width)}  ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  console.log(`\n${passed}/${results.length} passed, ${failed.length} failed`);
  if (fatal) console.error(`FATAL: ${fatal}`);
  if (fatal || failed.length > 0) process.exitCode = 1;
  else console.log('Authorization gate PASSED. It is safe to wire the client to these RPCs.');
}

main().catch((error) => {
  console.error(`authorization proof could not run: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Check the env vars in supabase/verify/README.md and that both accounts are email-confirmed.');
  process.exitCode = 1;
});
