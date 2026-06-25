"use client";

import { useMemo, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2, Users, ArrowRight } from "lucide-react";

interface MergeCustomersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FIELD_KEYS = ["firstName", "lastName", "phone", "whatsapp", "email", "nationalId", "address"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

export function MergeCustomersDialog({ open, onOpenChange }: MergeCustomersDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const candidates = useQuery(api.customers.findMergeCandidates, activeOrgId && open ? { orgId: activeOrgId } : "skip");
  const { results: allCustomers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId && open ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 200 }
  );

  const [survivorId, setSurvivorId] = useState<string>("");
  const [loserId, setLoserId] = useState<string>("");
  const [fieldOverrides, setFieldOverrides] = useState<Partial<Record<FieldKey, string>>>({});
  const [isMerging, setIsMerging] = useState(false);

  const preview = useQuery(
    api.customers.previewMerge,
    activeOrgId && survivorId && loserId
      ? { orgId: activeOrgId, survivorId: survivorId as Id<"customers">, loserId: loserId as Id<"customers"> }
      : "skip"
  );

  const mergeCustomers = useMutation(api.customers.mergeCustomers);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSurvivorId("");
      setLoserId("");
      setFieldOverrides({});
    }
    onOpenChange(next);
  };

  const customerOptions = useMemo(
    () =>
      (allCustomers ?? []).map((c) => ({
        value: c._id,
        label: `${c.firstName} ${c.lastName}`,
        subLabel: c.phone || c.email || undefined,
      })),
    [allCustomers]
  );

  const survivor = preview?.survivor;
  const loser = preview?.loser;

  const handlePickPair = (aId: string, bId: string) => {
    setSurvivorId(aId);
    setLoserId(bId);
    setFieldOverrides({});
  };

  const handleMerge = async () => {
    if (!activeOrgId || !survivorId || !loserId) return;
    setIsMerging(true);
    try {
      await mergeCustomers({
        orgId: activeOrgId,
        survivorId: survivorId as Id<"customers">,
        loserId: loserId as Id<"customers">,
        fieldOverrides: Object.keys(fieldOverrides).length > 0 ? fieldOverrides : undefined,
      });
      toast.success(t("CustomersMergedSuccess" as any) || "Customers merged successfully.");
      handleOpenChange(false);
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsMerging(false);
    }
  };

  const totalReassigned = preview
    ? Object.values(preview.reassignedCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("MergeDuplicateCustomers" as any) || "Merge Duplicate Customers"}</DialogTitle>
          <DialogDescription>
            {t("MergeCustomersDesc" as any) ||
              "Combine two customer records into one. The merged-away record is soft-deleted and recoverable."}
          </DialogDescription>
        </DialogHeader>

        {!survivorId || !loserId ? (
          <div className="space-y-4">
            {candidates && candidates.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("PossibleDuplicates" as any) || "Possible duplicates"}</p>
                {candidates.map((group, i) => (
                  <div key={i} className="rounded-md border p-3 space-y-2">
                    <p className="text-sm font-semibold flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      {group.firstName} {group.lastName}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {group.customers.map((c) => (
                        <span key={c._id} className="text-xs rounded-full border px-2 py-1 text-muted-foreground">
                          {c.phone || c.email || t("NoContactInfo" as any) || "No contact info"}
                        </span>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handlePickPair(group.customers[0]._id, group.customers[1]._id)}
                    >
                      {t("ReviewThisPair" as any) || "Review this pair"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {candidates && candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("NoDuplicateCandidates" as any) || "No likely duplicates found by name. You can still pick any two customers below."}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("KeepThisCustomer" as any) || "Keep (survivor)"}</p>
                <SearchableSelect
                  value={survivorId}
                  onValueChange={setSurvivorId}
                  options={customerOptions.filter((o) => o.value !== loserId)}
                  placeholder={t("SelectCustomer" as any) || "Select a customer"}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("MergeAwayThisCustomer" as any) || "Merge away"}</p>
                <SearchableSelect
                  value={loserId}
                  onValueChange={setLoserId}
                  options={customerOptions.filter((o) => o.value !== survivorId)}
                  placeholder={t("SelectCustomer" as any) || "Select a customer"}
                />
              </div>
            </div>
          </div>
        ) : !preview ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={() => { setSurvivorId(""); setLoserId(""); }}>
                {t("Back" as any) || "Back"}
              </Button>
            </div>

            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50">
                    <th className="text-start p-2 font-medium">{t("Field" as any) || "Field"}</th>
                    <th className="text-start p-2 font-medium text-green-700">{t("Survivor" as any) || `Keep: ${survivor!.firstName} ${survivor!.lastName}`}</th>
                    <th className="text-start p-2 font-medium text-muted-foreground">{t("MergedAway" as any) || `Merging away: ${loser!.firstName} ${loser!.lastName}`}</th>
                  </tr>
                </thead>
                <tbody>
                  {FIELD_KEYS.map((key) => {
                    const survivorValue = (survivor as any)[key] as string | undefined;
                    const loserValue = (loser as any)[key] as string | undefined;
                    if (!survivorValue && !loserValue) return null;
                    const selected = fieldOverrides[key] ?? (survivorValue || loserValue || "");
                    return (
                      <tr key={key} className="border-t">
                        <td className="p-2 text-muted-foreground capitalize">{key}</td>
                        <td className="p-2">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name={`field-${key}`}
                              checked={selected === (survivorValue || "")}
                              disabled={!survivorValue}
                              onChange={() => setFieldOverrides((prev) => ({ ...prev, [key]: survivorValue || "" }))}
                            />
                            <span className={!survivorValue ? "text-muted-foreground italic" : ""}>
                              {survivorValue || (t("Empty" as any) || "(empty)")}
                            </span>
                          </label>
                        </td>
                        <td className="p-2">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name={`field-${key}`}
                              checked={selected === (loserValue || "")}
                              disabled={!loserValue}
                              onChange={() => setFieldOverrides((prev) => ({ ...prev, [key]: loserValue || "" }))}
                            />
                            <span className={!loserValue ? "text-muted-foreground italic" : ""}>
                              {loserValue || (t("Empty" as any) || "(empty)")}
                            </span>
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              {totalReassigned > 0 ? (
                <>
                  <p className="font-medium mb-1">
                    {t("WillBeReassigned" as any) || "The following records will be reassigned to the surviving customer:"}
                  </p>
                  <ul className="list-disc ps-5 space-y-0.5">
                    {Object.entries(preview.reassignedCounts)
                      .filter(([, count]) => count > 0)
                      .map(([table, count]) => (
                        <li key={table}>
                          {count} {table}
                        </li>
                      ))}
                  </ul>
                </>
              ) : (
                <p>{t("NoLinkedRecords" as any) || "No linked records to reassign — this customer has no leads, sales, or other history."}</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t("Cancel" as any) || "Cancel"}
          </Button>
          {survivorId && loserId && preview && (
            <Button variant="destructive" onClick={handleMerge} disabled={isMerging}>
              {isMerging ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <ArrowRight className="h-4 w-4 me-2" />}
              {t("ConfirmMerge" as any) || "Confirm Merge"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
