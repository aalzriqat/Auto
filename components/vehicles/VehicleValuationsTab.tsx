import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { toast } from "sonner";

export function VehicleValuationsTab({ vehicleId }: { vehicleId: Id<"vehicles"> }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const valuations = useQuery(api.finance.listValuations, activeOrgId ? { orgId: activeOrgId, vehicleId } : "skip");
  const companies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");
  const saveValuation = useMutation(api.finance.saveValuation);

  const [companyId, setCompanyId] = useState<string>("");
  const [valuationAmount, setValuationAmount] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = async () => {
    if (!activeOrgId || !companyId || valuationAmount <= 0) {
      toast.error("Please select a company and enter a valid amount.");
      return;
    }

    setIsSubmitting(true);
    try {
      await saveValuation({
        orgId: activeOrgId,
        vehicleId,
        companyId: companyId as Id<"financeCompanies">,
        valuationAmount,
      });
      toast.success("Valuation saved successfully");
      setCompanyId("");
      setValuationAmount(0);
    } catch (error: any) {
      toast.error(error.message || "An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!valuations || !companies) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
        <h3 className="font-semibold text-sm">{t("AddNewValuation" as any) || "Add New Valuation"}</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("Select Company" as any)}</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger>
                <SelectValue placeholder={t("SelectBank" as any) || "Select a bank..."} />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c._id} value={c._id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("Valuation Amount" as any)}</Label>
            <Input
              type="number"
              placeholder="0.00"
              value={valuationAmount || ""}
              onChange={(e) => setValuationAmount(parseFloat(e.target.value) || 0)}
            />
          </div>
        </div>
        <Button onClick={handleSave} disabled={isSubmitting}>
          {isSubmitting ? (t("Saving" as any) || "Saving...") : (t("SaveValuation" as any) || "Save Valuation")}
        </Button>
      </div>

      <div>
        <h3 className="font-semibold text-sm mb-3">{t("ExistingValuations" as any) || "Existing Valuations"}</h3>
        {valuations.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{t("NoValuationsRecorded" as any) || "No valuations recorded yet."}</p>
        ) : (
          <div className="space-y-3">
            {valuations.map((val) => {
              const comp = companies.find((c) => c._id === val.companyId);
              return (
                <div key={val._id} className="flex justify-between items-center p-3 border rounded-lg">
                  <div>
                    <p className="font-medium">{comp?.name || t("UnknownCompany" as any) || "Unknown Company"}</p>
                    {val.expiresAt && <p className="text-xs text-muted-foreground">{t("Expires" as any) || "Expires:"} {format(val.expiresAt, "PP")}</p>}
                  </div>
                  <p className="font-bold text-primary">{val.valuationAmount.toLocaleString()} JOD</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
