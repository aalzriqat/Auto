"use client";

import { useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { toast } from "@/components/ui/sonner";
import { Plus, Trash2, CheckCircle2, XCircle, Loader2, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { manualJournalSchema, ManualJournalFormValues } from "./manualJournal.schema";

// Mirrors convex/utils/money.ts CURRENCY_SCALES — duplicated here because that
// module lives under convex/ and this is display-only decimal-place formatting,
// not a business rule (the backend independently re-derives and validates scale).
const CURRENCY_SCALES: Record<string, number> = {
  JOD: 3, KWD: 3, BHD: 3, OMR: 3,
  USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2, QAR: 2, EGP: 2,
  JPY: 0,
};
function scaleForCurrency(currency: string): number {
  return CURRENCY_SCALES[currency.toUpperCase()] ?? 2;
}

function emptyLine() {
  return { id: crypto.randomUUID(), accountId: "", side: "DEBIT" as const, amount: 0 };
}

export function ManualJournalTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [rejecting, setRejecting] = useState<{ id: Id<"manualJournalDrafts">; reason: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actingOnId, setActingOnId] = useState<Id<"manualJournalDrafts"> | null>(null);

  const me = useQuery(api.users.getMe);
  const accounts = useQuery(
    api.chartOfAccounts.list,
    activeOrgId ? { orgId: activeOrgId, activeOnly: true } : "skip"
  );
  const pending = useQuery(
    api.financialAudit.listPendingManualJournals,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const createDraft = useMutation(api.financialAudit.createManualJournal);
  const approveDraft = useMutation(api.financialAudit.approveManualJournal);
  const rejectDraft = useMutation(api.financialAudit.rejectManualJournal);

  const manualAccounts = (accounts ?? []).filter((a) => a.allowManualPosting);
  const accountOptions = manualAccounts.map((a) => ({
    value: a._id as string,
    label: a.name,
    subLabel: a.code,
  }));
  const accountsById = new Map(manualAccounts.map((a) => [a._id as string, a]));

  const form = useForm<ManualJournalFormValues>({
    resolver: zodResolver(manualJournalSchema),
    defaultValues: { memo: "", lines: [emptyLine(), emptyLine()] },
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });
  const watchLines = form.watch("lines");
  const totalDebits = watchLines.reduce((s, l) => s + (l.side === "DEBIT" ? Number(l.amount) || 0 : 0), 0);
  const totalCredits = watchLines.reduce((s, l) => s + (l.side === "CREDIT" ? Number(l.amount) || 0 : 0), 0);
  const balanced = totalDebits > 0 && Math.abs(totalDebits - totalCredits) < 1e-9;

  function resetForm() {
    form.reset({ memo: "", lines: [emptyLine(), emptyLine()] });
  }

  async function onSubmit(values: ManualJournalFormValues) {
    if (!activeOrgId) return;
    if (!balanced) {
      toast.error(t("JournalOutOfBalance"));
      return;
    }
    setIsSubmitting(true);
    try {
      await createDraft({
        orgId: activeOrgId,
        memo: values.memo,
        lines: values.lines.map((l) => ({
          accountId: l.accountId as Id<"chartOfAccounts">,
          debitMinor: l.side === "DEBIT" ? Math.round(l.amount * factor) : 0,
          creditMinor: l.side === "CREDIT" ? Math.round(l.amount * factor) : 0,
        })),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(t("ManualJournalCreated"));
      setDialogOpen(false);
      resetForm();
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleApprove(draftId: Id<"manualJournalDrafts">) {
    if (!activeOrgId) return;
    setActingOnId(draftId);
    try {
      await approveDraft({ orgId: activeOrgId, draftId });
      toast.success(t("ManualJournalApproved"));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setActingOnId(null);
    }
  }

  async function handleReject() {
    if (!activeOrgId || !rejecting) return;
    if (!rejecting.reason.trim()) {
      toast.error(t("RejectionReason"));
      return;
    }
    setActingOnId(rejecting.id);
    try {
      await rejectDraft({ orgId: activeOrgId, draftId: rejecting.id, rejectionReason: rejecting.reason });
      toast.success(t("ManualJournalRejected"));
      setRejecting(null);
    } catch (error: any) {
      toast.error(error);
    } finally {
      setActingOnId(null);
    }
  }

  if (!activeOrgId) return null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t("PendingManualJournals")}</h2>
          <p className="text-sm text-slate-500">{t("ManualJournalDesc")}</p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="w-4 h-4" />
              {t("NewManualJournal")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("NewManualJournal")}</DialogTitle>
              <DialogDescription>{t("ManualJournalDesc")}</DialogDescription>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="memo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("ManualJournalMemo")}</FormLabel>
                      <FormControl>
                        <Textarea placeholder={t("ManualJournalMemoPlaceholder")} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <FormLabel>{t("JournalLines")}</FormLabel>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      onClick={() => append(emptyLine())}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t("AddLine")}
                    </Button>
                  </div>

                  {fields.map((field, index) => (
                    <div key={field.id} className="grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-6">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.accountId`}
                          render={({ field: f }) => (
                            <FormItem>
                              <FormControl>
                                <SearchableSelect
                                  value={f.value}
                                  onValueChange={f.onChange}
                                  options={accountOptions}
                                  placeholder={t("SelectAccount")}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="col-span-3">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.side`}
                          render={({ field: f }) => (
                            <FormItem>
                              <Select value={f.value} onValueChange={f.onChange}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="DEBIT">{t("Debit")}</SelectItem>
                                  <SelectItem value="CREDIT">{t("Credit")}</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="col-span-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.amount`}
                          render={({ field: f }) => (
                            <FormItem>
                              <FormControl>
                                <Input type="number" step={String(1 / factor)} min={0} {...f} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="col-span-1 pt-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={fields.length <= 2}
                          onClick={() => remove(index)}
                        >
                          <Trash2 className="w-4 h-4 text-rose-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-100 p-3 text-sm flex-wrap gap-2">
                  <span>
                    {t("TotalDebits")}: <strong>{formatCurrency(totalDebits, scale)}</strong>
                  </span>
                  <span>
                    {t("TotalCredits")}: <strong>{formatCurrency(totalCredits, scale)}</strong>
                  </span>
                  <Badge
                    variant={balanced ? "default" : "destructive"}
                    className={balanced ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100" : ""}
                  >
                    {balanced ? t("JournalBalanced") : t("JournalOutOfBalance")}
                  </Badge>
                </div>

                <DialogFooter>
                  <Button type="submit" disabled={isSubmitting || !balanced} className="gap-2">
                    {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t("SubmitForApproval")}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {pending === undefined ? (
        <div className="flex justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : pending.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-center border rounded-xl border-dashed bg-muted/20">
          <ScrollText className="h-10 w-10 text-slate-400 mb-4 opacity-50" />
          <p className="text-slate-500">{t("NoPendingManualJournals")}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pending.map((draft) => {
            const isOwnDraft = me?._id === draft.createdBy;
            const busy = actingOnId === draft._id;
            return (
              <Card key={draft._id} className="relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-yellow-500" />
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{draft.memo}</CardTitle>
                      <CardDescription>
                        {t("SubmittedBy")}: {draft.creatorName}
                      </CardDescription>
                    </div>
                    <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20 shrink-0">
                      {t("Pending")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableBody>
                      {draft.lines.map((line, i) => {
                        const account = accountsById.get(line.accountId as string);
                        return (
                          <TableRow key={i}>
                            <TableCell className="py-1.5 text-sm">{account?.name ?? line.accountId}</TableCell>
                            <TableCell className="py-1.5 text-sm text-right">
                              {line.debitMinor > 0 ? formatCurrency(line.debitMinor / factor, scale) : ""}
                            </TableCell>
                            <TableCell className="py-1.5 text-sm text-right">
                              {line.creditMinor > 0 ? formatCurrency(line.creditMinor / factor, scale) : ""}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>

                  {isOwnDraft && (
                    <p className="text-xs text-amber-600 mt-3">{t("SegregationOfDutiesNotice")}</p>
                  )}

                  <div className="flex gap-2 w-full pt-4 mt-2 border-t">
                    <Button
                      variant="outline"
                      className="flex-1 bg-red-50 hover:bg-red-100 hover:text-red-600 border-red-200 text-red-600"
                      disabled={isOwnDraft || busy}
                      onClick={() => setRejecting({ id: draft._id, reason: "" })}
                    >
                      <XCircle className="w-4 h-4 me-2" />
                      {t("Reject")}
                    </Button>
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={isOwnDraft || busy}
                      onClick={() => handleApprove(draft._id)}
                    >
                      {busy ? (
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 me-2" />
                      )}
                      {t("Approve")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!rejecting} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Reject")}</DialogTitle>
            <DialogDescription>{t("RejectionReason")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejecting?.reason ?? ""}
            onChange={(e) => setRejecting((r) => (r ? { ...r, reason: e.target.value } : r))}
            placeholder={t("RejectionReasonPlaceholder")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={actingOnId === rejecting?.id}>
              {t("Reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
