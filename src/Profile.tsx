import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { accountClient } from './AccountPanel';
import type { Entry } from './storage';

const profileKey = 'stillroom-profile-name';
function readName(): string { try { return (localStorage.getItem(profileKey) ?? '').slice(0, 40); } catch { return ''; } }

export function useProfile() {
  const [name, setName] = useState(readName);
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    let active = true, receivedEvent = false;
    const { data: { subscription } } = accountClient.auth.onAuthStateChange((_event, session) => { receivedEvent = true; if (active) setUser(session?.user ?? null); });
    void accountClient.auth.getSession().then(({data}) => { if (active && !receivedEvent) setUser(data.session?.user ?? null); }).catch(() => {});
    const sync = (event: StorageEvent) => { if (event.key === profileKey) setName(readName()); };
    window.addEventListener('storage', sync);
    return () => { active = false; subscription.unsubscribe(); window.removeEventListener('storage', sync); };
  }, []);
  const accountName = typeof user?.user_metadata?.username === 'string' ? user.user_metadata.username.trim().slice(0, 40) : '';
  const displayName = name || accountName || user?.email?.split('@')[0] || 'Your profile';
  const save = (value: string) => {
    const next = value.trim().slice(0, 40);
    try { if (next) localStorage.setItem(profileKey, next); else localStorage.removeItem(profileKey); setName(next); return true; } catch { return false; }
  };
  return {displayName, customName:name, user, save};
}

export function Profile({profile, entries, onSettings}:{profile:ReturnType<typeof useProfile>; entries:Entry[]; onSettings:()=>void}) {
  const [draft, setDraft] = useState(profile.customName);
  const [message, setMessage] = useState('');
  useEffect(() => setDraft(profile.customName), [profile.customName]);
  const completed = entries.filter(entry => entry.status === 'Completed').length;
  const types = new Set(entries.map(entry => entry.type)).size;
  return <div className="profile-page">
    <div className="profile-intro"><div className="profile-portrait" aria-hidden="true">{profile.displayName.slice(0, 1).toLocaleUpperCase()}</div><div><span className="profile-eyebrow">YOUR SPACE</span><h2>{profile.displayName}</h2><p>{profile.user ? 'Signed in · Library on this device' : 'Local profile · Library on this device'}</p></div></div>
    <div className="profile-stats" aria-label="Library overview"><div><strong>{entries.length}</strong><span>Entries</span></div><div><strong>{completed}</strong><span>Completed</span></div><div><strong>{types}</strong><span>Media types</span></div></div>
    <form className="profile-edit" onSubmit={event => {event.preventDefault(); setMessage(profile.save(draft) ? 'Profile name saved.' : 'Could not save your name on this device.');}}>
      <h2>Profile name</h2><p>Choose the name shown in your menu. It is saved on this device.</p><label htmlFor="profile-display-name">Name</label><div className="profile-edit-row"><input id="profile-display-name" value={draft} onChange={event=>{setDraft(event.target.value);setMessage('')}} maxLength={40} placeholder={profile.user?.email?.split('@')[0] || 'Your name'}/><button type="submit">Save name</button></div><small>Leave blank to use your account name.</small>{message && <p role="status">{message}</p>}
    </form>
    <div className="profile-account"><div><h2>Account</h2><p>{profile.user?.email ? `Signed in as ${profile.user.email}` : 'Sign in to see platform links.'}</p></div><button type="button" onClick={onSettings}>Account settings <span aria-hidden="true">↗</span></button></div>
  </div>;
}
