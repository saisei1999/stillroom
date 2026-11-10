import React, { useEffect, useState } from 'react';
import { createAccountClient } from './account-client';
import type { Session } from '@supabase/supabase-js';
import {
  SYNC_ENABLED,
  readSessionState,
  runSync,
  conflictPreview,
  resolveConflictKeepMine,
  resolveConflictUseTheirs,
  resolveConflictKeepBoth,
  listConflicts,
  listPending,
  stageLocalImport,
  clearAccountCache,
  summarizeSync,
  isWaiting,
  setActiveAccount,
  type ImportChoice,
} from './sync-control';
import { listEntries, listAccountEntries, type Entry } from './storage';
import { friendlySyncError, planImport } from './sync-core';
const client = createAccountClient('https://hmrmcpsrzrhwquyxdfta.supabase.co', 'sb_publishable_FHbJZbLEkfdSI4ZDURFUjg_SjTTEbyB');

export function AccountPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflicts, setConflicts] = useState<Awaited<ReturnType<typeof listConflicts>>>([]);
  const [report, setReport] = useState<{ summary: string; error: string | null; waiting: boolean }>({ summary: '…', error: null, waiting: false });
  const [importChoice, setImportChoice] = useState<ImportChoice>(null);
  const [planning, setPlanning] = useState<{ uploads: number; conflicts: number; alreadySynced: number } | null>(null);

  const accountId = session ? String(session.user.id) : null;

  useEffect(() => {
    let active = true;
    client.auth.getSession().then(({ data, error }) => {
      if (active) {
        setSession(data.session);
        setActiveAccount(data.session ? String(data.session.user.id) : null);
        setLoading(false);
        if (error) setError('Could not check your session. Please try again.');
      }
    });
    const { data: sub } = client.auth.onAuthStateChange((event, next) => {
      if (active) {
        setSession(next);
        setActiveAccount(next ? String(next.user.id) : null);
        setLoading(false);
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Keep the sync status in view while signed in (only when sync is enabled).
  useEffect(() => {
    let active = true;
    if (!accountId || !SYNC_ENABLED) {
      setPendingCount(0);
      setConflicts([]);
      setReport({ summary: 'Your library stays on this device.', error: null, waiting: false });
      return;
    }
    (async () => {
      const pending = await listPending(accountId);
      const conf = await listConflicts(accountId);
      if (!active) return;
      setPendingCount(pending.length);
      setConflicts(conf);
      const summary = summarizeSync({ pushed: 0, pulled: 0, conflictsDetected: conf.length, waiting: pending.length, retries: 0, lastError: null, errorKind: null, paused: pending.length > 0 }, pending, conf);
      setReport({ summary, error: null, waiting: pending.length > 0 });
    })();
    return () => {
      active = false;
    };
  }, [accountId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'reset') {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: 'https://saisei1999.github.io/stillroom/' });
        if (error) throw error;
        setMessage('If an account exists for this email, check your inbox for a recovery link.');
      } else if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: 'https://saisei1999.github.io/stillroom/' } });
        if (error) throw error;
        setPassword('');
        setMessage(data.session ? 'Account created.' : 'Check your email for a confirmation link before signing in.');
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setPassword('');
      }
    } catch {
      setError(mode === 'signin' ? 'Could not sign in. Check your details and email confirmation, then try again.' : 'The request could not be completed. Check your details and try again later.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    const { error } = await client.auth.signOut();
    if (error) setError('Could not sign out. Please try again.');
    setBusy(false);
  }

  async function syncNow() {
    if (!accountId) return;
    setBusy(true);
    setError('');
    try {
      const newReport = await runSync(accountId);
      const pending = await listPending(accountId);
      const conf = await listConflicts(accountId);
      const summary = summarizeSync(newReport, pending, conf);
      setReport({ summary, error: newReport.lastError ? friendlySyncError({ code: newReport.errorKind ?? undefined, message: newReport.lastError }) : null, waiting: isWaiting(newReport) });
      setPendingCount(pending.length);
      setConflicts(conf);
    } catch (failure) {
      // A session that changed mid-sync aborts the pass deliberately; surface it
      // honestly instead of leaving an unhandled rejection and a stuck "busy".
      setReport({ summary: 'Sync stopped before it finished. Nothing was removed from this device.', error: friendlySyncError(failure), waiting: true });
      try {
        const pending = await listPending(accountId);
        setPendingCount(pending.length);
        setConflicts(await listConflicts(accountId));
      } catch {
        /* status refresh is best-effort */
      }
    } finally {
      setBusy(false);
    }
  }

  async function planImportChoice() {
    if (!accountId) return;
    setBusy(true);
    setError('');
    try {
      const local = await listEntries();
      const cached = await listAccountEntries(accountId);
      const serverView = cached.map((r): { id: string; revision: number; entry: Entry | null } => ({ id: r.entryId, revision: r.revision, entry: r.entry }));
      const plan = planImport(local, serverView);
      setPlanning({ uploads: plan.uploads.length, conflicts: plan.conflicts.length, alreadySynced: plan.alreadySynced });
    } catch (e) {
      setError('Could not prepare the import. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!accountId) return;
    setBusy(true);
    setError('');
    try {
      const result = await stageLocalImport(accountId);
      setImportChoice({ staged: result.staged, skipped: result.skipped });
      setPlanning(null);
      setMessage(`Staged ${result.staged} ${result.staged === 1 ? 'entry' : 'entries'} to sync to your account. Nothing was removed from this device.`);
    } catch {
      setError('Could not stage the import. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeCache() {
    if (!accountId) return;
    if (!confirm('Remove this account\u2019s synced data from this device? Pending changes that have not reached the account yet could be lost. Continue?')) return;
    setBusy(true);
    setError('');
    try {
      await clearAccountCache(accountId);
      setPendingCount(0);
      setConflicts([]);
      setReport({ summary: 'Account data removed from this device. Your local library is untouched.', error: null, waiting: false });
    } catch {
      setError('Could not remove the cached account data.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="account-panel"><p>Checking account…</p></section>;
  if (recovery)
    return (
      <section className="account-panel">
        <h2>Choose a new password</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            const { error } = await client.auth.updateUser({ password });
            if (error) setError('Could not update your password. Try again.');
            else {
              setRecovery(false);
              setPassword('');
              setMessage('Password updated.');
            }
            setBusy(false);
          }}
        >
          <label>
            New password
            <input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="account-error">
              {error}
            </p>
          )}
          <button className="account-primary" disabled={busy}>
            Update password
          </button>
        </form>
      </section>
    );

  if (session)
    return (
      <section className="account-panel">
        <h2>Account</h2>
        <p>
          Signed in as <strong>{session.user.email}</strong>
        </p>
        {SYNC_ENABLED ? (
          <div className="account-sync">
            <p className="account-disclosure" role="status">
              {report.summary}
            </p>
            {report.error && (
              <p role="alert" className="account-error">
                {report.error}
              </p>
            )}
            {!importChoice && planning === null && (
              <button type="button" className="account-secondary" disabled={busy} onClick={planImportChoice}>
                Plan a library import
              </button>
            )}
            {planning !== null && (
              <div className="import-plan">
                <p>
                  Your account can hold {planning.uploads} new entry ({planning.conflicts} conflicting, {planning.alreadySynced} already present)
                </p>
                <button type="button" className="account-primary" disabled={busy} onClick={doImport}>
                  Import my local library
                </button>
              </div>
            )}
            {importChoice && <p className="account-message">Staged {importChoice.staged} entries.</p>}
            {/* Enabled whenever we are not already syncing: the whole point of
                this button is to push pending work, so disabling it while work
                is pending (or while a change has paused after its automatic
                attempts) would make that work impossible to send. */}
            <button type="button" className="account-secondary" disabled={busy} onClick={syncNow}>
              Sync now
            </button>
            {conflicts.length > 0 && (
              <ul className="conflict-list">
                {conflicts.map((conf) => {
                  const view = conflictPreview(conf);
                  return (
                    <li key={conf.entryId} className="conflict-item">
                      <strong>{view.localPreview}</strong>
                      <span>{view.serverPreview}</span>
                      <div className="conflict-actions">
                        <button type="button" onClick={async () => { await resolveConflictKeepMine(session.user.id, conf); await syncNow(); }}>Keep mine</button>
                        <button type="button" onClick={async () => { await resolveConflictUseTheirs(session.user.id, conf); await syncNow(); }}>Use theirs</button>
                        {view.kind === 'diverged' && (
                          <button type="button" onClick={async () => { await resolveConflictKeepBoth(session.user.id, conf); await syncNow(); }}>Keep both</button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="account-danger" disabled={busy} onClick={removeCache}>
              Remove account data from this device
            </button>
          </div>
        ) : (
          <p className="account-disclosure">Library sync is not enabled yet; entries remain in this browser.</p>
        )}
        <button type="button" className="account-secondary" disabled={busy} onClick={signOut}>
          Sign out
        </button>
        {error && (
          <p role="alert" className="account-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="account-message">
            {message}
          </p>
        )}
      </section>
    );

  return (
    <section className="account-panel">
      <h2>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create an account' : 'Reset password'}</h2>
      <p>Use your email to access your Stillroom account.</p>
      <p>For this early setup, confirmation emails can only be sent to an email address belonging to the Supabase project team.</p>
      <p className="account-disclosure">Account sign-in is ready. Library syncing is coming next; signing in will not move or sync your existing entries.</p>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {error && (
          <p role="alert" className="account-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="account-message">
            {message}
          </p>
        )}
        <button className="account-primary" disabled={busy} type="submit">
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send recovery link'}
        </button>
      </form>
      <div className="account-links">
        {mode !== 'signin' && (
          <button onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>
            Sign in
          </button>
        )}
        {mode !== 'signup' && (
          <button onClick={() => { setMode('signup'); setError(''); setMessage(''); }}>
            Create account
          </button>
        )}
      </div>
    </section>
  );
}