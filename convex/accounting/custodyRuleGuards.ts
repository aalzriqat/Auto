import { SYSTEM_KEYS, type SystemKey } from "../utils/defaultChart";

export function assertCustodyAmount(p: { amountMinor: number }, what: string): void {
  // The writers validate before posting; the outbox replays what was stored.
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
    throw new Error(`${what} carries an amount that is not a positive integer (${p.amountMinor}) — refusing to post.`);
  }
}

export function assertCustodyBankIdentity(p: { bankAccountId?: string }, cashKey: SystemKey): void {
  if (cashKey === SYSTEM_KEYS.BANK_ACCOUNT && !p.bankAccountId) {
    throw new Error("Custody bank posting has no physical bank identity; refusing the journal.");
  }
  if (cashKey !== SYSTEM_KEYS.BANK_ACCOUNT && p.bankAccountId) {
    throw new Error("Custody cash posting unexpectedly names a physical bank; refusing the journal.");
  }
}
