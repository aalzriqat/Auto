"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Store, CheckCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function BranchesClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const branches = useQuery(api.branches.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const migrate = useMutation(api.branches.migrateToDefaultBranch);
  const addBranch = useMutation(api.branches.add);
  const updateBranch = useMutation(api.branches.update);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<any>(null);
  
  const [formData, setFormData] = useState({
    name: "",
    address: "",
    phone: "",
    isActive: true,
  });

  const handleOpenAdd = () => {
    setEditingBranch(null);
    setFormData({ name: "", address: "", phone: "", isActive: true });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (branch: any) => {
    setEditingBranch(branch);
    setFormData({
      name: branch.name,
      address: branch.address || "",
      phone: branch.phone || "",
      isActive: branch.isActive,
    });
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (!activeOrgId || !formData.name) return;
    try {
      if (editingBranch) {
        await updateBranch({
          orgId: activeOrgId,
          id: editingBranch._id,
          ...formData,
        });
        toast.success("Branch updated");
      } else {
        await addBranch({
          orgId: activeOrgId,
          ...formData,
        });
        toast.success("Branch created");
      }
      setIsDialogOpen(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save branch");
    }
  };

  const handleMigrate = async () => {
    if (!activeOrgId) return;
    try {
      await migrate({ orgId: activeOrgId });
      toast.success("Successfully migrated inventory and users to a Default Branch.");
    } catch (error: any) {
      toast.error("Migration failed");
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">{t("BranchesManagement" as any) || "Branches Management"}</h2>
        <Button onClick={handleOpenAdd}>
          <Plus className="mr-2 h-4 w-4" />
          {t("AddBranch" as any) || "Add Branch"}
        </Button>
      </div>

      {!branches?.length && branches !== undefined && (
        <Card className="bg-yellow-50 border-yellow-200">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-yellow-100 rounded-full text-yellow-600">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-yellow-900">{t("BranchSystemNotInitialized" as any) || "Branch System Not Initialized"}</h3>
                  <p className="text-yellow-700">{t("BranchInitDesc" as any) || "You need to create a default branch and migrate existing vehicles and users to it."}</p>
                </div>
              </div>
              <Button onClick={handleMigrate} className="bg-yellow-600 hover:bg-yellow-700 text-white">
                {t("InitializeMigrateData" as any) || "Initialize & Migrate Data"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" />
            {t("PhysicalBranches" as any) || "Physical Branches"}
          </CardTitle>
          <CardDescription>{t("ManagePhysicalBranches" as any) || "Manage your physical dealership locations"}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Name" as any) || "Name"}</TableHead>
                  <TableHead>{t("Address" as any) || "Address"}</TableHead>
                  <TableHead>{t("Phone" as any) || "Phone"}</TableHead>
                  <TableHead>{t("Manager" as any) || "Manager"}</TableHead>
                  <TableHead>{t("Status" as any) || "Status"}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any) || "Actions"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches === undefined ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">{t("Loading" as any) || "Loading..."}</TableCell>
                  </TableRow>
                ) : branches.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      {t("NoBranchesFound" as any) || "No branches found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  branches.map((branch) => (
                    <TableRow key={branch._id}>
                      <TableCell className="font-medium">{branch.name}</TableCell>
                      <TableCell>{branch.address || "N/A"}</TableCell>
                      <TableCell>{branch.phone || "N/A"}</TableCell>
                      <TableCell>{branch.managerName}</TableCell>
                      <TableCell>
                        <Badge variant={branch.isActive ? "default" : "secondary"}>
                          {branch.isActive ? (t("Active" as any) || "Active") : (t("Inactive" as any) || "Inactive")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenEdit(branch)}
                        >
                          {t("Edit" as any) || "Edit"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingBranch ? (t("EditBranch" as any) || "Edit Branch") : (t("AddNewBranch" as any) || "Add New Branch")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("BranchName" as any) || "Branch Name"}</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. North Showroom"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("AddressOptional" as any) || "Address (Optional)"}</Label>
              <Input
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="123 Main St"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("PhoneOptional" as any) || "Phone (Optional)"}</Label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="+1 234 567 890"
              />
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <input 
                type="checkbox"
                id="isActive" 
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                className="w-4 h-4 text-primary rounded border-gray-300"
              />
              <Label htmlFor="isActive">{t("ActiveBranch" as any) || "Active Branch"}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>{t("Cancel" as any) || "Cancel"}</Button>
            <Button onClick={handleSave} disabled={!formData.name}>
              {editingBranch ? (t("SaveChanges" as any) || "Save Changes") : (t("CreateBranch" as any) || "Create Branch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
