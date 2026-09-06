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
    }),
    []
  );
}
