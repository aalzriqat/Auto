/**
 * SCRUM-57 — the MOBILE half of the command-identity contract.
 *
 * The ticket requires that web, mobile and internal call sites all preserve one
 * command identity across network retries. Mobile previously called
 * `idempotencyKey(...)` inline in every mutation argument list, minting a fresh
 * value per invocation — so a lost response re-sent by the operator was a second
 * command and the server had no way to collapse it. These tests pin the
 * lifecycle that fixes it, mirroring `hooks/useCommandIdentity.test.tsx`.
 *
 * `createCommandIdentity` is the lifecycle with no React in it; the hook is a
 * `useRef` + `useMemo` wrapper around exactly this object, so the behaviour
 * asserted here is the behaviour the call sites get.
 */
import {
  createCommandIdentity,
  idempotencyKey,
} from "./moduleShared";

describe("mobile command identity", () => {
  it("holds ONE identity for an intent across retries", () => {
    const identity = createCommandIdentity();
    const first = identity.for("expenses.create");
    expect(identity.for("expenses.create")).toBe(first);
  });

  it("keeps the identity after a FAILED attempt, so the retry is one command", () => {
    const identity = createCommandIdentity();
    const attempt1 = identity.for("transactions.add");
    // Nothing retired: this is the failure path the callers take.
    expect(identity.for("transactions.add")).toBe(attempt1);
  });

  it("survives a rerender, because the map is owned by the caller's ref", () => {
    // The hook passes `keys.current` in, so re-invoking the factory the way a
    // rerender would must not lose the held identity.
    const keys = new Map<string, string>();
    const first = createCommandIdentity(keys).for("expenses.create");
    expect(createCommandIdentity(keys).for("expenses.create")).toBe(first);
  });

  it("retires on success so the next intent is a NEW command", () => {
    const identity = createCommandIdentity();
    const first = identity.for("transactions.add");
    identity.retire("transactions.add");
    expect(identity.for("transactions.add")).not.toBe(first);
  });

  it("renew mints a new identity even when the previous was never retired", () => {
    // The deposits.release case: the server pays whatever is free, so its
    // fingerprint cannot separate a retry from a second genuine payout. A HELD
    // identity there would let a later real payout replay an earlier one.
    const identity = createCommandIdentity();
    const lost = identity.renew("deposits.release:d1:REFUNDED");
    const next = identity.renew("deposits.release:d1:REFUNDED");
    expect(next).not.toBe(lost);
  });

  it("never shares an identity between different intents", () => {
    const identity = createCommandIdentity();
    expect(identity.for("a")).not.toBe(identity.for("b"));
  });

  it("idempotencyKey() alone still mints a fresh value every call", () => {
    // Pinning the distinction the hook exists to fix: this helper is per-call by
    // design, which is why calling it inline gave mobile no retry protection.
    expect(idempotencyKey("op")).not.toBe(idempotencyKey("op"));
  });
});
