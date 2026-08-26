"use client";

import type { Doc, Id } from "@/convex/_generated/dataModel";

/**
 * SCRUM-195 — WHAT SAVING THIS QUOTE WILL ACTUALLY DO.
 *
 * A quote either OPENS a deal or CARRIES ONE FORWARD, and until this existed
 * the screen never said which. Every shipped `saveQuote` call site wrote
 * `intent: "NEW"` as a literal after spreading its payload, so linked revision
 * and reservation adoption were unreachable by construction while the backend
 * enforced both — and the salesperson met that enforcement as an unexplained
 * refusal on the customer's deposit, one screen later.
 *
 * Pure and prop-driven on purpose: it holds no hooks, so it can be rendered on
 * its own in every state, in both directions and both themes, and looked at.
 */

export type DealContinuation =
  | { kind: "NEW" }
  | { kind: "HELD_BY_ANOTHER_DEAL" }
  | { kind: "AMBIGUOUS" }
  | {
      kind: "ADOPT_RESERVATION";
      reservationId: Id<"vehicleReservations">;
      reservedAt: number;
      expiresAt: number | null;
      depositAmount: number | null;
    }
  | {
      kind: "REVISE_QUOTE";
      quoteId: Id<"quotes">;
      vehiclePrice: number;
      createdAt: number;
      revision: number;
      unresolvedMoneyMinor: number;
      unresolvedMoney: number;
      currency: string;
    };

/**
 * The lineage a save should carry, derived from the situation.
 *
 * ⚠️ EXPORTED AND PURE ON PURPOSE. This decision used to live as a literal in
 * the middle of a submit handler — `intent: "NEW" as const`, written after the
 * payload spread so nothing could override it — in all four shipped call sites
 * at once. That made linked revision and reservation adoption unreachable by
 * construction while the backend enforced both, and no test could see it
 * because there was nothing to call. Now there is.
 *
 * The blocked kinds map to a plain new deal because they are never submittable:
 * the screen disables every save while they hold. They are listed rather than
 * defaulted so that adding a kind forces a decision here.
 */
export function quoteLineageFor(continuation: DealContinuation | undefined):
  | { intent: "NEW" }
  | { intent: "NEW"; adoptReservationId: Id<"vehicleReservations"> }
  | { intent: "REVISE"; supersedesQuoteId: Id<"quotes"> } {
  switch (continuation?.kind) {
    case "REVISE_QUOTE":
      return { intent: "REVISE", supersedesQuoteId: continuation.quoteId };
    case "ADOPT_RESERVATION":
      return { intent: "NEW", adoptReservationId: continuation.reservationId };
    case "HELD_BY_ANOTHER_DEAL":
    case "AMBIGUOUS":
    case "NEW":
    case undefined:
      return { intent: "NEW" };
  }
}

type Props = Readonly<{
  continuation: DealContinuation | undefined;
  /** The typed price is below what the customer has already paid into the deal. */
  priceBelowPaid: boolean;
  t: (key: string) => string;
}>;

/**
 * A number, a currency or a date, isolated from the surrounding direction.
 *
 * ⚠️ Without `dir="ltr"` these break in Arabic. "28,000 JOD" inside an RTL
 * paragraph reorders to "JOD 28,000" — the code lands on the wrong side of its
 * own amount — and a date rendered by the ambient locale comes out in
 * Arabic-Indic digits beside amounts in Latin ones, so one line carries two
 * numeral systems. Both were visible in the rendered check, not in the source.
 */
function Value({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span dir="ltr" className="inline-block font-medium text-foreground">
      {children}
    </span>
  );
}

/** One labelled fact. The strip is a sentence and a short row of these. */
function Fact({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <Value>{children}</Value>
    </span>
  );
}

/** Latin digits in both languages, so one line never mixes numeral systems. */
function shortDate(at: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(at));
}

