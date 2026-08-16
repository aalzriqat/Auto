"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioCardGroup } from "./RadioCardGroup";
import { validateGapShares } from "@/lib/financingEconomics";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Which of the two the owner authorised as ordinary operator choices.
 *
 * `DEALER_ABSORBS` exists in the schema and remains readable on historical
 * rows, but it is deliberately NOT offered here: the enum having a member is
 * not evidence that the dealership absorbing a shortfall alone is a normal
 * outcome, and a production scan found no row that ever used it. Offering it
 * would be inventing a business case out of a validator literal.
 */
export type GapMode = "CUSTOMER_ABSORBS" | "SPLIT";

/**
 * One confirmation attempt: what the operator typed AND the figures they were
 * typing against.
 *
 * The gap and the stamp are captured on the closed -> open transition and never
 * re-read while the dialog is open. An earlier revision of this component took
 * the gap from a live prop and let the parent send the live stamp at submit
 * time, which quietly destroyed the very protection the stamp exists for: a
 * re-approval mid-dialog moved the shortfall from 1,000 to 1,200, the dealer's
 * derived share changed underneath the operator, and the submission carried the
 * NEW stamp, so the server accepted an allocation nobody had agreed to. That is
 * the same live-vs-snapshot fault the handover confirmation was rebuilt to
 * remove, which is why every figure below comes from the snapshot.
 */
type Attempt = {
  rawAppraisalGapMinor: number;
  economicsStamp: string | undefined;
};

/** What the operator typed, before it is anything the server would accept. */
type Draft = {
  mode: GapMode;
  customerShare: string;
  cash: string;
  installments: string;
  toFinanceCompany: string;
  notes: string;
};

const EMPTY: Draft = {
  mode: "CUSTOMER_ABSORBS",
  customerShare: "",
  cash: "",
  installments: "",
  toFinanceCompany: "",
  notes: "",
};

/**
 * Major units to minor, or null when the box is not a number the server could
 * use — and an EMPTY box is null, including on the destination lines.
 *
 * An earlier revision mapped a blank destination to 0. That let the screen
 * manufacture a decision nobody made: on a 1,000 shortfall an operator could
 * type 1,000 into cash-to-dealer, leave the other two blank, and the dialog
 * would submit three figures of which one was chosen and two were invented —
 * arithmetic that reconciles because the invented values happen to be zero.
 *
 * The distinction is not cosmetic. Money to the dealership becomes dealer
 * proceeds and money to the finance company must not, so "nothing was paid to
 * the financier" and "nobody said what was paid to the financier" are different
 * facts with different accounting consequences. The owner's rule for this
 * workflow is explicit that there are no defaults from absence, and a blank box
 * silently reading as zero is exactly such a default.
 *
 * A typed `0` is a decision and is accepted. Blank is not a decision.
 */
function toMinor(value: string, factor: number): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const minor = Math.round(parsed * factor);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Settling the shortfall a finance company left when it approved below the
 * quotation.
 *
 * The identities are NOT re-implemented here — `validateGapShares` from the
 * shared engine decides whether an allocation reconciles, and the same function
 * runs again inside the mutation. This screen only decides what to SHOW; the
 * server is the authority and refuses anything that does not add up.
 *
 * The destinations are the reason this dialog exists rather than a single
 * "who pays" toggle. Money the customer pays the DEALERSHIP becomes dealer
 * proceeds; money the customer pays the FINANCE COMPANY does not, and must
 * never become a dealer receivable. Those are different accounting outcomes for
 * the same shortfall, so the operator states which one happened instead of the
 * software guessing.
 */
