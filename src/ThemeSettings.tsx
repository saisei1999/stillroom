import { useEffect, useState } from 'react';
const THEME_KEY='stillroom-theme';
type Theme='light'|'dark';
function initialTheme():Theme{return document.documentElement.dataset.theme==='dark'?'dark':'light'}
export function ThemeSettings(){
 const [theme,setTheme]=useState<Theme>(initialTheme),[error,setError]=useState(false);
 useEffect(()=>{const onStorage=(event:StorageEvent)=>{if(event.key!==THEME_KEY)return;const next=event.newValue==='dark'?'dark':'light';document.documentElement.dataset.theme=next;setTheme(next)};window.addEventListener('storage',onStorage);return()=>window.removeEventListener('storage',onStorage)},[]);
 const toggle=()=>{const next:Theme=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;setTheme(next);try{localStorage.setItem(THEME_KEY,next);setError(false)}catch{setError(true)}};
 return <section className="appearance-card" aria-labelledby="appearance-title"><div className="appearance-heading"><div className="appearance-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 13A8.5 8.5 0 0 1 11 3.2a8.5 8.5 0 1 0 9.8 9.8Z"/><path d="M17 3v3M15.5 4.5h3"/></svg></div><div><h2 id="appearance-title">Appearance</h2><p>Choose the look of your space.</p></div></div><div className="appearance-row"><div><strong>Dark mode</strong><span>{theme==='dark'?'On':'Off'} · Saved on this device</span></div><button type="button" className="theme-switch" role="switch" aria-label="Dark mode" aria-checked={theme==='dark'} onClick={toggle}><span/></button></div>{error&&<p className="theme-error" role="alert">Couldn’t save this preference on this device.</p>}</section>;
}

