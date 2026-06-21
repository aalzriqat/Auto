import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, Save } from "lucide-react";

interface VehicleValuationsTabProps {
  vehicleId: Id<"vehicles">;
}

export function VehicleValuationsTab({ vehicleId }: VehicleValuationsTabProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const financeCompanies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");
  const valuations = useQuery(api.finance.listValuations, activeOrgId ? { orgId: activeOrgId, vehicleId } : "skip");
  const saveValuation = useMutation(api.finance.saveValuation);

  const [localValuations, setLocalValuations] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (valuations) {
      const initial: Record<string, string> = {};
      valuations.forEach(v => {
        initial[v.companyId] = v.valuationAmount.toString();
      });
      setLocalValuations(initial);
    }
  }, [valuations]);

  const handleSave = async (companyId: Id<"financeCompanies">, amountStr: string) => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      const amount = parseFloat(amountStr) || 0;
      await saveValuation({
        orgId: activeOrgId,
        vehicleId,
        companyId,
        valuationAmount: amount,
      });
      toast.success(t("SavedSuccessfully" as any) || "Saved successfully");
    } catch (error) {
      toast.error(t("FailedToSave" as any) || "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  if (!financeCompanies) return <div className="p-4">{t("Loading" as any) || "Loading..."}</div>;

  const activeCompanies = financeCompanies.filter(c => c.isActive);

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-col space-y-1 mb-4">
        <h3 className="text-lg font-medium">{t("FinanceCompanyValuations" as any) || "Financing Company Valuations"}</h3>
        <p className="text-sm text-muted-foreground">
          {t("FinanceCompanyValuationsDesc" as any) || "Enter the official valuation for this vehicle from each finance company. This determines maximum financing limits."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {activeCompanies.map((company) => {
          const val = localValuations[company._id] || "";
          const originalVal = valuations?.find(v => v.companyId === company._id)?.valuationAmount?.toString() || "";
          const isChanged = val !== originalVal;

          return (
            <Card key={company._id}>
              <CardContent className="p-4 flex flex-col space-y-3">
                <div className="flex items-center space-x-2">
                  <Building2 className="w-4 h-4 text-primary" />
                  <span className="font-semibold">{company.name}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <div className="relative flex-1">
                    <span className="absolute start-3 top-2.5 text-muted-foreground text-sm">JOD</span>
                    <Input
                      type="number"
                      className="ps-10"
                      placeholder="0.00"
                      value={val}
                      onChange={(e) => setLocalValuations(prev => ({...prev, [company._id]: e.target.value}))}
                    />
                  </div>
                  {isChanged && (
                    <Button 
                      size="sm" 
                      onClick={() => handleSave(company._id, val)}
                      disabled={isSaving}
                    >
                      <Save className="w-4 h-4 me-1" />
                      {t("Save" as any) || "Save"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {activeCompanies.length === 0 && (
        <div className="text-center p-8 text-muted-foreground border rounded-lg bg-muted/20">
          {t("NoActiveFinanceCompanies" as any) || "No active finance companies found."}
        </div>
      )}
    </div>
  );
}
