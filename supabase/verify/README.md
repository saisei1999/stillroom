# Verification scripts

Two independent checks live here:

| Script | What it proves | Needs |
| --- | --- | --- |
| `pg-local-verify.mjs` | Runs the **real migration SQL** against a real PostgreSQL engine (PGlite/WASM): preflight, `0001` applies, `0002` audit, RPC create/update/conflict/idempotency, tombstones + resurrection, skip-free `sync_seq` paging, anon denial, cross-account isolation, rollback. 28 checks. | `npm install --no-save --ignore-scripts @electric-sql/pglite`, then `node supabase/verify/pg-local-verify.mjs` from the repo root. No network, no real project. |
| `authorization.mjs` | The live two-account gate against the **hosted project** (browser-facing surface: publishable key + user JWT). | The env vars below, after the migration is applied. |

`pg-local-verify.mjs` is a strong check of the SQL itself but it is **not**
Supabase production: there is no GoTrue, no PostgREST, and the role/ACL surface
is emulated by a stub `auth` schema. Passing it does not replace the live gate.

## Live authorization proof

`authorization.mjs` is the two-account gate from `docs/account-sync.md`
(acceptance gate 1). It runs against the **real project** from a terminal with
network access and proves that the browser-facing surface — publishable key plus
a user's JWT — cannot cross accounts.

It is not part of `npm test`. `npm test` runs static checks only
(`tests/rls-fixtures.test.ts`); it cannot prove RLS.

## Requirements

- Node 18 or newer (`fetch` is global). No `npm install` needed: `lib.mjs` is
  dependency-free, so this runs even before the app's dependencies are set up.
- `0000_preflight.sql` reporting `PREFLIGHT OK`, then migration
  `supabase/migrations/0001_account_sync.sql` applied **and**
  `0002_account_sync_verify.sql` reporting `EXPECTED` everywhere.
- Two **separate, email-confirmed** accounts. If both env emails resolve to the
  same user the script aborts immediately.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `SR_SUPABASE_URL` | Project URL, e.g. `https://hmrmcpsrzrhwquyxdfta.supabase.co` |
| `SR_SUPABASE_KEY` | The **publishable** key (`sb_publishable_…` or the legacy anon JWT) |
| `SR_A_EMAIL` / `SR_A_PASSWORD` | Test account A (the "owner") |
| `SR_B_EMAIL` / `SR_B_PASSWORD` | Test account B (must be a different user) |

Set them per session; do not commit them. `SR_A_*` / `SR_B_*` are throwaway
test credentials, but a shell history with passwords is still a leak, so use
`Read-Host -AsSecureString`-style entry or a local, git-ignored file.

```powershell
$env:SR_SUPABASE_URL = 'https://hmrmcpsrzrhwquyxdfta.supabase.co'
$env:SR_SUPABASE_KEY = 'sb_publishable_FHbJZbLEkfdSI4ZDURFUjg_SjTTEbyB'
$env:SR_A_EMAIL = 'stillroom-test-a@your-team-address'
$env:SR_A_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:SR_B_EMAIL = 'stillroom-test-b@your-team-address'
$env:SR_B_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
node supabase/verify/authorization.mjs
```

The script refuses a key that looks like a secret (`sb_secret_…` is not in the
accepted prefixes). That is deliberate: with a secret key every isolation check
would pass while proving nothing.

## Expected output

A table of checks, all `PASS`, then a summary:

```
CHECK                                                          RESULT  DETAIL
------------------------------------------------------------------------------
anon: select account_entries denied                            PASS    401 permission denied
anon: direct insert denied                                     PASS    401 permission denied
...
35/35 passed, 0 failed
Authorization gate PASSED. It is safe to wire the client to these RPCs.
```

Exit code `0` only when nothing failed. Any `FAIL` sets exit code `1`, and a
setup problem (missing env var, bad password, unconfirmed email, a function that
looks missing) prints `authorization proof could not run: …` and exits `1`
without a table.

If a check fails, the `DETAIL` column carries the HTTP status and the PostgREST
or Auth message, which is usually enough to tell "migration not applied" from
"policy too broad". Do not wire the UI to the RPCs until every row is `PASS`.

## What each check group proves

| Group | Proves |
| --- | --- |
| anon | Anonymous callers get no read, no direct insert, and cannot call either RPC |
| A create | A can create (revision 1) and plain-select its own row |
| B isolation | B cannot see, update, delete or RPC-overwrite A's row — including guessing A's id with `p_expected_revision = 0` |
| conflict | A stale `p_expected_revision` returns `conflict` with the **current** server revision and payload |
| idempotent | Re-sending one `operation_id` returns `already_applied`, never bumps the revision, and never returns a stale payload if a later write advanced the row |
| pull / tombstone | The pull RPC reports a deletion; a plain select hides it; a matching-revision update resurrects it |
| cursor | Paging `list_account_entries(p_after_seq := last sync_seq, p_limit := 1)` strictly increases the cursor and still reaches the tombstoned entry, so a page boundary cannot strand a row |
| validation | Oversized (>256 KiB), non-object and negative-revision input is rejected server-side; `expected = 0` never overwrites an existing row |
| RPC-only | Even the owner cannot insert/update by direct REST, and cannot read `sync_operations` |

## Practical notes

- The script creates a few rows under A and B. It can end its own rows as
  tombstones through the RPC, but tombstones are not row-deleted from the client
  (that is the design). On throwaway test accounts this does not matter. On real
  accounts, delete the test rows from the SQL editor:
  `delete from public.account_entries where payload->>'notes' like '%authorization test%';`
- To test the "not applied yet" failure mode, run it before applying 0001: the
  anon checks still pass, then the first `A: create` fails with a missing-function
  message and the run exits `1`. That is the correct result — it is the signal
  that the app must not offer sync.
- Paused free projects make every request fail with a network/`503` error; resume
  the project in the dashboard and re-run.
