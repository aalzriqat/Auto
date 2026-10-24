"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { scaleForCurrency } from "@/convex/utils/money";
import { parseOpeningMoneyMinor } from "./setup/openingMoneyInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const copy = {
  en: { title: "Management opening settlement", boundary: "Management reconciliation only. This does not post expenses, change capital or cash, or enable profit distribution.",
    amount: "Agreed total", month: "First effective month", reference: "Supporting reference", attest: "These costs were consumed before opening and are neither prepaid assets nor partner capital.",
    prepare: "Prepare for a different approver", approve: "Approve fixed schedule", reject: "Reject draft", pending: "Pending a different finance approver", unavailable: "A posted opening and supported currency are required.",
    loading: "Loading management schedules…", invalid: "Enter a positive exact amount, month, reference and classification attestation.", failed: "The management schedule could not be saved. Refresh the supporting data and try again.",
    official: "Native GL net income", adjustment: "Management adjustment recognised", management: "Management distributable profit", scheduled: "Scheduled", recognised: "Recognised", asOf: "As of", effective: "Effective month", recognition: "Recognition month", noPlan: "No management schedule is approved." },
  ar: { title: "التسوية الإدارية الافتتاحية", boundary: "مطابقة إدارية فقط. لا تُسجل مصروفات ولا تُغير رأس المال أو النقد ولا تُفعّل توزيع الأرباح.",
    amount: "الإجمالي المتفق عليه", month: "أول شهر سريان", reference: "المرجع المؤيد", attest: "استهلكت هذه التكاليف قبل الافتتاح وليست أصولاً مدفوعة مقدماً ولا رأس مال للشركاء.",
    prepare: "إعداد لمراجع آخر", approve: "اعتماد الجدول الثابت", reject: "رفض المسودة", pending: "بانتظار مراجع مالي آخر", unavailable: "يلزم افتتاح مُرحّل وعملة مدعومة.",
    loading: "جارٍ تحميل الجداول الإدارية…", invalid: "أدخل مبلغاً دقيقاً موجباً وشهراً ومرجعاً وإقرار التصنيف.", failed: "تعذر حفظ الجدول الإداري. حدّث البيانات المؤيدة ثم أعد المحاولة.",
    official: "صافي دخل دفتر الأستاذ", adjustment: "التسوية الإدارية المعترف بها", management: "الربح الإداري القابل للتوزيع", scheduled: "مجدول", recognised: "معترف به", asOf: "حتى تاريخ", effective: "شهر السريان", recognition: "شهر الاعتراف", noPlan: "لا يوجد جدول إداري معتمد." },
};

