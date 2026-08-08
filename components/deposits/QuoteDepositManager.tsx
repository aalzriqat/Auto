"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PaymentMethodSelect,
  type PaymentMethod,
} from "@/components/payments/PaymentMethodSelect";
import { toast } from "@/components/ui/sonner";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { DepositAllocationPanel } from "@/components/sales/wizard/components/DepositAllocationPanel";
import { AlertTriangle, Undo2 } from "lucide-react";

/**
 * Where a reservation deposit is followed for the life of the deal.
 *
 * The split across the cars is decided once, in the sales wizard, and that was
 * the only place any of it could be seen or changed. But the money keeps moving
 * afterwards and not always in the direction anybody planned: a car leaves the
 * deal, a completed sale is cancelled, a customer asks for part of their عربون
 * back. Each of those leaves a share of a real payment sitting on the books
 * waiting for somebody to say what happens to it, and
 * `deposits.release` deliberately refuses to pay such a share out — it belongs
 * to whichever car it was put against, and resolving the whole row would take
 * the other cars' money with it.
 *
 * Without this screen that share was untouchable. The lifecycle existed on the
 * server, the error message told the operator to resolve the vehicle's share
 * first, and there was nowhere to do it.
 *
 * ## What a decision means here
 *
 * The four treatments are not four buttons for one action. They differ in
 * whether money moves and where it ends up:
 *
 *  - **Back to the deal** — no cash, no revenue. The amount rejoins the
 *    quote's unallocated balance and the car is free to be allocated and sold
 *    again.
 *  - **Onto another car** — no cash. A new share opens on the receiving car;
 *    the old one stays on the record saying where the money came from.
 *  - **Refund** — real money leaves, so it asks how, and carries the approval
 *    and separation-of-duties the deposits screen carries.
 *  - **Forfeit** — the dealership keeps it, posted as such.
 */

type Treatment =
  | "RETURN_TO_UNALLOCATED"
  | "REALLOCATE_TO_VEHICLE"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED";

/**
 * The methods a refund may actually go out by — the shared control's list, not
 * the deposit's own. A deposit can be TAKEN by a payment link; it cannot be
 * paid back through one, and the server refuses a method it cannot name.
 */
type RefundMethod = PaymentMethod;

/** The two treatments that actually move money, and so are irreversible. */
const movesMoney = (treatment: Treatment) =>
  treatment === "REFUND_TO_CUSTOMER" || treatment === "FORFEITED";

