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

  const [salaryDrafts, setSalaryDrafts] = useState<Record<string, string>>({});
  const [advUser, setAdvUser] = useState("");
  const [advAmount, setAdvAmount] = useState("");
  const [advMethod, setAdvMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [runYear, setRunYear] = useState(String(new Date().getFullYear()));
  const [runMonth, setRunMonth] = useState(String(new Date().getMonth() + 1));
  const [openRun, setOpenRun] = useState<Id<"payrollRuns"> | null>(null);

  const salaryByUser = new Map((compensation ?? []).map((c) => [c.userId, c.monthlySalary]));

  async function saveSalary(userId: string) {
    if (!activeOrgId) return;
    const value = parseFloat(salaryDrafts[userId]);
    if (isNaN(value) || value < 0) return;
    try {
      await setCompensation({ orgId: activeOrgId, userId: userId as Id<"users">, monthlySalary: value });
      toast.success(t("Saved" as any));
      setSalaryDrafts((d) => { const n = { ...d }; delete n[userId]; return n; });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitAdvance() {
    if (!activeOrgId || !advUser) return;
    const value = parseFloat(advAmount);
    if (isNaN(value) || value <= 0) return;
    try {
      await recordAdvance({ orgId: activeOrgId, userId: advUser as Id<"users">, amount: value, method: advMethod });
      toast.success(t("AdvanceRecorded" as any));
      setAdvUser(""); setAdvAmount("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function doAction(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(t(ok as any)); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
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
                <Button onClick={submitAdvance}>{t("RecordAdvance" as any)}</Button>
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
                          <Button size="sm" variant="outline" onClick={() => doAction(() => recoverAdvance({ orgId: activeOrgId!, advanceId: a._id, method: "CASH" }), "AdvanceRecovered")}>
                            {t("MarkRecovered" as any)}
                          </Button>
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
                <Button onClick={() => doAction(() => createRun({ orgId: activeOrgId!, periodYear: parseInt(runYear), periodMonth: parseInt(runMonth) }), "PayrollRunCreated")}>
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
                    <TableCell><Badge variant="outline">{t(`PayrollStatus_${r.status}` as any)}</Badge></TableCell>
                    <TableCell className="text-end space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => setOpenRun(openRun === r._id ? null : r._id)}>{t("View" as any)}</Button>
                      {canManage && r.status === "DRAFT" && (
                        <Button size="sm" variant="outline" onClick={() => doAction(() => approveRun({ orgId: activeOrgId!, runId: r._id }), "PayrollRunApproved")}>{t("Approve" as any)}</Button>
                      )}
                      {canManage && r.status === "APPROVED" && (
                        <Button size="sm" onClick={() => doAction(() => payRun({ orgId: activeOrgId!, runId: r._id, method: "BANK_TRANSFER" }), "PayrollRunPaid")}>{t("Pay" as any)}</Button>
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
