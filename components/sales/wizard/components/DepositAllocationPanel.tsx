"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check } from "lucide-react";

/**
 * Splitting one reservation deposit across the cars on a multi-vehicle quote.
 *
 * The customer paid one عربون against one receipt voucher for a deal covering
 * several cars, and each car is sold on its own sale. How much of that payment
 * belongs to each is theirs to say — 5,000 across a 3,000 car and a 20,000 car
 * might be 3,000/2,000, or 1,000/2,000 with 2,000 left unassigned. Nothing here
 * decides it for them.
 *
 * A suggestion IS offered, because typing the obvious split by hand every time
 * is a way to make people put it in the wrong box. But the suggestion fills the
 * inputs and nothing else: it becomes accounting truth only when someone
 * confirms it and the server stores it. Until then no car on the quote can be
 * sold, and the panel says so rather than letting the sale fail later with an
 * error nobody can act on.
 */
export function DepositAllocationPanel({
  orgId,
  quoteId,
}: {
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
}) {
  const { t, isRtl } = useLanguage();
  const allocation = useQuery(api.deposits.quoteAllocation, { orgId, quoteId });
  const allocate = useMutation(api.deposits.allocateToVehicles);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Seeded from the server once it answers, so the inputs show what is actually
  // stored rather than an empty form over a real allocation.
  useEffect(() => {
    if (!allocation) return;
    setDraft((current) => {
      if (Object.keys(current).length > 0) return current;
      const seeded: Record<string, string> = {};
      for (const v of allocation.vehicles) {
        // A slice already consumed by its sale, or already resolved, is not
        // editable — and including it in the draft would count it twice
        // against the deposit in the totals below.
        if (v.status !== undefined && v.status !== "ALLOCATED") continue;
        seeded[v.vehicleId] =
          v.allocatedMinor === undefined
            ? ""
            : String(v.allocatedMinor / 10 ** allocation.scale);
      }
      return seeded;
    });
  }, [allocation]);

  // Server-supplied, so the client keeps no list of three-decimal currencies.
  const scale = allocation ? 10 ** allocation.scale : 1000;

  const draftTotalMinor = useMemo(
    () =>
      Object.values(draft).reduce((sum, raw) => {
        const n = Number(raw);
        return sum + (Number.isFinite(n) && n > 0 ? Math.round(n * scale) : 0);
      }, 0),
    [draft, scale]
  );

  // Nothing renders for a single-vehicle quote: there is one place the money can
  // go and no decision to make.
  if (!allocation || !allocation.isMultiVehicle || allocation.heldTotalMinor === 0) return null;

  // Computed by the server, which owns the bucket arithmetic. A second copy of
  // it here drifts the moment a bucket is added — money mid-reversal was not in
  // the subtraction above, so a slice whose journal had not yet been backed out
  // read as available to spend.
  const available = allocation.availableForAllocationMinor;
  const remainingMinor = available - draftTotalMinor;
  const overAllocated = remainingMinor < 0;
  const money = (minor: number) =>
    (minor / scale).toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 2 });

  const suggest = () => {
    // The obvious split: fill each car up to its own price, in the order they
    // appear on the quote, until the deposit runs out. Offered as a starting
    // point precisely because it is one plausible answer among several — it is
    // filled into the inputs, not saved.
    let left = available;
    const next: Record<string, string> = {};
    // Only the cars this screen can actually set — the same predicate the seed
    // and the save use. Distributing across a car whose share is already
    // applied handed it money that Save then filtered out, so two clicks could
    // silently zero another car's agreed share while the footer read "0
    // remaining".
    for (const v of allocation.vehicles) {
      if (v.status !== undefined && v.status !== "ALLOCATED") continue;
      const priceMinor = Math.round(v.unitPrice * scale);
      const take = Math.max(0, Math.min(left, priceMinor));
      next[v.vehicleId] = String(take / scale);
      left -= take;
    }
    setDraft(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await allocate({
        orgId,
        quoteId,
        allocations: allocation.vehicles
          // Only the shares this screen can actually set. A car whose share is
          // awaiting a decision, or still mid-reversal, is rejected outright by
          // the server — so including it made editing ANY other car's share
          // fail with a message about a car the operator had not touched.
          .filter((v) => v.status === undefined || v.status === "ALLOCATED")
          .map((v) => ({
            vehicleId: v.vehicleId,
            amount: Number(draft[v.vehicleId] || 0),
          })),
      });
      toast.success(t("DepositAllocationSaved" as any));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const unallocatedCars = allocation.vehiclesWithoutAllocation.length;

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("DepositAllocation" as any)}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("DepositAllocationDesc" as any).replace("{amount}", money(allocation.heldTotalMinor))}
        </p>
      </header>

      {unallocatedCars > 0 ? (
        <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t("DepositAllocationBlocking" as any)}</span>
        </p>
      ) : null}

      <ul className="space-y-2">
        {allocation.vehicles.map((v) => (
          <li key={v.vehicleId} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{v.label}</p>
              <p className="text-xs text-muted-foreground">
                {t("QuotedAt" as any)} {v.unitPrice.toLocaleString()}
              </p>
            </div>
            {v.status !== undefined && v.status !== "ALLOCATED" ? (
              // Not editable here, and shown as such rather than as an input
              // whose value can never be saved.
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" aria-hidden />
                {money(v.allocatedMinor ?? 0)} ·{" "}
                {v.status === "APPLIED" || v.status === "RESOLVED"
                  ? t("DepositAllocationApplied" as any)
                  : t("DepositAwaitingDecision" as any)}
              </span>
            ) : (
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                aria-label={`${t("DepositAllocation" as any)} — ${v.label}`}
                className="w-32 text-end tabular-nums"
                value={draft[v.vehicleId] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [v.vehicleId]: e.target.value }))}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <p
          className={cn(
            "text-xs tabular-nums",
            overAllocated ? "font-medium text-destructive" : "text-muted-foreground"
          )}
        >
          {overAllocated
            ? t("DepositAllocationOver" as any).replace("{amount}", money(-remainingMinor))
            : t("DepositAllocationRemaining" as any).replace("{amount}", money(remainingMinor))}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={suggest}>
            {t("DepositAllocationSuggest" as any)}
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={saving || overAllocated}>
            {t("DepositAllocationSave" as any)}
          </Button>
        </div>
      </div>

      {remainingMinor > 0 && !overAllocated ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("DepositAllocationRemainderNote" as any)}
        </p>
      ) : null}
    </section>
  );
}