export function QuoteDepositManager({
  orgId,
  quoteId,
}: {
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
}) {
  const { t, isRtl } = useLanguage();
  const { hasPermission } = usePermissions();
  // Refund and forfeiture move a customer's money and carry an approval bar the
  // server enforces. Offering them to somebody who cannot pass it turns a
  // permission into an error message.
  const canApprove = hasPermission(PERMISSIONS.APPROVE_REQUESTS);
  const allocation = useQuery(api.deposits.quoteAllocation, { orgId, quoteId });
  const releaseVehicle = useMutation(api.deposits.releaseVehicleAllocation);
  const resolveReleased = useMutation(api.deposits.resolveReleasedAllocation);

  const [busyHoldId, setBusyHoldId] = useState<string | null>(null);
  const [treatmentByHold, setTreatmentByHold] = useState<Record<string, Treatment>>({});
  const [targetByHold, setTargetByHold] = useState<Record<string, string>>({});
  const [methodByHold, setMethodByHold] = useState<Record<string, RefundMethod>>({});
  const [reasonByHold, setReasonByHold] = useState<Record<string, string>>({});

  const scale = allocation ? 10 ** allocation.scale : 1000;
  const money = useMemo(
    () => (minor: number) =>
      (minor / scale).toLocaleString(isRtl ? "ar-JO" : "en-JO", {
        maximumFractionDigits: 2,
      }),
    [scale, isRtl]
  );

  if (!allocation || allocation.totalReceivedMinor === 0) return null;

  // One row per share, carrying its own amount and status. A car can hold more
  // than one at once, and reading the vehicle's total for each of them showed
  // two shares of 1,000 and 2,000 as "3,000" twice.
  const awaiting = allocation.vehicles.flatMap((vehicle) =>
    (vehicle.awaitingDecision ?? []).map((share) => ({ vehicle, ...share }))
  );

  const handleRelease = async (vehicleId: Id<"vehicles">) => {
    setBusyHoldId(vehicleId);
    try {
      await releaseVehicle({ orgId, quoteId, vehicleId });
      toast.success(t("DepositShareReleased" as any));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusyHoldId(null);
    }
  };

  const handleResolve = async (holdId: Id<"depositVehicleHolds">) => {
    const treatment = treatmentByHold[holdId] ?? "RETURN_TO_UNALLOCATED";
    setBusyHoldId(holdId);
    try {
      await resolveReleased({
        orgId,
        holdId,
        treatment,
        ...(treatment === "REALLOCATE_TO_VEHICLE"
          ? { toVehicleId: targetByHold[holdId] as Id<"vehicles"> | undefined }
          : {}),
        ...(treatment === "REFUND_TO_CUSTOMER"
          ? { refundMethod: methodByHold[holdId] ?? "CASH" }
          : {}),
        ...(reasonByHold[holdId]?.trim() ? { reason: reasonByHold[holdId].trim() } : {}),
      });
      toast.success(t("DepositShareResolved" as any));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusyHoldId(null);
    }
  };

  return (
    <section className="space-y-5">
      {/* Where the money is. Stated as buckets rather than one net figure,
          because "5,000 held" reads the same whether 2,000 of it was refunded
          or is sitting there waiting to be allocated. */}
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <Figure label={t("DepositReceived" as any)} value={money(allocation.totalReceivedMinor)} strong />
        {allocation.allocatedMinor > 0 && (
          <Figure label={t("DepositAllocated" as any)} value={money(allocation.allocatedMinor)} />
        )}
        {allocation.appliedMinor > 0 && (
          <Figure label={t("DepositApplied" as any)} value={money(allocation.appliedMinor)} />
        )}
        {allocation.unallocatedMinor > 0 && (
          <Figure label={t("DepositUnallocated" as any)} value={money(allocation.unallocatedMinor)} />
        )}
        {allocation.releasedAwaitingDecisionMinor > 0 && (
          <Figure
            label={t("DepositAwaitingDecision" as any)}
            value={money(allocation.releasedAwaitingDecisionMinor)}
            tone="warning"
          />
        )}
        {allocation.reversingMinor > 0 && (
          <Figure label={t("DepositReversing" as any)} value={money(allocation.reversingMinor)} tone="warning" />
        )}
        {allocation.refundedMinor > 0 && (
          <Figure label={t("DepositRefunded" as any)} value={money(allocation.refundedMinor)} tone="muted" />
        )}
        {allocation.forfeitedMinor > 0 && (
          <Figure label={t("DepositForfeited" as any)} value={money(allocation.forfeitedMinor)} tone="muted" />
        )}
      </dl>

      {/* Editing the split. Unchanged from the wizard — one definition of what
          an allocation is, wherever it is made. */}
      <DepositAllocationPanel orgId={orgId} quoteId={quoteId} />

      {allocation.isMultiVehicle && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("DepositPerVehicle" as any)}
          </h4>
          <ul className="divide-y rounded-md border">
            {allocation.vehicles.map((vehicle) => (
              <li
                key={vehicle.vehicleId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
              >
                <span className="font-medium">{vehicle.label}</span>
                <span className="text-xs text-muted-foreground">
                  {vehicle.unitPrice?.toLocaleString()}
                </span>
                <span className="ms-auto tabular-nums font-semibold">
                  {vehicle.allocatedMinor === undefined
                    ? t("DepositNotAllocatedYet" as any)
                    : money(vehicle.allocatedMinor)}
                </span>
                {vehicle.status === "ALLOCATED" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busyHoldId === vehicle.vehicleId}
                    onClick={() => handleRelease(vehicle.vehicleId)}
                  >
                    <Undo2 className={cn("h-3.5 w-3.5 me-1", isRtl && "scale-x-[-1]")} aria-hidden />
                    {t("DepositTakeOffDeal" as any)}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.05] p-4 dark:bg-amber-400/[0.07]">
          <header className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <div>
              <h4 className="text-sm font-semibold">{t("DepositAwaitingDecisionTitle" as any)}</h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("DepositAwaitingDecisionDesc" as any)}
              </p>
            </div>
          </header>

          {awaiting.map(({ vehicle, holdId, amountMinor, status }) => {
            const treatment = treatmentByHold[holdId] ?? "RETURN_TO_UNALLOCATED";
            // Waiting on the ledger, not on a person. The reversing journal is
            // queued behind a closed accounting period, and until it posts the
            // original entry still stands — so the server refuses every
            // treatment, and offering them here would be an error message
            // dressed up as a choice.
            const pendingReversal = status === "REVERSING";
            return (
              <div key={holdId} className="space-y-2 rounded-md bg-background p-3">
                <p className="text-sm">
                  <span className="font-medium">{vehicle.label}</span>
                  <span className="ms-2 tabular-nums text-muted-foreground">
                    {money(amountMinor)}
                  </span>
                </p>
                {pendingReversal ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("DepositReversingPending" as any)}
                  </p>
                ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={treatment}
                    onValueChange={(value) =>
                      setTreatmentByHold((prev) => ({ ...prev, [holdId]: value as Treatment }))
                    }
                  >
                    <SelectTrigger className="h-8 w-full text-xs sm:w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="RETURN_TO_UNALLOCATED">
                        {t("DepositTreatmentReturn" as any)}
                      </SelectItem>
                      <SelectItem value="REALLOCATE_TO_VEHICLE">
                        {t("DepositTreatmentReallocate" as any)}
                      </SelectItem>
                      <SelectItem value="REFUND_TO_CUSTOMER">
                        {t("DepositTreatmentRefund" as any)}
                      </SelectItem>
                      <SelectItem value="FORFEITED">
                        {t("DepositTreatmentForfeit" as any)}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {treatment === "REALLOCATE_TO_VEHICLE" && (
                    <Select
                      value={targetByHold[holdId] ?? ""}
                      onValueChange={(value) =>
                        setTargetByHold((prev) => ({ ...prev, [holdId]: value }))
                      }
                    >
                      <SelectTrigger className="h-8 w-full text-xs sm:w-56">
                        <SelectValue placeholder={t("DepositChooseVehicle" as any)} />
                      </SelectTrigger>
                      <SelectContent>
                        {allocation.vehicles
                          .filter(
                            (other) =>
                              other.vehicleId !== vehicle.vehicleId &&
                              // A car whose share is already on its completed
                              // sale cannot take more after the fact, and the
                              // server says so — better not to offer it.
                              other.status !== "APPLIED" &&
                              other.status !== "REVERSING"
                          )
                          .map((other) => (
                            <SelectItem key={other.vehicleId} value={other.vehicleId}>
                              {other.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}

                  {treatment === "REFUND_TO_CUSTOMER" && (
                    /* The shared control, so the methods a refund may go out by
                       are listed in one place. OTHER is excluded there for the
                       reason the server rejects it: a deposit cannot be paid
                       back through a method nobody can name. */
                    <div className="w-full sm:w-40">
                      <PaymentMethodSelect
                        t={t}
                        value={methodByHold[holdId] ?? "CASH"}
                        onValueChange={(method) =>
                          setMethodByHold((prev) => ({
                            ...prev,
                            [holdId]: method as RefundMethod,
                          }))
                        }
                        ariaLabel={t("PaymentMethodLabel" as any)}
                      />
                    </div>
                  )}

                  <Input
                    className="h-8 w-full text-xs sm:w-64"
                    placeholder={t("DepositDecisionReason" as any)}
                    value={reasonByHold[holdId] ?? ""}
                    onChange={(event) =>
                      setReasonByHold((prev) => ({ ...prev, [holdId]: event.target.value }))
                    }
                  />

                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    disabled={
                      busyHoldId === holdId ||
                      (treatment === "REALLOCATE_TO_VEHICLE" && !targetByHold[holdId]) ||
                      (movesMoney(treatment) && !canApprove)
                    }
                    onClick={() => {
                      // Terminal, and one of them pays a customer. A select
                      // change and a single click should not be able to forfeit
                      // somebody's عربون by accident.
                      if (movesMoney(treatment) && !window.confirm(t("ConfirmDepositResolution" as any))) {
                        return;
                      }
                      void handleResolve(holdId as Id<"depositVehicleHolds">);
                    }}
                  >
                    {t("DepositRecordDecision" as any)}
                  </Button>
                </div>
                )}
                {movesMoney(treatment) && !canApprove && !pendingReversal && (
                  <p className="text-xs text-muted-foreground">
                    {t("DepositDecisionNeedsApproval" as any)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "warning" | "muted";
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          strong && "text-base font-semibold",
          tone === "warning" && "font-medium text-amber-700 dark:text-amber-500",
          tone === "muted" && "text-muted-foreground"
        )}
      >
        {value}
      </dd>
    </div>
  );
}
