# Supabase account storage — apply, verify, roll back

Everything in this folder is **applied by hand in the Supabase SQL editor**. No
step writes `src/`, and nothing here is a service-role operation: the editor runs
as the project owner, which is why it can create tables and policies that the
browser (holding only the publishable key) can never touch.

Project: `hmrmcpsrzrhwquyxdfta` · region/paused state is visible in the dashboard.
App origin: `https://saisei1999.github.io/stillroom/`

| File | What it is | Run it? |
| --- | --- | --- |
| `migrations/0001_account_sync.sql` | The migration. One transaction. | Yes, after §2 passes |
| `migrations/0002_account_sync_verify.sql` | Read-only audit of 0001 (`begin read only`) | Yes, immediately after |
| `migrations/0001_account_sync_rollback.sql` | Returns the project to pre-0001 state, drops no data | Only if §4 fails |
| `account-entries.sql` | Historical: the pre-0001 table the project already has | No |
| `schema-draft.sql` | Historical draft (also insecure) | **Never** |
| `sync-draft.sql` | Historical draft from the `wip/account-sync-handoff` branch; not in this tree | **Never** |
| `verify/*.mjs` | Live two-account authorization proof, run from PowerShell | After §3 |

`schema-draft.sql` and the handoff branch's `sync-draft.sql` are kept for history.
They are broken and must not be pasted: the draft's RPC returns stale payloads on
retry, its `already_applied` branch can report the wrong revision, it has no
payload validation on the write path, and it leaves an insert/update/delete grant
path open to `authenticated`. `0001_account_sync.sql` replaces all of it.

---

## 1. Before you start

- Two email addresses on the project team (or your own plus an alias): the free
  built-in SMTP only delivers confirmation mail to project team addresses.
- You will create **two** accounts (A and B) in the app for the live tests.
- The browser only ever gets the publishable key
  (`sb_publishable_…`). If a step asks you for a service-role key or a
  `sb_secret_…` key, stop: nothing in this design needs one.

## 2. Precondition queries (run these first, before 0001)

The project already has `public.account_entries`, but this repo never recorded
its exact definition, so confirm it instead of assuming it. Paste this into the
SQL editor:

```sql
-- P1: the table exists, RLS is on, and which PRIMARY/UNIQUE keys it has.
select c.relname,
       c.relrowsecurity as rls_enabled,
       con.conname,
       con.contype,          -- 'p' = primary key, 'u' = unique
       pg_get_constraintdef(con.oid) as definition
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_constraint con
         on con.conrelid = c.oid and con.contype in ('p', 'u')
 where n.nspname = 'public'
   and c.relname = 'account_entries';
```

**Expected:** `rls_enabled = true`, and among the rows one with `contype = 'p'`
whose definition is `PRIMARY KEY (owner_id, id)`. A unique key on
`(owner_id, id)` is also fine (0001 keeps it as-is). Anything else — a text `id`,
a different owner column, no key — means this migration is not for that table:
**stop and report it**, do not edit 0001 to "make it fit".

```sql
-- P2: the columns 0001 relies on.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'account_entries'
 order by ordinal_position;
```

**Expected among the output:** `owner_id uuid not null`, `id uuid not null`,
`payload jsonb not null`, `updated_at timestamptz not null default now()`.
Extra columns are tolerated. Missing/other types are not — stop.

```sql
-- P3: a boolean "owner_id is auth.uid()" check is what the earlier UI relied on.
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.account_entries'::regclass and contype = 'c';

-- P4: who can do what today (informational; 0001 revokes most of this).
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'account_entries'
 order by grantee, privilege_type;
```

If **all** of P1–P3 match, continue. If `payload` is missing entirely, 0001 will
fail at its first `check` constraint, which is the intended fail-closed behaviour.

## 3. Apply order

1. Paste **all of** `migrations/0001_account_sync.sql` into the SQL editor and run
   it once. It is a single `begin; … commit;`, so any failed assumption rolls back
   every step. Expect `Success. No rows returned`.
