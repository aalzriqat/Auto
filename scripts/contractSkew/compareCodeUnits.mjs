/**
 * Locale-independent ordering by UTF-16 code unit.
 *
 * This is exactly what `Array.prototype.sort()` does with no comparator, stated
 * explicitly: operands are compared as `String(x)`, code unit by code unit. It is
 * NOT `localeCompare`, whose result depends on the host's ICU data and locale —
 * the baseline fingerprint and the census output must be byte-identical on every
 * machine.
 *
 * (Default `sort()` additionally puts `undefined` last without calling the
 * comparator; callers here only sort strings, so that does not arise.)
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function compareCodeUnits(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
