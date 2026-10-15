/**
 * Two small helpers shared by the ACC-1 and ACC-3 MONEY_BOUNDARY missions: a run-unique synthetic VIN and the
 * chart-of-accounts key map. Each mission keeps its own seed path: the financed-deal setups differ in what they
 * create and in which seat acts, so they are not one function. The CONS-1 mission carries identical copies that
 * could adopt these later; that is optional and separate.
 */
import { createHash } from "node:crypto";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 17 uppercase characters, unique to the run, free of the letters a VIN forbids. `prefix` is five such characters naming the mission. */
export function syntheticVin(prefix: string, nonce: string): string {
  return prefix + createHash("sha256").update(nonce).digest("hex").slice(0, 12).toUpperCase();
}

/** Chart account id to its system key (the account code when it has none), from `chartOfAccounts.list`. */
export function chartKeysById(chart: readonly unknown[]): Map<string, string> {
  const keyOf = new Map<string, string>();
  for (const account of chart) {
    if (!isRecord(account) || typeof account._id !== "string") continue;
    const key = typeof account.systemKey === "string" ? account.systemKey : typeof account.code === "string" ? account.code : null;
    if (key !== null) keyOf.set(account._id, key);
  }
  return keyOf;
}
