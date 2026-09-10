"use client";

import { useMemo, useRef } from "react";

/**
 * SCRUM-57 — a per-INTENT identity for economic commands.
 *
 * Every financial mutation now REFUSES to run without a command identity
 * (`convex/utils/idempotency.ts`). This hook is where that identity is minted
 * on the web client, and its whole job is the lifecycle:
 *
 *   - minted ONCE per business intent, on the first attempt;
 *   - survives rerenders, because it lives in a ref rather than in state or in
 *     a value recomputed during render;
 *   - REUSED by every retry of that same intent — a failed call deliberately
 *     does NOT retire the key, which is what makes a lost response, a network
 *     retry or an impatient second click collapse into one economic effect;
 *   - retired on success, so the next genuinely new intent gets a fresh one.
 *
 * ⚠️ WHY THE KEY IS NOT DERIVED FROM THE PAYLOAD. It was, once, and it caused
 * an incident recorded at `components/vehicles/VehicleDetailsDialog.tsx`: a key
 * derived from (deposit, resolution) made a SECOND genuine payout collide with
 * the first one's stored command, so the mutation returned without running, no
 * money moved, and the operator was told the customer had been refunded. Two
 * distinct intents can be identical in every recorded fact. Only an identity
 * minted per intent can tell "this is a retry" from "this is a second, real
 * request", so the intent boundary mints it and the server enforces that one
 * is present.
 *
 * `intentId` names the intent, not the request: use something stable for the
 * thing being acted on (`clear-cheque:<chequeId>`), NOT something that varies
 * per render or per attempt.
 */
export type CommandIdentity = {
  /** The identity for this intent — stable until it is retired. */
  for: (intentId: string) => string;
  /** Call after the intent has succeeded, so the next one is a new command. */
  retire: (intentId: string) => void;
  /**
   * Retire whatever identity this intent holds and mint a new one, marking the
   * start of a NEW attempt.
   *
   * ⚠️ Use this ONLY for a command whose server-side fingerprint provably
   * cannot separate a retry from a genuinely new command, because the amount it
   * moves is not a client input. `deposits.release` is the case: it pays out
   * whatever is currently FREE on the row, so two real payouts of the same
   * deposit with the same resolution are byte-identical requests
   * (`convex/deposits.ts` documents exactly this).
   *
   * For such a command, holding one identity across attempts is unsafe rather
   * than safe: if the first response is LOST, `retire` never runs, and a later
   * genuinely-new payout reuses the stale identity and is handed the first
   * one's stored result — money silently not moved, success reported. That is
   * the original VehicleDetailsDialog incident arriving through a second door.
   *
   * At-most-once for these commands comes from the server recomputing the free
   * balance — a duplicate submit finds nothing left to pay and pays nothing —
   * not from the command log. Marking one attempt is therefore the correct
   * identity, and is NOT the "fresh random id per request" anti-pattern, which
   * is unsafe precisely where content CAN identify the command.
   */
  renew: (intentId: string) => string;
};

export function useCommandIdentity(): CommandIdentity {
  const keys = useRef<Map<string, string>>(new Map());

  return useMemo(
    () => ({
      for(intentId: string) {
        const existing = keys.current.get(intentId);
        if (existing) return existing;
        const minted = `${intentId}:${crypto.randomUUID()}`;
        keys.current.set(intentId, minted);
        return minted;
      },
      retire(intentId: string) {
        keys.current.delete(intentId);
      },
      renew(intentId: string) {
        const minted = `${intentId}:${crypto.randomUUID()}`;
        keys.current.set(intentId, minted);
        return minted;
      },
    }),
    []
  );
}
