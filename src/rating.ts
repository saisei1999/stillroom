/** Accept 1.0–5.0 in exact tenths while tolerating binary floating point noise. */
export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}
