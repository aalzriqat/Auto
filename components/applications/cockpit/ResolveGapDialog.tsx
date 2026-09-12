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
 * Who covers the shortfall. All three are ordinary operator choices
 * (owner-proxy 2026-09-12): the customer, the dealership, or both.
 *
 * The value recorded is still DERIVED by the server from the shares — this is
 * how the operator states the shape of the agreement, not a label the record
 * takes on trust.
 */
export type GapMode = "CUSTOMER_ABSORBS" | "SPLIT" | "DEALER_ABSORBS";

/**
 * One confirmation attempt: what the operator typed AND the figures they were
 * typing against.
 *
 * The gap and the stamp are captured on the closed -> open transition and never
 * re-read while the dialog is open. An earlier revision took the gap from a
 * live prop and let the parent send the live stamp at submit time, which
 * quietly destroyed the very protection the stamp exists for: a re-approval
 * mid-dialog moved the shortfall from 1,000 to 1,200, the dealer's derived
 * share changed underneath the operator, and the submission carried the NEW
 * stamp, so the server accepted an allocation nobody had agreed to. Every
 * figure below comes from the snapshot.
 */
type Attempt = {
  rawAppraisalGapMinor: number;
  submittedQuotationMinor: number | null;
  approvedPurchaseAmountMinor: number | null;
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
 * A blank destination must not read as 0: on a 1,000 shortfall an operator
 * could type 1,000 into cash-to-dealer, leave the other two blank, and the
 * dialog would submit three figures of which one was chosen and two were
 * invented. Money to the dealership becomes dealer proceeds and money to the
 * finance company must not, so "nothing was paid to the financier" and "nobody
 * said what was paid to the financier" are different facts with different
 * accounting consequences. A typed `0` is a decision and is accepted. Blank is
 * not a decision.
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
 * quotation (SCRUM-83).
 *
 * The identities are NOT re-implemented here — `validateGapShares` from the
 * shared engine decides whether an allocation reconciles, and the same function
 * runs again inside `resolveAppraisalGap`. This screen only decides what to
 * SHOW; the server is the authority and refuses anything that does not add up.
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
  submittedQuotationMinor,
  approvedPurchaseAmountMinor,
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
  /** The quotation sent to the company — shown for context; null when withheld from this caller. */
  submittedQuotationMinor: number | null;
  /** What the company approved — shown for context; null when withheld from this caller. */
  approvedPurchaseAmountMinor: number | null;
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
    setAttempt({
      rawAppraisalGapMinor,
      submittedQuotationMinor,
      approvedPurchaseAmountMinor,
      economicsStamp,
    });
  }, [open, rawAppraisalGapMinor, submittedQuotationMinor, approvedPurchaseAmountMinor, economicsStamp]);

  // Before the first open there is no snapshot yet, and the live values are
  // correct in that window because nothing has been typed against them.
  const live: Attempt = attempt ?? {
    rawAppraisalGapMinor,
    submittedQuotationMinor,
    approvedPurchaseAmountMinor,
    economicsStamp,
  };
  const gapMinor = live.rawAppraisalGapMinor;

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  /**
   * The customer's share of the shortfall.
   *
   * CUSTOMER_ABSORBS: the whole gap; DEALER_ABSORBS: nothing. Neither is typed
   * — the server already knows the gap, and asking the operator to retype a
   * number it holds would only create a way to get it wrong. SPLIT is the one
   * mode where the customer's part is entered; the dealership's is derived.
   */
  const customerShareMinor =
    draft.mode === "CUSTOMER_ABSORBS"
      ? gapMinor
      : draft.mode === "DEALER_ABSORBS"
        ? 0
        : toMinor(draft.customerShare, factor);

  // Derived, never typed. Entering one side and computing the other is what
  // stops two boxes from disagreeing about a number that must sum exactly.
  const dealerShareMinor = customerShareMinor === null ? null : gapMinor - customerShareMinor;

  /**
   * Where the customer's part is paid.
   *
   * With NO customer part (DEALER_ABSORBS) there is nothing to place, and the
   * three destinations are zero BY ARITHMETIC — the shared identity requires
   * them to sum to a customer share of zero — not by a default read into a
   * blank box. Every other mode keeps blank as "not decided".
   */
  const noCustomerPart = draft.mode === "DEALER_ABSORBS";
  const cashMinor = noCustomerPart ? 0 : toMinor(draft.cash, factor);
  const installmentsMinor = noCustomerPart ? 0 : toMinor(draft.installments, factor);
  const toFinanceCompanyMinor = noCustomerPart ? 0 : toMinor(draft.toFinanceCompany, factor);

  const destinationsDecided =
    cashMinor !== null && installmentsMinor !== null && toFinanceCompanyMinor !== null;

  /**
   * ONE readiness verdict, consumed by both the message and the button.
   *
   * Readiness spread across independent booleans is how a running total came
   * to say "0 left" beside a dead Confirm button. `canSubmit` is exactly
   * `verdict === "READY"`, and every not-ready verdict carries the message that
   * names its own remedy.
   */
  type Readiness =
    | "READY"
    /** Some destination box is still blank; blank is not a decision. */
    | "DESTINATIONS_INCOMPLETE"
    /** The customer share is not a usable number yet. */
    | "SHARE_MISSING"
    /** A "split" giving the customer the whole gap IS customer-absorbs. */
    | "SPLIT_IS_WHOLE_GAP"
    /** A "split" leaving the customer nothing IS dealer-absorbs. */
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
    // about what reconciles.
    const violations = validateGapShares(gapMinor, {
      customerGapShareMinor: customerShareMinor,
      dealerGapShareMinor: dealerShareMinor,
      customerGapCashToDealerMinor: cashMinor,
      customerGapInstallmentToDealerMinor: installmentsMinor,
      customerGapToFinanceCompanyMinor: toFinanceCompanyMinor,
    });
    return violations.length > 0 ? "ALLOCATION_MISMATCH" : "READY";
  })();

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
    // destinations: `canSubmit` already proves they are non-null, so a zero
    // written beside them can only ever be a value nobody typed.
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

  const figure = (minor: number | null) => (minor === null ? "—" : money(minor));

  return (
    <Dialog open={open} onOpenChange={submitting ? () => {} : onOpenChange}>
      {/* The height cap is load-bearing, not styling: DialogContent is fixed
          and vertically centred with no max-height of its own, and SPLIT
          reveals four more inputs, so this is the cockpit dialog that crosses
          a 667px phone. Matches the cap the app's other tall dialogs carry. */}
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            {t("ResolveGapTitle")}
          </DialogTitle>
          <DialogDescription>{t("ResolveGapDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The three figures the agreement is about, stated once and not
              editable: the quotation that went out, what the company approved,
              and the difference. They are the server's figures — an operator
              who disagrees with them is telling us the approval is wrong, which
              is a different action (reopen the approved amount). */}
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm"
            data-testid="gap-figures"
          >
            <dt className="text-muted-foreground">{t("GapRecordedQuotation")}</dt>
            <dd className="text-end tabular-nums">
              <bdi>{figure(live.submittedQuotationMinor)}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("GapApprovedAmount")}</dt>
            <dd className="text-end tabular-nums">
              <bdi>{figure(live.approvedPurchaseAmountMinor)}</bdi>
            </dd>
            <dt className="font-medium">{t("ResolveGapAmount")}</dt>
            <dd className="text-end font-semibold tabular-nums">
              <bdi data-testid="gap-amount">{money(gapMinor)}</bdi>
            </dd>
          </dl>

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
              {
                value: "DEALER_ABSORBS",
                label: t("GapDealerAbsorbs"),
                hint: t("GapDealerAbsorbsHint"),
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
                className="tabular-nums"
              />
              {/* Both sides shown before confirmation — the dealership's
                  portion is the consequence of the number typed above, and an
                  operator should see it before agreeing. */}
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
              are three different accounting outcomes for the same money. Not
              shown when the customer has no part: there is nothing to place. */}
          {!noCustomerPart && (
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
                    className="tabular-nums"
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
                    className="tabular-nums"
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
                    className="tabular-nums"
                  />
                </div>
              </div>
            </fieldset>
          )}

          {/* The reason the button is dead, or the all-placed confirmation —
              driven by the SAME verdict as `canSubmit`, so a disabled button
              and a reassuring total can never appear together. */}
          {verdict !== "READY" ? (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="gap-readiness">
              {t(BLOCKED_REASON[verdict])}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="gap-readiness">
              {t("GapAllocationComplete")}
            </p>
          )}

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
