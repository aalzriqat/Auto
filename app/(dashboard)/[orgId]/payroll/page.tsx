"use client";

import { useState } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Wallet, Coins, CalendarClock } from "lucide-react";

const METHODS = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"] as const;

export default function PayrollPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format } = useCurrency();

  const canManage =
    useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip")
      ?.permissions.includes("manage:payroll") ?? false;

  const { results: members } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const compensation = useQuery(api.payroll.listCompensation, activeOrgId ? { orgId: activeOrgId } : "skip");
  const advances = useQuery(api.payroll.listAdvances, activeOrgId ? { orgId: activeOrgId } : "skip");
  const runs = useQuery(api.payroll.listRuns, activeOrgId ? { orgId: activeOrgId } : "skip");

  const setCompensation = useMutation(api.payroll.setCompensation);
  const recordAdvance = useMutation(api.payroll.recordAdvance);
  const recoverAdvance = useMutation(api.payroll.recoverAdvance);
  const createRun = useMutation(api.payroll.createRun);
  const approveRun = useMutation(api.payroll.approveRun);
  const payRun = useMutation(api.payroll.payRun);
  const cancelRun = useMutation(api.payroll.cancelRun);

  const [salaryDrafts, setSalaryDrafts] = useState<Record<string, string>>({});
  const [advUser, setAdvUser] = useState("");
  const [advAmount, setAdvAmount] = useState("");
  const [advMethod, setAdvMethod] = useState<(typeof METHODS)[number]>("CASH");
  // Locks the "Record advance" button while a disbursement is in flight.
  const [submittingAdvance, setSubmittingAdvance] = useState(false);
  // How the money actually moved — advance recoveries and payroll payments hit
  // different GL cash accounts depending on the method, so neither is hardcoded.
  // Per-advance so changing one row's method never silently changes another's.
  const [recoverMethods, setRecoverMethods] = useState<Record<string, (typeof METHODS)[number]>>({});
  // Per-advance partial repayment amount (blank = recover the full balance).
  const [recoverAmounts, setRecoverAmounts] = useState<Record<string, string>>({});
  // Advances with a repayment in flight — the row's button is disabled so a
  // double-click can't book a second partial recovery against the re-read balance.
  const [recoveringIds, setRecoveringIds] = useState<Set<string>>(new Set());
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]>("BANK_TRANSFER");
  const [runYear, setRunYear] = useState(String(new Date().getFullYear()));
  const [runMonth, setRunMonth] = useState(String(new Date().getMonth() + 1));
  const [openRun, setOpenRun] = useState<Id<"payrollRuns"> | null>(null);

  const salaryByUser = new Map((compensation ?? []).map((c) => [c.userId, c.monthlySalary]));

  async function saveSalary(userId: string) {
    if (!activeOrgId) return;
    const value = Number.parseFloat(salaryDrafts[userId]);
    if (Number.isNaN(value) || value < 0) return;
    try {
      await setCompensation({ orgId: activeOrgId, userId: userId as Id<"users">, monthlySalary: value });
      toast.success(t("Saved" as any));
      setSalaryDrafts((d) => { const n = { ...d }; delete n[userId]; return n; });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitAdvance() {
    if (!activeOrgId || !advUser || submittingAdvance) return;
    const value = Number.parseFloat(advAmount);
    if (Number.isNaN(value) || value <= 0) return;
    // Issuing an advance disburses cash — an idempotency key + in-flight lock
    // prevent a double-click or retry from booking (and paying out) it twice.
    const idempotencyKey = crypto.randomUUID();
    setSubmittingAdvance(true);
    try {
      await recordAdvance({ orgId: activeOrgId, userId: advUser as Id<"users">, amount: value, method: advMethod, idempotencyKey });
      toast.success(t("AdvanceRecorded" as any));
      setAdvUser(""); setAdvAmount("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingAdvance(false);
    }
  }

  async function doRecover(advanceId: string) {
    if (!activeOrgId || recoveringIds.has(advanceId)) return;
    const raw = (recoverAmounts[advanceId] ?? "").trim();
    // Blank = recover the full outstanding balance. A NON-blank entry must be a
    // valid positive number — an invalid/zero/negative value is a mistake and
    // must be rejected, NOT silently coerced into a full repayment.
    let amount: number | undefined;
    if (raw !== "") {
      const parsed = Number.parseFloat(raw);
      if (Number.isNaN(parsed) || parsed <= 0) {
        toast.error(t("InvalidRepaymentAmount" as any));
        return;
      }
      amount = parsed;
    }
    const method = recoverMethods[advanceId] ?? "CASH";
    // Stable key for THIS submission so an automatic network retry dedupes
    // server-side; a fresh submission after success gets a fresh key.
    const idempotencyKey = crypto.randomUUID();
    setRecoveringIds((s) => new Set(s).add(advanceId));
    try {
      await recoverAdvance({ orgId: activeOrgId, advanceId: advanceId as Id<"employeeAdvances">, method, amount, idempotencyKey });
      toast.success(t("AdvanceRecovered" as any));
      setRecoverAmounts((m) => { const n = { ...m }; delete n[advanceId]; return n; });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRecoveringIds((s) => { const n = new Set(s); n.delete(advanceId); return n; });
    }
  }

  async function doAction(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(t(ok as any)); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  }

  async function payRunHandler(runId: Id<"payrollRuns">) {
    if (!activeOrgId) return;
    try {
      const res = await payRun({ orgId: activeOrgId, runId, method: payMethod });
      // Payment recomputes from live state; if a payslip drifted from the
      // approved amount the run is sent back for re-approval instead of paying.
      if (res?.status === "NEEDS_REAPPROVAL") {
        toast.error(t("PayrollNeedsReapproval" as any));
      } else {
        toast.success(t("PayrollRunPaid" as any));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const runItems = useQuery(
    api.payroll.listRunItems,
    activeOrgId && openRun ? { orgId: activeOrgId, runId: openRun } : "skip"
  );

  return (
    <RoleGuard permissions={["view:payroll"]}>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Wallet className="h-6 w-6" /> {t("Payroll" as any)}
        </h1>

        {/* Compensation */}
        <Card>
          <CardHeader><CardTitle className="text-base">{t("MonthlySalaries" as any)}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("TeamMember" as any)}</TableHead>
                  <TableHead className="text-end">{t("MonthlySalary" as any)}</TableHead>
                  {canManage && <TableHead className="text-end">{t("Actions" as any)}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(members ?? []).map((m) => (
                  <TableRow key={m.userId}>
                    <TableCell className="font-medium">{m.userName}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {canManage ? (
                        <Input
                          type="number" min="0" className="h-8 w-32 text-end inline-block"
                          placeholder={String(salaryByUser.get(m.userId) ?? 0)}
                          value={salaryDrafts[m.userId] ?? ""}
                          onChange={(e) => setSalaryDrafts((d) => ({ ...d, [m.userId]: e.target.value }))}
                        />
                      ) : (
                        format(salaryByUser.get(m.userId) ?? 0)
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-end">
                        <Button size="sm" variant="outline" disabled={salaryDrafts[m.userId] == null} onClick={() => saveSalary(m.userId)}>
                          {t("Save" as any)}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Advances */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Coins className="h-4 w-4" />{t("SalaryAdvances" as any)}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {canManage && (
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("TeamMember" as any)}</Label>
                  <SearchableSelect
                    value={advUser} onValueChange={setAdvUser} className="w-48"
                    placeholder={t("SelectTeamMember" as any)}
                    options={(members ?? []).map((m) => ({ value: m.userId, label: m.userName }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("Amount" as any)}</Label>
                  <Input type="number" min="0" className="h-9 w-28" value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("PaymentMethodLabel" as any)}</Label>
                  <Select value={advMethod} onValueChange={(v) => setAdvMethod(v as (typeof METHODS)[number])}>
                    <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {METHODS.map((mth) => <SelectItem key={mth} value={mth}>{t(`PaymentMethod_${mth}` as any)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={submitAdvance} disabled={submittingAdvance}>{t("RecordAdvance" as any)}</Button>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("TeamMember" as any)}</TableHead>
                  <TableHead className="text-end">{t("Amount" as any)}</TableHead>
                  <TableHead className="text-end">{t("Outstanding" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  {canManage && <TableHead className="text-end">{t("Actions" as any)}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(advances ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">{t("NoAdvances" as any)}</TableCell></TableRow>
                ) : (advances ?? []).map((a) => (
                  <TableRow key={a._id}>
                    <TableCell>{a.userName}</TableCell>
                    <TableCell className="text-end tabular-nums">{format(a.amount)}</TableCell>
                    <TableCell className="text-end tabular-nums">{format(a.outstanding)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={a.status === "OUTSTANDING" ? "text-orange-600 border-orange-300" : "text-green-600 border-green-300"}>
                        {t(`AdvanceStatus_${a.status}` as any)}
                      </Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-end">
                        {a.status === "OUTSTANDING" && (
                          <div className="inline-flex items-center gap-1.5">
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder={t("FullAmount" as any)}
                              value={recoverAmounts[a._id] ?? ""}
                              onChange={(e) => setRecoverAmounts((m) => ({ ...m, [a._id]: e.target.value }))}
                              disabled={recoveringIds.has(a._id)}
                              className="h-8 w-24 text-end"
                              title={t("PartialRepaymentHint" as any)}
                            />
                            <Select
                              value={recoverMethods[a._id] ?? "CASH"}
                              onValueChange={(v) => setRecoverMethods((m) => ({ ...m, [a._id]: v as (typeof METHODS)[number] }))}
                            >
                              <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {METHODS.map((mth) => <SelectItem key={mth} value={mth}>{t(`PaymentMethod_${mth}` as any)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={recoveringIds.has(a._id)}
                              onClick={() => doRecover(a._id)}
                            >
                              {t("MarkRecovered" as any)}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Runs */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><CalendarClock className="h-4 w-4" />{t("PayrollRuns" as any)}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {canManage && (
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("Year" as any)}</Label>
                  <Input type="number" className="h-9 w-24" value={runYear} onChange={(e) => setRunYear(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("Month" as any)}</Label>
                  <Input type="number" min="1" max="12" className="h-9 w-20" value={runMonth} onChange={(e) => setRunMonth(e.target.value)} />
                </div>
                <Button onClick={() => doAction(() => createRun({ orgId: activeOrgId!, periodYear: Number.parseInt(runYear, 10), periodMonth: Number.parseInt(runMonth, 10) }), "PayrollRunCreated")}>
                  {t("CreateRun" as any)}
                </Button>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Period" as any)}</TableHead>
                  <TableHead className="text-end">{t("Gross" as any)}</TableHead>
                  <TableHead className="text-end">{t("Net" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead className="text-end">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">{t("NoPayrollRuns" as any)}</TableCell></TableRow>
                ) : (runs ?? []).map((r) => (
                  <TableRow key={r._id}>
                    <TableCell className="font-medium">{r.periodMonth}/{r.periodYear}</TableCell>
                    <TableCell className="text-end tabular-nums">{format(r.totalGross)}</TableCell>
                    <TableCell className="text-end tabular-nums">{format(r.totalNet)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={r.status === "NEEDS_REAPPROVAL" ? "text-orange-600 border-orange-300" : undefined}>
                        {t(`PayrollStatus_${r.status}` as any)}
                      </Badge>
                      {r.status === "NEEDS_REAPPROVAL" && r.reapprovalReason && (
                        <p className="mt-1 text-xs text-muted-foreground max-w-[16rem]">{r.reapprovalReason}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-end space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => setOpenRun(openRun === r._id ? null : r._id)}>{t("View" as any)}</Button>
                      {canManage && r.status === "DRAFT" && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => doAction(() => approveRun({ orgId: activeOrgId!, runId: r._id }), "PayrollRunApproved")}>{t("Approve" as any)}</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => doAction(() => cancelRun({ orgId: activeOrgId!, runId: r._id }), "PayrollRunCancelled")}>{t("CancelRun" as any)}</Button>
                        </>
                      )}
                      {canManage && r.status === "NEEDS_REAPPROVAL" && (
                        <Button size="sm" variant="outline" onClick={() => doAction(() => approveRun({ orgId: activeOrgId!, runId: r._id }), "PayrollRunApproved")}>{t("Reapprove" as any)}</Button>
                      )}
                      {canManage && r.status === "APPROVED" && (
                        <div className="inline-flex items-center gap-1.5">
                          <Select value={payMethod} onValueChange={(v) => setPayMethod(v as (typeof METHODS)[number])}>
                            <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {METHODS.map((mth) => <SelectItem key={mth} value={mth}>{t(`PaymentMethod_${mth}` as any)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Button size="sm" onClick={() => payRunHandler(r._id)}>{t("Pay" as any)}</Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {openRun && (
              <div className="rounded-md border p-3">
                <p className="text-sm font-medium mb-2">{t("Payslips" as any)}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("TeamMember" as any)}</TableHead>
                      <TableHead className="text-end">{t("Salary" as any)}</TableHead>
                      <TableHead className="text-end">{t("Commission" as any)}</TableHead>
                      <TableHead className="text-end">{t("AdvanceDeduction" as any)}</TableHead>
                      <TableHead className="text-end">{t("Net" as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runItems ?? []).map((i) => (
                      <TableRow key={i._id}>
                        <TableCell>{i.userName}</TableCell>
                        <TableCell className="text-end tabular-nums">{format(i.baseSalary)}</TableCell>
                        <TableCell className="text-end tabular-nums">{format(i.commission)}</TableCell>
                        <TableCell className="text-end tabular-nums">-{format(i.advanceDeduction)}</TableCell>
                        <TableCell className="text-end tabular-nums font-semibold">{format(i.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </RoleGuard>
  );
}
