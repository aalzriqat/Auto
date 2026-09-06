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
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";

import {
  createCommandIdentity,
  idempotencyKey,
  useCommandIdentity,
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

  it("falls back to a unique key when the platform has no crypto.randomUUID", () => {
    // Older Android JSC builds ship no `crypto.randomUUID`. The fallback still
    // has to be unique per call: two economic commands colliding on one key
    // would make the server replay the first and discard the second.
    const realCrypto = globalThis.crypto;
    // @ts-expect-error deliberately removing the API the fallback guards against
    delete globalThis.crypto;
    try {
      const first = idempotencyKey("expenses.create");
      const second = idempotencyKey("expenses.create");
      expect(first).not.toBe(second);
      expect(first.startsWith("expenses.create-")).toBe(true);
    } finally {
      globalThis.crypto = realCrypto;
    }
  });
});

/**
 * The hook is the thin `useRef` + `useMemo` wrapper the call sites actually use.
 * Its whole job is to give one identity map a stable lifetime across rerenders —
 * recreating it during render would mint a fresh identity mid-intent, which is
 * exactly the per-invocation behaviour this replaces. So it is exercised through
 * a rendered component rather than asserted on in isolation.
 */
function IdentityProbe() {
  const commandId = useCommandIdentity();
  const [, setTick] = useState(0);
  return (
    <>
      <Text testID="identity">{commandId.for("expenses.create")}</Text>
      <Pressable testID="rerender" onPress={() => setTick((value) => value + 1)}>
        <Text>rerender</Text>
      </Pressable>
      <Pressable testID="retire" onPress={() => commandId.retire("expenses.create")}>
        <Text>retire</Text>
      </Pressable>
    </>
  );
}

describe("useCommandIdentity", () => {
  it("holds one identity across rerenders, and mints a new one after retire", async () => {
    const { getByTestId } = await render(<IdentityProbe />);
    const read = () => (getByTestId("identity") as unknown as { props: { children: string } }).props.children;

    const minted = read();
    expect(minted).toEqual(expect.stringContaining("expenses.create-"));

    fireEvent.press(getByTestId("rerender"));
    await waitFor(() => expect(read()).toBe(minted));

    // Retiring is what ends the command; only then is a new identity correct.
    fireEvent.press(getByTestId("retire"));
    fireEvent.press(getByTestId("rerender"));
    await waitFor(() => expect(read()).not.toBe(minted));
  });
});