export function DealContinuityNotice({ continuation, priceBelowPaid, t }: Props) {
  if (!continuation || continuation.kind === "NEW") return null;

  const blocking =
    continuation.kind === "HELD_BY_ANOTHER_DEAL" || continuation.kind === "AMBIGUOUS";

  return (
    /*
      Deliberately NOT a Card. The finance options below are cards, and nesting
      one here would flatten the hierarchy at exactly the moment this needs to
      be the first thing read. A start-side accent rule and a weight change
      carry it instead — and `border-s` is logical, so Arabic gets the rule on
      the correct edge without mirroring anything whose meaning is physical.
    */
    <div
      className={`border-s-2 ps-4 py-3 ${
        blocking ? "border-destructive bg-destructive/5" : "border-primary bg-primary/5"
      }`}
    >
      {continuation.kind === "ADOPT_RESERVATION" && (
        <>
          <p className="font-medium">{t("ContinuityReservedTitle")}</p>
          <p className="text-sm text-muted-foreground mt-1">{t("ContinuityReservedDetail")}</p>
          <p className="text-sm mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Fact label={t("ContinuityReservedOn")}>{shortDate(continuation.reservedAt)}</Fact>
            {continuation.depositAmount ? (
              <Fact label={t("ContinuityReservationHolds")}>
                {continuation.depositAmount.toLocaleString("en-US")} JOD
              </Fact>
            ) : null}
          </p>
        </>
      )}

      {continuation.kind === "REVISE_QUOTE" && (
        <>
          <p className="font-medium">{t("ContinuityReviseTitle")}</p>
          <p className="text-sm text-muted-foreground mt-1">{t("ContinuityReviseDetail")}</p>
          <p className="text-sm mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Fact label={t("ContinuityRevision")}>{continuation.revision}</Fact>
            <Fact label={t("ContinuityCurrentPrice")}>
              {continuation.vehiclePrice.toLocaleString("en-US")} {continuation.currency}
            </Fact>
          </p>
          {/*
            On its own line, and louder. This is the figure that decides whether
            the requote is even legal — the new price may not go below it — and
            in the rendered check it was disappearing into a run-on row of facts
            weighted exactly like the version number beside it.
          */}
          {continuation.unresolvedMoney > 0 && (
            <p className="text-sm mt-1.5">
              <span className="text-muted-foreground">{t("ContinuityAlreadyPaid")}: </span>
              <Value>
                {continuation.unresolvedMoney.toLocaleString("en-US")} {continuation.currency}
              </Value>
            </p>
          )}
          {priceBelowPaid && (
            <p className="text-sm font-medium text-destructive mt-2">
              {t("ContinuityPriceBelowPaid")}
            </p>
          )}
        </>
      )}

      {continuation.kind === "HELD_BY_ANOTHER_DEAL" && (
        <>
          <p className="font-medium text-destructive">{t("ContinuityHeldTitle")}</p>
          <p className="text-sm text-muted-foreground mt-1">{t("ContinuityHeldDetail")}</p>
        </>
      )}

      {continuation.kind === "AMBIGUOUS" && (
        <>
          <p className="font-medium text-destructive">{t("ContinuityAmbiguousTitle")}</p>
          <p className="text-sm text-muted-foreground mt-1">{t("ContinuityAmbiguousDetail")}</p>
        </>
      )}

      {/*
        Say what the screen just did. Both blocking states disable every finance
        option below, and in the rendered check nothing connected the message to
        the greyed-out buttons — leaving the salesperson to conclude the screen
        was broken rather than deliberate.
      */}
      {blocking && (
        <p className="text-sm font-medium mt-2">{t("ContinuityBlockedConsequence")}</p>
      )}
    </div>
  );
}

/** Kept beside the notice so the vehicle picker and the strip agree on wording. */
export function vehicleOptionSubLabel(vehicle: Doc<"vehicles">, t: (key: string) => string) {
  const price = `${vehicle.sellingPrice.toLocaleString("en-US")} JOD`;
  return vehicle.status === "RESERVED" ? `${price} · ${t("Reserved")}` : price;
}