2. Paste **all of** `migrations/0002_account_sync_verify.sql` and run it. It is
   read-only. You should see several result tabs; every `verdict` must start with
   `EXPECTED`. The `E. anon probe` tab is expected to **error** with
   `permission denied for table account_entries` — that error is the pass.
3. Enable **Confirm email** (Authentication → Providers → Email) and set
   **Redirect URLs** to allow `https://saisei1999.github.io/stillroom/` (and
   `http://127.0.0.1:5173/` only while developing).
4. Create test accounts A and B, then run the live proof in §4.

## 4. Live two-account authorization proof

See `verify/README.md` for env vars. In short, from the repo root:

```powershell
$env:SR_SUPABASE_URL='https://hmrmcpsrzrhwquyxdfta.supabase.co'
$env:SR_SUPABASE_KEY='sb_publishable_FHbJZbLEkfdSI4ZDURFUjg_SjTTEbyB'
$env:SR_A_EMAIL='a@example.com'; $env:SR_A_PASSWORD='...'
$env:SR_B_EMAIL='b@example.com'; $env:SR_B_PASSWORD='...'
node supabase/verify/authorization.mjs
```

Exit code `0` and every row `PASS` is the gate. Exit code `1` prints which check
failed; fix or roll back before the UI is allowed to upload anything.

## 5. What 0001 changes, in one paragraph

`account_entries` gains `revision` and `deleted`, three named checks, the
`(owner_id, id)` uniqueness guarantee and a `(owner_id, updated_at, id)` index.
The browser loses every write privilege; `authenticated` keeps only `SELECT` of
its own **live** rows, so tombstones are invisible to plain selects. A new
`sync_operations` log makes every pushed change idempotent by `operation_id`.
Two `security definer` functions with `search_path = ''` are the only write and
tombstone-read paths: `apply_entry_change` (revision-checked push) and
`list_account_entries` (cursor pull). Both are executable by `authenticated` only
and check `auth.uid()` themselves.

## 6. Rolling back

If §3 step 2 reports anything `UNEXPECTED`, paste **all of**
`migrations/0001_account_sync_rollback.sql`. It drops the two RPCs and the
`sync_operations` log, removes 0001's constraints/index and restores the original
`account_select_own` policy. It removes no table, row or column: **no user entry
is deleted**. The table stays read-only for the client, which is the safe state.
Do not edit 0001 and re-apply on top of a half-applied state; roll back first.

## 7. Security notes

- **Never a service-role key.** Neither the app nor any script here needs
  `service_role` or `sb_secret_…`. Those keys bypass RLS by design. The publishable
  key is public and safe only because RLS and the RPCs do the authorizing.
- **Email confirmation.** Keep "Confirm email" on. Otherwise anyone can mint an
  account for an address they do not control and a later password reset hands
  them data. Confirmation also makes B a genuinely separate identity for testing.
- **Redirect allowlist.** Add exactly `https://saisei1999.github.io/stillroom/` to
  Authentication → URL Configuration → Redirect URLs. A wildcard allows magic-link
  and reset tokens to be leaked to another origin.
- **Free SMTP limits.** The built-in mailer only delivers to project team
  addresses and is heavily rate-limited (a small hourly daily cap). General
  sign-ups will silently fail until custom SMTP is configured. Do not tell users
  they can register before that.
- **Project pausing.** Free projects pause after a period of inactivity; paused
  projects fail every request. The app must keep everything local-first and show
  pending changes, never a "synced" state, while the project is paused.
- **Payload and operation limits.** The server rejects payloads over 256 KiB and
  limits pulls to 500 rows, so a malicious client cannot use the RPCs as a bulk
  storage service. Nothing limits the *number* of rows an account may create;
  add a per-owner row cap before allowing untrusted registrations.
- **`sync_operations` grows per accepted write.** There is no purge yet. Before
  general availability add a scheduled purge (e.g. operations older than the
  longest realistic retry window) or the table becomes the largest in the project.
