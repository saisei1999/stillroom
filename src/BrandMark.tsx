/**
 * Geometric Stillpoint brand mark (brand kit v0.1).
 * Light theme uses deep navy; dark theme uses icy blue via CSS `color`.
 * `compact` uses the optically simplified geometry for 16–24px display.
 */
export function BrandMark({ size = 22, compact = false, title }: {
  size?: number;
  compact?: boolean;
  title?: string;
}) {
  return compact
    ? <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" fill="none" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} focusable="false">
        {title && <title>{title}</title>}
        <path d="M27 13 19.2 5.2Q16 2 12.8 5.2L5.2 12.8Q2 16 5.2 19.2L12.8 26.8Q16 30 19.2 26.8L27 19" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M16 12.7 17 15 19.3 16 17 17 16 19.3 15 17 12.7 16 15 15Z" fill="currentColor"/>
      </svg>
    : <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" fill="none" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} focusable="false">
        {title && <title>{title}</title>}
        <path d="M85 42 62 19Q50 7 38 19L15 42Q7 50 15 58L38 81Q50 93 62 81L85 58" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M50 39C51.5 45.5 54.5 48.5 61 50C54.5 51.5 51.5 54.5 50 61C48.5 54.5 45.5 51.5 39 50C45.5 48.5 48.5 45.5 50 39Z" fill="currentColor"/>
      </svg>;
}
