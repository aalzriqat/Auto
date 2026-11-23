/**
 * Reads the REAL exported argument validator and reports whether
 * `idempotencyKey` is optional. Anything it cannot establish — module missing,
 * export missing, no `exportArgs`, no such field — throws rather than
 * returning a value, so an enumeration that has gone blind can never be
 * mistaken for a satisfied assertion.
 */
export function argIsOptional(mod: Record<string, unknown>, exportName: string): boolean {
  const fn = mod[exportName] as { exportArgs?: () => string } | undefined;
  if (!fn) throw new Error(`No export named ${exportName} — classification cannot be checked.`);
  if (typeof fn.exportArgs !== "function") {
    throw new Error(`${exportName} exposes no exportArgs() — classification cannot be checked.`);
  }
  const field = JSON.parse(fn.exportArgs()).value?.idempotencyKey;
  if (!field) throw new Error(`${exportName} declares no idempotencyKey argument at all.`);
  if (typeof field.optional !== "boolean") {
    throw new Error(`${exportName}.idempotencyKey has no optionality flag to read.`);
  }
  return field.optional;
}
