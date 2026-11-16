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

export function RegionSettings() {
 const [country,setCountry]=useState(()=>{try{return localStorage.getItem('stillroom-availability-region')??'US'}catch{return 'US'}});
 const [error,setError]=useState(false);
 return <section className="appearance-card"><div className="appearance-heading"><div><h2>Availability region</h2><p>Use a two-letter country code for streaming availability. Saved on this device.</p></div></div><label>Country code <input maxLength={2} value={country} onChange={event=>{const value=event.target.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,2);setCountry(value);if(value.length===2)try{localStorage.setItem('stillroom-availability-region',value);window.dispatchEvent(new Event('stillroom-region-change'));setError(false)}catch{setError(true)}}}/></label>{error&&<p role="alert">Couldn’t save this preference.</p>}</section>;
}

export function ProviderCredits() {
 return <section className="appearance-card"><h2>Credits</h2><a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer"><img width="90" alt="TMDB" referrerPolicy="no-referrer" src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"/></a><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>Streaming availability data is provided by JustWatch. Additional streaming links are provided by <a href="https://www.watchmode.com/" target="_blank" rel="noopener noreferrer">Watchmode</a>. Game information is provided by <a href="https://www.igdb.com/" target="_blank" rel="noopener noreferrer">IGDB</a>.</p></section>;
}
