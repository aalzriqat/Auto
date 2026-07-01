"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Doc, Id } from "@/convex/_generated/dataModel";

export default function ValuationCompaniesPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const companies = useQuery(
    api.orgValuationCompanies.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const seedCompanies = useMutation(api.orgValuationCompanies.seed);
  const createCompany = useMutation(api.orgValuationCompanies.create);
  const updateCompany = useMutation(api.orgValuationCompanies.update);
  const removeCompany = useMutation(api.orgValuationCompanies.remove);

  const [newName, setNewName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);

  const handleSeed = async () => {
    if (!activeOrgId) return;
    try {
      await seedCompanies({ orgId: activeOrgId });
      toast.success("Default valuation companies loaded.");
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleAdd = async () => {
    if (!activeOrgId || !newName.trim()) return;
    setIsAdding(true);
    try {
      await createCompany({ orgId: activeOrgId, name: newName.trim() });
      setNewName("");
      setShowAddInput(false);
      toast.success("Valuation company added.");
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggleActive = async (
    companyId: Id<"orgValuationCompanies">,
    isActive: boolean
  ) => {
    if (!activeOrgId) return;
    try {
      await updateCompany({ orgId: activeOrgId, companyId, isActive });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleDelete = async (companyId: Id<"orgValuationCompanies">) => {
    if (!activeOrgId) return;
    if (!confirm("Delete this valuation company?")) return;
    try {
      await removeCompany({ orgId: activeOrgId, companyId });
      toast.success("Valuation company deleted.");
    } catch (error: any) {
      toast.error(error);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Valuation Companies</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage the vehicle valuation companies your dealership works with.
          </p>
        </div>
        <div className="flex gap-2">
          {companies !== undefined && companies.length === 0 && (
            <Button variant="outline" onClick={handleSeed}>
              Load Defaults
            </Button>
          )}
          <Button onClick={() => setShowAddInput(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Company
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Companies</CardTitle>
          <CardDescription>
            Toggle active state for each company. Inactive companies won&apos;t appear in valuation workflows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddInput && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-dashed border-border bg-muted/30">
              <Input
                placeholder="Company name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") {
                    setShowAddInput(false);
                    setNewName("");
                  }
                }}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleAdd} disabled={isAdding || !newName.trim()}>
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAddInput(false);
                  setNewName("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {companies === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading...
            </div>
          ) : companies.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No valuation companies yet. Click &quot;Load Defaults&quot; or add one manually.
            </div>
          ) : (
            companies.map((company: Doc<"orgValuationCompanies">) => (
              <div
                key={company._id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <span className="flex-1 text-sm font-medium">{company.name}</span>

                <Switch
                  checked={company.isActive}
                  onCheckedChange={(checked) =>
                    handleToggleActive(company._id, checked)
                  }
                />

                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-500 hover:text-red-600 h-8 w-8"
                  onClick={() => handleDelete(company._id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
