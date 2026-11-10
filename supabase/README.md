# Supabase account storage — migration instructions

> **STOP: do not apply anything from this document without the lead's go-ahead.**
> The migration was rewritten after an independent review found row-skipping
> pagination, an idempotency race and an isolation preflight that could silently
> degrade. The rewritten migration has **never been executed against a live
> PostgreSQL server** (see §6 "What is still unverified"). Apply it only after
> `0000_preflight.sql` reports `PREFLIGHT OK` and the lead approves.
>
> Nothing here is a service-role operation: the editor runs as the project owner,
> which is why it can create tables and policies that the browser (holding only
> the publishable key) can never touch.

Project: `hmrmcpsrzrhwquyxdfta` · region/paused state is visible in the dashboard.
App origin: `https://saisei1999.github.io/stillroom/`

| File | What it is | Run it? |
| --- | --- | --- |
| `migrations/0000_preflight.sql` | Read-only catalog inventory + fail-closed shape check. Prints the real columns, policies, privileges, indexes, constraints and functions. | **Yes, first** |
| `migrations/0001_account_sync.sql` | The migration. One transaction. | Only after §2 says OK |
| `migrations/0002_account_sync_verify.sql` | Read-only audit of 0001 (`begin read only`) | Immediately after 0001 |
| `migrations/0001_account_sync_rollback.sql` | Returns the project to pre-0001 state, drops no data | Only if §3 fails |
| `account-entries.sql` | Historical: the pre-0001 table the project already has | No |
| `schema-draft.sql` | Historical draft (also insecure) | **Never** |
| `sync-draft.sql` | Historical draft from the `wip/account-sync-handoff` branch; not in this tree | **Never** |
| `verify/*.mjs` | Live two-account authorization proof, run from PowerShell | After §3 |

`schema-draft.sql` and the handoff branch's `sync-draft.sql` are kept for history.
They are broken and must not be pasted: the draft's RPC returns stale payloads on
retry, its `already_applied` branch can report the wrong revision, it has no
payload validation on the write path, and it leaves an insert/update/delete grant
path open to `authenticated`. `0001_account_sync.sql` replaces all of it.

**Never drop the `revision`, `deleted` or `sync_seq` columns (or
`sync_operations`) to make an apply succeed.** Those columns can carry tombstone
and revision bookkeeping; dropping them erases it. `0001` refuses to add them if
they already exist precisely so it cannot silently reset that state. If
`0000_preflight.sql` reports them as present, stop and reconcile by hand.

---

## 1. Before you start

- Two email addresses on the project team (or your own plus an alias): the free
  built-in SMTP only delivers confirmation mail to project team addresses.
- You will create **two** accounts (A and B) in the app for the live tests.
- The browser only ever gets the publishable key
  (`sb_publishable_…`). If a step asks you for a service-role key or a
  `sb_secret_…` key, stop: nothing in this design needs one. The READMEs warn
  about these keys; they must never appear in a bundle or a command.

## 2. Preflight (run 0000 first, before 0001)

Paste **all of** `migrations/0000_preflight.sql` into the SQL editor. It changes
nothing. It prints the real catalog state in sections A–G:

- columns with types, nullability and defaults;
- every policy on `public.account_entries` (name, permissive/restrictive, roles,
  command, `qual`, `with_check`);
- privileges three ways: explicit ACL entries (including `PUBLIC`), effective
  `has_table_privilege` per login role, and column-level grants;
- every index with `indisvalid` and `indpred`;
- every constraint;
- every function in `public` with its signature, `prosecdef`, settings and ACL;
- whether any name `0001` reserves already exists.

Then a final `do` block re-checks the assumptions `0001` cannot tolerate:

1. `public.account_entries` exists, is a table, has RLS enabled.
2. `owner_id uuid not null`, `id uuid not null`, `payload jsonb not null`,
   `updated_at timestamptz not null` are present. Extra columns are fine.
3. The sync columns `revision`/`deleted`/`sync_seq` do **not** already exist.
4. There is a valid, non-partial unique key on exactly `(owner_id, id)`, or no
   duplicate `(owner_id, id)` groups so `0001` can add one. A partial or invalid
   candidate is a hard stop — `on conflict (owner_id, id)` cannot use it.
5. `public.sync_operations` and sequence `public.account_entries_sync_seq` do
   not already exist, and neither does the reserved index name.
6. `apply_entry_change` / `list_account_entries` do not exist under any
   signature.
