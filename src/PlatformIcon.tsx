import { siApple, siCrunchyroll, siEpicgames, siGogdotcom, siHbomax, siNetflix, siParamountplus, siPlaystation, siSteam, siTubi } from 'simple-icons';

const brands = [
  [/steam/i,siSteam], [/\bgog\b/i,siGogdotcom], [/epic/i,siEpicgames], [/playstation/i,siPlaystation],
  [/netflix/i,siNetflix], [/\btubi\b/i,siTubi], [/crunchyroll/i,siCrunchyroll], [/hbo max/i,siHbomax], [/paramount/i,siParamountplus], [/apple/i,siApple],
];
export function PlatformIcon({name,logo}:{name:string;logo?:string}) {
  const brand = brands.find(([pattern]) => (pattern as RegExp).test(name))?.[1] as typeof siSteam | undefined;
  if (brand) return <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d={brand.path}/></svg>;
  const wordmark = /^(amazon|prime video|amazon prime video)$/i.test(name) ? 'prime' : /^(hulu|peacock|disney\+)$/i.test(name) ? name.toLowerCase() : '';
  if (wordmark) return <svg aria-hidden="true" viewBox="0 0 40 24" fill="currentColor"><text x="20" y="17" textAnchor="middle" textLength="36" lengthAdjust="spacingAndGlyphs" fontSize="16" fontWeight="700" fontFamily="sans-serif">{wordmark}</text></svg>;
  return logo && /^https:\/\/image\.tmdb\.org\//.test(logo) ? <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer"/> : <span aria-hidden="true">{name.slice(0,1).toUpperCase()}</span>;
}
