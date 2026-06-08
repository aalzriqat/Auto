import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import { toast } from "sonner";
import { calculateDBR } from "@/lib/financing";
import { GuarantorDialog } from "./GuarantorDialog";
import { Trash2, Edit } from "lucide-react";

export function CustomerFinancialsTab({ customer }: { customer: any }) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const updateCustomer = useMutation(api.customers.update);
  const removeGuarantor = useMutation(api.guarantors.remove);

  const guarantors = useQuery(api.guarantors.listByCustomer, activeOrgId ? { orgId: activeOrgId, customerId: customer._id } : "skip");
  
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [guarantorDialogOpen, setGuarantorDialogOpen] = useState(false);
  const [editingGuarantor, setEditingGuarantor] = useState<any>(null);
  const [formData, setFormData] = useState({
    employer: customer.employment?.employer || "",
    jobTitle: customer.employment?.title || "",
    salary: customer.employment?.salary || 0,
    totalMonthlyDebt: customer.financials?.totalMonthlyDebt || 0,
  });

  const handleSave = async () => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const dbr = calculateDBR(formData.salary, formData.totalMonthlyDebt, 0); // basic DBR without a proposed installment yet
      
      await updateCustomer({
        customerId: customer._id,
        orgId: activeOrgId,
        employment: {
          employer: formData.employer,
          title: formData.jobTitle,
          salary: formData.salary,
        },
        financials: {
          totalMonthlyDebt: formData.totalMonthlyDebt,
          dbr: dbr,
        },
      });
      toast.success(t("FinancialsUpdatedSuccess" as any));
      setIsEditing(false);
    } catch (error: any) {
      toast.error(error.message || t("FinancialsUpdateFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm">{t("Financials" as any)} & {t("Employment" as any)}</h3>
        {!isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
            {t("Edit" as any)}
          </Button>
        ) : (
          <div className="space-x-2">
            <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
              {t("Cancel" as any)}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSubmitting}>
              {isSubmitting ? t("Saving" as any) : t("Save" as any)}
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("Employer" as any)}</Label>
          {isEditing ? (
            <Input
              value={formData.employer}
              onChange={(e) => setFormData({ ...formData, employer: e.target.value })}
            />
          ) : (
            <p className="text-sm font-medium">{customer.employment?.employer || "N/A"}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("JobTitle" as any)}</Label>
          {isEditing ? (
            <Input
              value={formData.jobTitle}
              onChange={(e) => setFormData({ ...formData, jobTitle: e.target.value })}
            />
          ) : (
            <p className="text-sm font-medium">{customer.employment?.title || "N/A"}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("Salary" as any)}</Label>
          {isEditing ? (
            <Input
              type="number"
              value={formData.salary || ""}
              onChange={(e) => setFormData({ ...formData, salary: parseFloat(e.target.value) || 0 })}
            />
          ) : (
            <p className="text-sm font-medium text-green-600">{customer.employment?.salary ? `${customer.employment.salary.toLocaleString()} JOD` : "N/A"}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("TotalMonthlyDebt" as any)}</Label>
          {isEditing ? (
            <Input
              type="number"
              value={formData.totalMonthlyDebt || ""}
              onChange={(e) => setFormData({ ...formData, totalMonthlyDebt: parseFloat(e.target.value) || 0 })}
            />
          ) : (
            <p className="text-sm font-medium text-red-500">{customer.financials?.totalMonthlyDebt ? `${customer.financials.totalMonthlyDebt.toLocaleString()} JOD` : "0 JOD"}</p>
          )}
        </div>
        
        {!isEditing && customer.financials?.dbr !== undefined && (
          <div className="space-y-2 col-span-2 mt-2 pt-2 border-t">
            <Label>{t("DBR" as any)}</Label>
            <p className={`text-lg font-bold ${customer.financials.dbr > 50 ? 'text-red-500' : 'text-green-500'}`}>
              {customer.financials.dbr.toFixed(1)}%
            </p>
          </div>
        )}
      </div>
      
      <Separator />

      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-sm">{t("Guarantors" as any)}</h3>
          <Button 
            size="sm" 
            variant="outline" 
            onClick={() => {
              setEditingGuarantor(null);
              setGuarantorDialogOpen(true);
            }}
          >
            {t("AddGuarantor" as any)}
          </Button>
        </div>
        
        {guarantors === undefined ? (
          <p className="text-sm text-muted-foreground">{t("LoadingGuarantors" as any)}</p>
        ) : guarantors.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{t("NoGuarantors" as any)}</p>
        ) : (
          <div className="space-y-3">
            {guarantors.map((g) => (
              <div key={g._id} className="p-4 rounded-lg border bg-card flex justify-between items-start">
                <div>
                  <h4 className="font-semibold">{g.firstName} {g.lastName}</h4>
                  <p className="text-sm text-muted-foreground">ID: {g.nationalId} • Phone: {g.phone}</p>
                  <div className="flex items-center gap-2 mt-2">
                    {g.relationship && <span className="text-xs bg-muted px-2 py-1 rounded-md">{g.relationship}</span>}
                    {g.income ? <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-md">Income: {g.income} JOD</span> : null}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => {
                      setEditingGuarantor(g);
                      setGuarantorDialogOpen(true);
                    }}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={async () => {
                      if (confirm(t("RemoveGuarantorConfirm" as any))) {
                        await removeGuarantor({ orgId: activeOrgId!, guarantorId: g._id });
                        toast.success(t("GuarantorRemoved" as any));
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <GuarantorDialog
        open={guarantorDialogOpen}
        onOpenChange={setGuarantorDialogOpen}
        customerId={customer._id}
        guarantor={editingGuarantor}
      />
    </div>
  );
}
