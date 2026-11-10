/**
 * Clamp a caller-supplied count to 1..max. `v.number()` accepts NaN, which would slip through
 * `Math.min`/`Math.max` unchanged, so NaN falls back to `max` (the bounded default) instead.
 */
export function boundedCount(value: number, max: number): number {
  return Number.isNaN(value) ? max : Math.min(Math.max(Math.floor(value), 1), max);
}
