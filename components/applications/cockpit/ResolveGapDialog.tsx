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

  const parsed =
    customerShareMinor !== null &&
    dealerShareMinor !== null &&
    cashMinor !== null &&
    installmentsMinor !== null &&
    toFinanceCompanyMinor !== null;

  const allocatedMinor =
    (cashMinor ?? 0) + (installmentsMinor ?? 0) + (toFinanceCompanyMinor ?? 0);
  const unallocatedMinor = (customerShareMinor ?? 0) - allocatedMinor;

  // The shared arithmetic, so the screen and the mutation agree about what is
  // acceptable. A dialog with its own rules would either block a submission the
  // server accepts or invite one it refuses.
  const violations =
    parsed && dealerShareMinor >= 0
      ? validateGapShares(gapMinor, {
          customerGapShareMinor: customerShareMinor,
          dealerGapShareMinor: dealerShareMinor,
          customerGapCashToDealerMinor: cashMinor,
          customerGapInstallmentToDealerMinor: installmentsMinor,
          customerGapToFinanceCompanyMinor: toFinanceCompanyMinor,
        })
      : [{ code: "NEGATIVE_AMOUNT" as const, message: "" }];

  /**
   * A "split" that leaves the customer with nothing is dealer-absorbs wearing
   * the wrong label. The server refuses that outright; the button should not
   * offer it either. Bounded at both ends, because the whole gap on the
   * customer is the OTHER radio and this one should mean what it says.
   */
  const splitIsRealSplit =
    draft.mode !== "SPLIT" ||
    (customerShareMinor !== null && customerShareMinor > 0 && customerShareMinor < gapMinor);

  const canSubmit = !submitting && parsed && splitIsRealSplit && violations.length === 0;

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
            <p
              className={`text-xs ${unallocatedMinor === 0 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}
            >
              {t("GapStillToAllocate")}{" "}
              <span className="font-medium tabular-nums">{money(unallocatedMinor)}</span>
            </p>
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