7. No unexplained role holds an explicit grant on the table. Superuser and
   `BYPASSRLS` roles are reported and tolerated (server-side keys, never the
   browser); any other grantee is a stop.

If every assumption holds you get `NOTICE: PREFLIGHT OK`. If not, the script
**raises** with the full list of problems: that error is the stop signal. Do not
edit `0001` to "make it fit" a different table — reconcile the table by hand, or
stop and report it.

Historical reference queries (P1–P4 from the earlier revision) are no longer
needed; `0000_preflight.sql` covers them and more. The old expectation — a
`PRIMARY KEY (owner_id, id)`, `owner_id uuid not null`, `id uuid not null`,
`payload jsonb not null`, `updated_at timestamptz not null default now()` — is
still exactly what the preflight enforces.

## 3. Apply order

1. Run `migrations/0000_preflight.sql` and confirm `PREFLIGHT OK` (§2).
2. Paste **all of** `migrations/0001_account_sync.sql` into the SQL editor and run
   it once. It is a single `begin; … commit;`, so any failed assumption rolls back
   every step. Expect `Success. No rows returned`.
3. Paste **all of** `migrations/0002_account_sync_verify.sql` and run it. It is
   read-only. You should see several result tabs; every `verdict` must start with
   `EXPECTED`. The `E. anon probe` tab is expected to **error** with
   `permission denied for table account_entries` — that error is the pass.
4. Enable **Confirm email** (Authentication → Providers → Email) and set
   **Redirect URLs** to allow `https://saisei1999.github.io/stillroom/` (and
   `http://127.0.0.1:5173/` only while developing).
5. Create test accounts A and B, then run the live proof in §4.

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

The proof calls the pull RPC as
`list_account_entries(p_after_seq := <last sync_seq>, p_limit := n)`. It pages in
single-row steps and asserts the cursor strictly increases and still reaches the
tombstoned entry, so a skip bug fails the gate.

## 5. What 0001 changes, in one paragraph

`account_entries` gains `revision`, `deleted` and the monotonic cursor `sync_seq`,
five named checks, the `(owner_id, id)` uniqueness guarantee and a unique
`(owner_id, sync_seq)` index. The browser loses every write privilege and every
pre-existing policy on the table is dropped (not just the known draft names);
`authenticated` keeps only `SELECT` of its own **live** rows, so tombstones are
invisible to plain selects. A new `sync_operations` log binds every push to the
full request — entry id, expected revision, sha256 of the payload and the deleted
flag — so reusing an `operation_id` with different content is a controlled error
rather than a unique-violation crash. Two `security definer` functions with
`search_path = ''` are the only write and tombstone-read paths:
`apply_entry_change` (per-owner advisory lock, revision-checked, idempotent push)
and `list_account_entries` (`sync_seq` cursor pull). Both are executable by
`authenticated` only and check `auth.uid()` themselves.

## 6. What is still unverified

- `0000_preflight.sql`, `0001` and `0002` have **not** been run against any
  PostgreSQL server. Only a live preflight + apply + audit can prove they parse
  and behave; CI has no database.
- The sequence/commit-order argument behind the cursor still needs a live
  concurrency test (two writers for one owner, a pull started between them).
- Supabase's exact default ACLs (`service_role` and friends) are handled by
  tolerating superuser/`BYPASSRLS` grantees, but the real catalog has not been
  inspected.

## 7. Rolling back

If §3 step 3 reports anything `UNEXPECTED`, paste **all of**
`migrations/0001_account_sync_rollback.sql`. It drops the two RPCs, the
`sync_operations` log, the `sync_seq` sequence and its index, removes `0001`'s
constraints and restores the original `account_select_own` policy. It removes no
table, row or column: **no user entry is deleted**. The table stays read-only for
the client, which is the safe state. Do not edit `0001` and re-apply on top of a
half-applied state; roll back first. Note that `0001` will refuse to re-apply
until the `revision`/`deleted`/`sync_seq` columns are reconciled by hand, because
re-adding them would reset tombstone state.

## 8. Security notes

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
- **Per-owner serialisation.** Every `apply_entry_change` takes a per-account
  advisory lock held to commit. That is what makes idempotency and the cursor
  deterministic; it also means one account's writes serialise. Keep an eye on
  lock wait time if a future client batches writes.
- **`sync_operations` grows per accepted write.** There is no purge yet. Before
  general availability add a scheduled purge (e.g. operations older than the
  longest realistic retry window) or the table becomes the largest in the project.
