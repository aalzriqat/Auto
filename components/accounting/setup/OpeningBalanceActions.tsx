"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage } from "@/lib/errors";
import { formatExactMinorAmount } from "@/lib/moneyDisplay";

export function OpeningVoidActions({ orgId, maintenance }: Readonly<{
  orgId: Id<"organizations">;
  maintenance: FunctionReturnType<typeof api.openingBalanceMaintenance.status>;
}>) {
  const { t, locale } = useLanguage();
  const requestVoid = useMutation(api.openingBalanceMaintenance.requestVoid);
  const approveVoid = useMutation(api.openingBalanceMaintenance.approveVoid);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submitVoid() {
    if (!maintenance.postedDraftId) return;
    if (maintenance.canApproveVoid && !window.confirm(t("OpeningVoidConfirm"))) return;
    setBusy(true);
    try {
      const payload = { orgId, draftId: maintenance.postedDraftId };
      if (maintenance.canApproveVoid) {
        await approveVoid(payload);
        toast.success(t("OpeningVoided"));
      } else {
        await requestVoid({ ...payload, reason });
        toast.success(t("OpeningVoidRequested"));
      }
    } catch (error) { toast.error(getLocalizedErrorMessage(error, t)); }
    finally { setBusy(false); }
  }
  if (!maintenance.canRequestVoid && !maintenance.canApproveVoid && !maintenance.voidReason) return null;
  return <section dir={locale === "ar" ? "rtl" : "ltr"} className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm">
    <p className="max-w-sm text-muted-foreground">{t("OpeningVoidNote")}</p>
    {maintenance.voidReason && <p className="max-w-sm break-words"><bdi>{maintenance.voidReason}</bdi></p>}
    {maintenance.canRequestVoid && <div className="space-y-1">
      <Label htmlFor="opening-void-reason">{t("OpeningVoidReason")}</Label>
      <Input id="opening-void-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
    </div>}
    {(maintenance.canRequestVoid || maintenance.canApproveVoid) && <Button variant="outline" size="sm" disabled={busy || (maintenance.canRequestVoid && !reason.trim())} onClick={() => void submitVoid()}>
      {maintenance.canApproveVoid ? t("OpeningApproveVoid") : t("OpeningRequestVoid")}
    </Button>}
  </section>;
}

type OpeningSuspenseClassification = NonNullable<
  FunctionReturnType<typeof api.openingBalanceMaintenance.status>["suspenseClassification"]
>;

export function OpeningSuspenseActions({ orgId, classification }: Readonly<{
  orgId: Id<"organizations">;
  classification: OpeningSuspenseClassification;
}>) {
  const { t, locale } = useLanguage();
  const request = useMutation(api.openingBalanceMaintenance.requestSuspenseClassification);
  const approve = useMutation(api.openingBalanceMaintenance.approveSuspenseClassification);
  const dismiss = useMutation(api.openingBalanceMaintenance.dismissSuspenseClassification);
  const [accountId, setAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { currency, pending, signedBalanceMinor, targets } = classification;
  const selected = targets.find(account => account.accountId === accountId);
  const accountLabel = (account: OpeningSuspenseClassification["targets"][number]) =>
    `${account.code} — ${locale === "ar" ? account.nameAr || account.name : account.name}`;
  const payload = { orgId, draftId: classification.draftId };

  async function submitRequest() {
    if (!selected) return;
    setBusy(true);
    try {
      await request({ ...payload, accountId: selected.accountId, reason });
      setReason("");
      setAccountId("");
      toast.success(t("OpeningSuspenseRequested"));
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function decide(accept: boolean) {
    if (!pending) return;
    setBusy(true);
    const decision = { ...payload, expectedVersion: pending.version };
    try {
      if (accept) await approve(decision);
      else await dismiss(decision);
      toast.success(t(accept ? "OpeningSuspenseApproved" : "OpeningSuspenseDismissed"));
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  return <section dir={locale === "ar" ? "rtl" : "ltr"} className="w-full min-w-0 space-y-3 rounded-md border border-border p-3 text-sm">
    <div className="space-y-1">
      <h4 className="font-medium">{t("OpeningSuspenseTitle")}</h4>
      <p className="text-muted-foreground">
        {t(signedBalanceMinor < 0 ? "OpeningSuspenseCredit" : "OpeningSuspenseDebit")}{" "}
        <bdi>{formatExactMinorAmount(Math.abs(signedBalanceMinor), currency)} {currency}</bdi>
      </p>
    </div>
    {pending ? (
      <div className="space-y-2">
        <p>{t("OpeningSuspensePending")}</p>
        {pending.target && <p><bdi>{accountLabel(pending.target)}</bdi></p>}
        <p className="break-words"><bdi>{pending.reason}</bdi></p>
        <div className="flex flex-wrap gap-2">
          {pending.canApprove && <Button size="sm" disabled={busy} onClick={() => void decide(true)}>{t("OpeningSuspenseApprove")}</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>{t("OpeningSuspenseDismiss")}</Button>
        </div>
      </div>
    ) : targets.length > 0 ? (
      <div className="grid max-w-lg gap-2">
        <Label htmlFor="opening-suspense-account">{t("OpeningSuspenseTarget")}</Label>
        <Select value={accountId} onValueChange={setAccountId} disabled={busy}>
          <SelectTrigger id="opening-suspense-account"><SelectValue placeholder={t("OpeningSuspenseTarget")} /></SelectTrigger>
          <SelectContent>
            {targets.map(account => <SelectItem key={account.accountId} value={account.accountId}>{accountLabel(account)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Label htmlFor="opening-suspense-reason">{t("OpeningSuspenseReason")}</Label>
        <Input id="opening-suspense-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
        <Button className="justify-self-start" size="sm" disabled={busy || !selected || !reason.trim()} onClick={() => void submitRequest()}>
          {t("OpeningSuspenseRequest")}
        </Button>
      </div>
    ) : <p className="text-muted-foreground">{t("OpeningSuspenseNoTarget")}</p>}
  </section>;
}