export function OpeningManagementSettlementPanel({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { locale } = useLanguage();
  const text = copy[locale];
  const { hasPermission } = usePermissions();
  const canView = hasPermission(PERMISSIONS.VIEW_FINANCE);
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const context = useQuery(api.openingManagementSettlement.context, canView ? { orgId } : "skip");
  const plans = useQuery(api.openingManagementSettlement.list, canView ? { orgId } : "skip");
  const prepare = useMutation(api.openingManagementSettlement.draft);
  const approve = useMutation(api.openingManagementSettlement.approve);
  const reject = useMutation(api.openingManagementSettlement.reject);
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState("");
  const [reference, setReference] = useState("");
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useRef<string | null>(null);
  if (!canView) return null;
  if (!context || !plans) return <p role="status">{text.loading}</p>;
  const opening = context.postedOpening;
  const active = plans.find((plan) => plan.status !== "REJECTED");
  const currency = opening?.currency;

  async function submit() {
    const totalMinor = currency ? parseOpeningMoneyMinor(amount, currency) : null;
    const firstEffectiveMonth = Date.parse(`${month}-01T00:00:00.000Z`);
    if (!opening || !currency || totalMinor === null || totalMinor <= 0 || !Number.isSafeInteger(firstEffectiveMonth) || !reference.trim() || !attested) {
      setError(text.invalid); return;
    }
    setBusy(true); setError("");
    command.current ??= `opening-management:${crypto.randomUUID()}`;
    try {
      await prepare({ orgId, openingDraftId: opening.id, totalMinor, firstEffectiveMonth,
        supportingReference: reference, classificationAttestation: "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL",
        expectedCurrency: currency, idempotencyKey: command.current });
      command.current = null;
    } catch { setError(text.failed); }
    finally { setBusy(false); }
  }

  async function decide(planId: Id<"openingManagementSettlementPlans">, accepted: boolean) {
    setBusy(true); setError("");
    try {
      if (accepted) await approve({ orgId, planId });
      else await reject({ orgId, planId });
    }
    catch { setError(text.failed); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-lg border p-4" aria-label={text.title}>
    <h3 className="font-semibold">{text.title}</h3><p className="text-sm text-muted-foreground">{text.boundary}</p>
    {error && <p role="alert">{error}</p>}
    {active?.status === "APPROVED" && <ManagementReport orgId={orgId} planId={active._id} />}
    {!active && <p>{text.noPlan}</p>}
    {active?.status === "PENDING_APPROVAL" && <div className="space-y-2">
      <p>{text.pending}</p><p>{active.supportingReference} · {new Intl.NumberFormat(locale, { style: "currency", currency: active.currency }).format(active.totalMinor / 10 ** scaleForCurrency(active.currency))}</p>
      <ul>{active.installments.map((row) => <li key={row.sequence}>{new Date(row.effectiveMonth).toLocaleDateString(locale, { timeZone: "UTC" })} · {new Intl.NumberFormat(locale, { style: "currency", currency: active.currency }).format(row.amountMinor / 10 ** scaleForCurrency(active.currency))}</li>)}</ul>
      {canManage && <div className="flex gap-2">
        <Button disabled={busy || active.createdBy === context.actorId} onClick={() => void decide(active._id, true)}>{text.approve}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide(active._id, false)}>{text.reject}</Button>
      </div>}
    </div>}
    {canManage && !active && (!opening || !currency ? <p role="status">{text.unavailable}</p> :
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label>{text.amount} ({currency})<Input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); command.current = null; }} /></label>
        <label>{text.month}<Input type="month" value={month} onChange={(event) => { setMonth(event.target.value); command.current = null; }} /></label>
        <label>{text.reference}<Input maxLength={200} value={reference} onChange={(event) => { setReference(event.target.value); command.current = null; }} /></label>
        <label className="flex gap-2"><input type="checkbox" checked={attested} onChange={(event) => { setAttested(event.target.checked); command.current = null; }} />{text.attest}</label>
        <Button disabled={busy} type="submit">{text.prepare}</Button>
      </form>)}
  </section>;
}

function ManagementReport({ orgId, planId }: Readonly<{ orgId: Id<"organizations">; planId: Id<"openingManagementSettlementPlans"> }>) {
  const { locale } = useLanguage();
  const text = copy[locale];
  const [throughDate] = useState(() => Date.now());
  const report = useQuery(api.openingManagementSettlement.report, { orgId, planId, throughDate });
  if (!report) return <p role="status">{text.loading}</p>;
  const factor = 10 ** scaleForCurrency(report.currency);
  const money = (minor: number) => new Intl.NumberFormat(locale, { style: "currency", currency: report.currency }).format(minor / factor);
  const date = (timestamp: number) => new Date(timestamp).toLocaleDateString(locale, { timeZone: "UTC" });
  return <div className="space-y-2">
    <p>{text.asOf}: {date(report.throughDate)}</p>
    <dl className="grid gap-1"><dt>{text.official}</dt><dd>{money(report.officialNetIncomeMinor)}</dd>
      <dt>{text.adjustment}</dt><dd>{money(report.recognisedMinor)}</dd><dt>{text.management}</dt><dd>{money(report.managementProfitMinor)}</dd></dl>
    <ul>{report.installments.map((row) => <li key={row.sequence}>{text.effective}: {date(row.effectiveMonth)} · {text.recognition}: {date(row.recognitionMonth)} · {money(row.amountMinor)} · {row.recognition === "RECOGNISED" ? text.recognised : text.scheduled}</li>)}</ul>
  </div>;
}