export function ResolveGapDialog({
  open,
  submitting,
  rawAppraisalGapMinor,
  economicsStamp,
  factor,
  money,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  /** The shortfall being settled, as the server currently states it. */
  rawAppraisalGapMinor: number;
  /** The revision those figures belong to; snapshotted alongside them. */
  economicsStamp: string | undefined;
  /** Minor units per major unit, for the deal's own denomination. */
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    customerGapShareMinor: number;
    dealerGapShareMinor: number;
    customerGapCashToDealerMinor: number;
    customerGapInstallmentToDealerMinor: number;
    customerGapToFinanceCompanyMinor: number;
    notes: string;
    economicsStamp: string | undefined;
  }) => Promise<void>;
}>) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  // Reset on the closed -> open transition only, and snapshot the figures with
  // it. Resetting on every change would clear an entry mid-typing; re-reading
  // the gap on every change would move the number being allocated.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setDraft(EMPTY);
    setError(null);
    setAttempt({ rawAppraisalGapMinor, economicsStamp });
  }, [open, rawAppraisalGapMinor, economicsStamp]);

  // Before the first open there is no snapshot yet, and the live values are
  // correct in that window because nothing has been typed against them.
  const live: Attempt = attempt ?? { rawAppraisalGapMinor, economicsStamp };
  const gapMinor = live.rawAppraisalGapMinor;

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  /**
   * The customer's share of the shortfall.
   *
   * On CUSTOMER_ABSORBS it is the whole gap and there is nothing to type — the
   * owner's rule is that the customer share equals the raw gap and the dealer
   * share is zero, so asking the operator to retype a number the server already
   * knows would only create a way to get it wrong.
   */
  const customerShareMinor =
    draft.mode === "CUSTOMER_ABSORBS" ? gapMinor : toMinor(draft.customerShare, factor);

  // Derived, never typed. Entering one side and computing the other is what
  // stops two boxes from disagreeing about a number that must sum exactly.
  const dealerShareMinor =
    customerShareMinor === null ? null : gapMinor - customerShareMinor;

  // Each destination is its own decision. Blank stays null and blocks the
  // submission rather than becoming a zero the operator never entered.
  const cashMinor = toMinor(draft.cash, factor);
  const installmentsMinor = toMinor(draft.installments, factor);
  const toFinanceCompanyMinor = toMinor(draft.toFinanceCompany, factor);

  /**
   * The running total, or null while any destination is still undecided.
   *
   * NOT `?? 0`. Those fallbacks were dead code while a blank box parsed as
   * zero, and making blanks null brought them to life meaning something the
   * submit path does not accept: a blank counted as nothing allocated, so
   * typing the whole shortfall into cash-to-dealer and leaving the other two
   * empty displayed "still to allocate: 0" — the calm, everything-agrees state
   * — beside a Confirm button that was disabled and said nothing about why.
   *
   * The operator was being told they were finished by the one figure on the
   * screen whose job is to tell them whether they are. This is the third
   * display-versus-submit disagreement this dialog has produced, so the fix is
   * the shape rather than the symptom: where the submission cannot be computed,
   * neither can the total, and the screen says which boxes are still open
   * instead of inventing a reassuring number.
   */
  const destinationsDecided =
    cashMinor !== null && installmentsMinor !== null && toFinanceCompanyMinor !== null;

  /**
   * ONE readiness verdict, consumed by both the message and the button.
   *
   * The three previous display-versus-submit disagreements in this dialog all
   * had the same cause: readiness was spread across independent booleans
   * (`parsed`, `splitIsRealSplit`, `violations`) while the screen derived its
   * own answer separately. Each fix closed one gap and left the others free to
   * disagree again — the running total said "0 left" while the button was dead,
   * because nothing forced the two to be computed from the same thing.
   *
   * They now are. `canSubmit` is exactly `verdict === "READY"`, and every
   * not-ready verdict carries the message that names its own remedy. A new
   * blocking condition cannot be added to one and forgotten in the other,
   * because there is only one place to add it.
   */
  type Readiness =
    | "READY"
    /** Some destination box is still blank; blank is not a decision. */
    | "DESTINATIONS_INCOMPLETE"
    /** The customer share is not a usable number yet. */
    | "SHARE_MISSING"
    /** A "split" giving the customer the whole gap IS customer-absorbs. */
    | "SPLIT_IS_WHOLE_GAP"
    /** A "split" leaving the customer nothing is the dealer-only outcome. */
    | "SPLIT_LEAVES_CUSTOMER_NOTHING"
    /** The destinations do not sum to the customer's share. */
    | "ALLOCATION_MISMATCH";

  const verdict: Readiness = (() => {
    if (customerShareMinor === null || dealerShareMinor === null) return "SHARE_MISSING";
    if (draft.mode === "SPLIT") {
      // Checked BEFORE the arithmetic, because both endpoints reconcile
      // perfectly and would otherwise read as ready. The remedy is a different
      // mode, not a different number, so the message has to say so.
      if (customerShareMinor >= gapMinor) return "SPLIT_IS_WHOLE_GAP";
      if (customerShareMinor <= 0) return "SPLIT_LEAVES_CUSTOMER_NOTHING";
    }
    if (!destinationsDecided) return "DESTINATIONS_INCOMPLETE";
    // The SHARED arithmetic, so the screen and the mutation cannot disagree
    // about what reconciles. A dialog with its own rules would either block a
    // submission the server accepts or invite one it refuses.
    const violations = validateGapShares(gapMinor, {
      customerGapShareMinor: customerShareMinor,
      dealerGapShareMinor: dealerShareMinor,
      customerGapCashToDealerMinor: cashMinor,
      customerGapInstallmentToDealerMinor: installmentsMinor,
      customerGapToFinanceCompanyMinor: toFinanceCompanyMinor,
    });
    return violations.length > 0 ? "ALLOCATION_MISMATCH" : "READY";
  })();

  /**
   * The remainder, and only where a remainder is a meaningful thing to state.
   *
   * Withheld for every not-ready verdict rather than only for incomplete
   * destinations: a split holding the whole gap reconciles to zero, and showing
   * that zero is precisely how the screen used to tell the operator they were
   * finished while the button stayed dead.
   */
  const unallocatedMinor =
    verdict === "READY" && customerShareMinor !== null && destinationsDecided
      ? customerShareMinor - (cashMinor + installmentsMinor + toFinanceCompanyMinor)
      : null;

  /** What to say instead, so a disabled button is never unexplained. */
  const BLOCKED_REASON: Record<Exclude<Readiness, "READY">, string> = {
    DESTINATIONS_INCOMPLETE: "GapDestinationsIncomplete",
    SHARE_MISSING: "GapShareMissing",
    SPLIT_IS_WHOLE_GAP: "GapSplitIsWholeGap",
    SPLIT_LEAVES_CUSTOMER_NOTHING: "GapSplitLeavesCustomerNothing",
    ALLOCATION_MISMATCH: "GapAllocationMismatch",
  };

  const canSubmit = !submitting && verdict === "READY";

  const submit = async () => {
    // Every figure narrowed explicitly, and NOT with `?? 0` on the
    // destinations. A fallback here would restore the defect one refactor
    // later: `canSubmit` already proves they are non-null, so a zero written
    // beside them can only ever be a value nobody typed.
    if (
      !canSubmit ||
      customerShareMinor === null ||
      dealerShareMinor === null ||
      cashMinor === null ||
      installmentsMinor === null ||
      toFinanceCompanyMinor === null
    ) {
      return;
    }
    setError(null);
    try {
      await onSubmit({
        customerGapShareMinor: customerShareMinor,
        dealerGapShareMinor: dealerShareMinor,
        customerGapCashToDealerMinor: cashMinor,
        customerGapInstallmentToDealerMinor: installmentsMinor,
        customerGapToFinanceCompanyMinor: toFinanceCompanyMinor,
        notes: draft.notes.trim(),
        // The stamp the dialog was OPENED against, not whatever the deal says
        // now. Sending the live one would tell the server the operator had seen
        // a revision they never saw.
        economicsStamp: live.economicsStamp,
      });
    } catch (caught) {
      // Shown here rather than thrown away: the server owns the refusal, and
      // its wording names the figure that did not reconcile.
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={submitting ? () => {} : onOpenChange}>
      {/* The height cap is load-bearing, not styling. DialogContent is
          `position: fixed` and vertically centred with no max-height of its
          own, so a dialog taller than the viewport hangs off BOTH ends with
          nothing able to scroll it — measured at 1027px against an 844px
          phone, which put the confirm button 30 of its 36 pixels below the
          fold and, on a 667px-tall phone, entirely out of reach. This is the
          tallest dialog in the cockpit because SPLIT reveals four more inputs,
          so it is the one that crosses the line. Matches the cap the rest of
          the app's tall dialogs already carry. */}
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            {t("ResolveGapTitle")}
          </DialogTitle>
          <DialogDescription>{t("ResolveGapDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The shortfall itself, stated once and not editable. It is the
              server's figure; an operator who disagrees with it is telling us
              the approval is wrong, which is a different action. */}
          <div className="flex items-baseline justify-between gap-4 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-sm text-muted-foreground">{t("ResolveGapAmount")}</span>
            <span className="font-semibold tabular-nums">{money(gapMinor)}</span>
          </div>

          <RadioCardGroup
            ariaLabel={t("ResolveGapWhoAbsorbs")}
            idPrefix="gap-mode"
            value={draft.mode}
            onChange={(mode) => set({ mode, customerShare: "" })}
            options={[
              {
                value: "CUSTOMER_ABSORBS",
                label: t("GapCustomerAbsorbs"),
                hint: t("GapCustomerAbsorbsHint"),
              },
              {
                value: "SPLIT",
                label: t("GapSplit"),
                hint: t("GapSplitHint"),
              },
            ]}
          />

          {draft.mode === "SPLIT" && (
            <div className="space-y-2">
              <Label htmlFor="gap-customer-share">{t("GapCustomerShare")}</Label>
              <Input
                id="gap-customer-share"
                inputMode="decimal"
                value={draft.customerShare}
                onChange={(event) => set({ customerShare: event.target.value })}
              />
              {/* Both sides shown before confirmation, per the owner's rule —
                  the dealership's portion is the consequence of the number
                  typed above, and an operator should see it before agreeing. */}
              <p className="text-xs text-muted-foreground">
                {t("GapDealerShare")}{" "}
                <span className="font-medium tabular-nums">
                  {dealerShareMinor !== null && dealerShareMinor >= 0
                    ? money(dealerShareMinor)
                    : "—"}
                </span>
              </p>
            </div>
          )}

          {/* The destinations. Three boxes rather than a guess, because these
              are three different accounting outcomes for the same money. */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("GapWhereCustomerPays")}</legend>
            <p className="text-xs text-muted-foreground">{t("GapWhereCustomerPaysHint")}</p>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="gap-cash" className="text-xs">
                  {t("GapCashToDealer")}
                </Label>
                <Input
                  id="gap-cash"
                  inputMode="decimal"
                  value={draft.cash}
                  onChange={(event) => set({ cash: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gap-installments" className="text-xs">
                  {t("GapInstallmentsToDealer")}
                </Label>
                <Input
                  id="gap-installments"
                  inputMode="decimal"
                  value={draft.installments}
                  onChange={(event) => set({ installments: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gap-financier" className="text-xs">
                  {t("GapToFinanceCompany")}
                </Label>
                <Input
                  id="gap-financier"
                  inputMode="decimal"
                  value={draft.toFinanceCompany}
                  onChange={(event) => set({ toFinanceCompany: event.target.value })}
                />
              </div>
            </div>

            {/* What is left to place. Stated as a running figure rather than as
                a validation error, because an operator part-way through an
                allocation has not made a mistake yet. */}
            {verdict !== "READY" ? (
              // The reason the button is dead, in the place the running total
              // would otherwise sit. Driven by the SAME verdict as `canSubmit`,
              // so a disabled button and a reassuring total can no longer
              // appear together.
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t(BLOCKED_REASON[verdict])}
              </p>
            ) : (
              // READY, so a remainder exists and is zero by construction —
              // `validateGapShares` has already agreed the destinations sum to
              // the customer's share.
              <p className="text-xs text-muted-foreground">
                {t("GapStillToAllocate")}{" "}
                <span className="font-medium tabular-nums">{money(unallocatedMinor ?? 0)}</span>
              </p>
            )}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="gap-notes">{t("GapNotes")}</Label>
            <Textarea
              id="gap-notes"
              rows={2}
              value={draft.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t("ResolveGapAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
