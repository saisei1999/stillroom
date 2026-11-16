import { siApple, siCrunchyroll, siEpicgames, siGogdotcom, siNetflix, siParamountplus, siPlaystation, siSteam } from 'simple-icons';

const brands = [
  [/steam/i,siSteam], [/\bgog\b/i,siGogdotcom], [/epic/i,siEpicgames], [/playstation/i,siPlaystation],
  [/netflix/i,siNetflix], [/crunchyroll/i,siCrunchyroll], [/paramount/i,siParamountplus], [/apple/i,siApple],
];
export function PlatformIcon({name,logo}:{name:string;logo?:string}) {
  const brand = brands.find(([pattern]) => (pattern as RegExp).test(name))?.[1] as typeof siSteam | undefined;
  if (brand) return <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d={brand.path}/></svg>;
  return logo && /^https:\/\/image\.tmdb\.org\//.test(logo) ? <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer"/> : <span aria-hidden="true">{name.slice(0,1).toUpperCase()}</span>;
}
