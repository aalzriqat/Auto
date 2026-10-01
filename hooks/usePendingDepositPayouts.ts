"use client";

import { useMemo, useRef, useState } from "react";
import { isConvexError } from "@/lib/errors";

/**
 * SCRUM-469 — the identity of a deposit payout that MAY have committed.
 *
 * `deposits.release` pays whatever is currently FREE on the row; the amount is
 * not an input, so two payouts are byte-identical requests and only the command
 * key (and the row's `releaseCount`) separates a retry from a second payout.
 * The payment method is an attribute of ONE money movement, so it is part of
 * what is remembered: an attempt that lost its response is a payout of THAT
 * resolution by THAT method, and it stays exactly that until it is resolved.
 *
 *   - `check` before sending: nothing outstanding -> go (the caller builds its
 *     generation-aware intent and `record`s it; the key still comes from
 *     `useCommandIdentity`, so the client-identity ratchet keeps seeing it).
 *   - the SAME resolution and method again is a retry: the recorded intent is
 *     returned (`recordedIntent`), even if the row's generation has moved.
 *   - a DIFFERENT resolution or method is refused (`blocked`) — it would mint a
 *     new key and could pay the same, or newly freed, money out twice. The
 *     operator reconciles: retry the recorded attempt, or dismiss it.
 *   - only a CONFIRMED success (`confirm`) or an explicit `dismiss` clears it.
 *   - `dismiss` also RETIRES the recorded intent's command key (via the required
 *     `retire` parameter, so no caller can forget it). A dismissed attempt may
 *     have committed; if its key stayed available, resubmitting the same method
 *     while the displayed `releaseCount` is still stale would rebuild the same
 *     intent, reuse the same key, and the server would replay the earlier result
 *     -- "refunded" for a submission that moved no money. `confirm` does NOT
 *     retire: callers already retire on success.
 *
 * SCRUM-530: the record exists only while the outcome is genuinely UNKNOWN. A
 * definite server refusal (`settleFailure` with a `ConvexError`) retires it and
 * its key the same way, but ONLY while no earlier attempt under that record had an
 * unknown outcome (a refused retry proves nothing about the first attempt);
 * every other error keeps both (fail-safe).
 *
 * It lives in a ref keyed by deposit id, so it survives the method picker
 * clearing and the dialog closing and reopening. It does not outlive the owning
 * component instance (nor does the command identity it retires).
 */
export type PendingPayout = {
  resolution: "REFUNDED" | "FORFEITED";
  /** The refund method, or "NONE" for a forfeit. */
  method: string;
  intent: string;
  /**
   * SCRUM-530 F1: set once an attempt under this record has had an UNKNOWN outcome (a
   * non-definite failure, or a retry was sent). A later refusal of a retry proves nothing
   * about the earlier attempt, so such a record is retired only by `confirm` or an explicit
   * `dismiss`. Hook-internal: callers never set it.
   */
  uncertain?: boolean;
};

export type PayoutGate = { status: "go"; recordedIntent?: string } | { status: "blocked"; pending: PendingPayout };

export type PendingDepositPayouts = {
  check: (depositId: string, resolution: "REFUNDED" | "FORFEITED", method: string) => PayoutGate;
  /** Record the attempt about to be sent (idempotent for the same recorded attempt). */
  record: (depositId: string, payout: PendingPayout) => void;
  confirm: (depositId: string) => void;
  dismiss: (depositId: string) => void;
  /**
   * SCRUM-530: a `ConvexError` (definite refusal) of the FIRST attempt dismisses like `dismiss`.
   * Any other error, or any error once an earlier attempt had an unknown outcome, keeps the
   * record. `intent` binds the answer to the attempt it belongs to.
   */
  settleFailure: (depositId: string, error: unknown, intent: string) => void;
  /** Deposits whose recorded attempt is blocking a different decision, for the notice. */
  blocked: Readonly<Record<string, PendingPayout>>;
};

export function usePendingDepositPayouts(retire: (intent: string) => void): PendingDepositPayouts {
  const pendingRef = useRef<Map<string, PendingPayout>>(new Map());
  const [blocked, setBlocked] = useState<Record<string, PendingPayout>>({});

  return useMemo(() => {
    const clear = (depositId: string) => {
      pendingRef.current.delete(depositId);
      setBlocked((current) => {
        if (!(depositId in current)) return current;
        const { [depositId]: _removed, ...rest } = current;
        return rest;
      });
    };
    const dismiss = (depositId: string) => {
      const existing = pendingRef.current.get(depositId);
      if (existing) retire(existing.intent);
      clear(depositId);
    };
    return {
      check(depositId, resolution, method) {
        const existing = pendingRef.current.get(depositId);
        if (!existing) return { status: "go" };
        if (existing.resolution === resolution && existing.method === method) {
          // A retry of an attempt that never confirmed: its outcome is unknown.
          existing.uncertain = true;
          return { status: "go", recordedIntent: existing.intent };
        }
        setBlocked((current) => ({ ...current, [depositId]: existing }));
        return { status: "blocked", pending: existing };
      },
      record(depositId, payout) {
        // Copied: the record carries hook-owned state (`uncertain`) the caller's object must not.
        if (!pendingRef.current.has(depositId)) pendingRef.current.set(depositId, { ...payout });
      },
      confirm: clear,
      dismiss,
      settleFailure(depositId, error, intent) {
        const existing = pendingRef.current.get(depositId);
        // A late answer for an older attempt must not touch a newer record.
        if (!existing || existing.intent !== intent) return;
        if (isConvexError(error) && !existing.uncertain) dismiss(depositId);
        else existing.uncertain = true;
      },
      blocked,
    };
  }, [blocked, retire]);
}
