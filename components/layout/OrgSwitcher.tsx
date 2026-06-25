"use client";

import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ChevronsUpDown, Plus, Edit2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
// removed sidebar components
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { toast } from "@/components/ui/sonner";

export function OrgSwitcher() {
  const { t } = useLanguage();
  const { activeOrgId, setActiveOrgId } = useOrg();
  const orgs = useQuery(api.organizations.listMine);
  
  const activeOrg = orgs?.find((o: any) => o._id === activeOrgId);
  const [dialogType, setDialogType] = useState<"CREATE" | "RENAME" | null>(null);
  const [newOrgName, setNewOrgName] = useState("");
  
  const createOrg = useMutation(api.organizations.create);
  const updateOrg = useMutation(api.organizations.update);

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    
    try {
      const newId = await createOrg({ name: newOrgName.trim() });
      setActiveOrgId(newId);
      setNewOrgName("");
      setDialogType(null);
      toast.success(t("OrganizationCreated" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleRenameOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId || !newOrgName.trim()) return;
    
    try {
      await updateOrg({ orgId: activeOrgId, name: newOrgName.trim() });
      setNewOrgName("");
      setDialogType(null);
      toast.success(t("OrganizationRenamed" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  return (
    <Dialog open={!!dialogType} onOpenChange={(open) => { if (!open) setDialogType(null); }}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="lg"
            className="flex items-center gap-2 px-2 hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shrink-0">
              {activeOrg?.name?.charAt(0).toUpperCase() || "A"}
            </div>
            <div className="hidden sm:grid flex-1 text-start text-sm leading-tight max-w-[120px] md:max-w-[150px]">
              <span className="truncate font-semibold">
                {activeOrg?.name || t("Loading" as any)}
              </span>
              <span className="truncate text-xs text-muted-foreground">{t("Dealership" as any)}</span>
            </div>
            <ChevronsUpDown className="hidden sm:block size-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-56 rounded-lg"
          align="start"
          side="bottom"
          sideOffset={8}
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("Organizations" as any)}
          </DropdownMenuLabel>
          {orgs?.map((org: any) => (
            <DropdownMenuItem
              key={org._id}
              onClick={() => setActiveOrgId(org._id)}
              className="gap-2 p-2 cursor-pointer"
            >
              <div className="flex size-6 items-center justify-center rounded-sm border bg-background">
                {org.name.charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{org.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DialogTrigger asChild>
            <DropdownMenuItem className="gap-2 p-2 cursor-pointer" onClick={() => { setNewOrgName(""); setDialogType("CREATE"); }}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">{t("AddOrganization" as any)}</div>
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogTrigger asChild>
            <DropdownMenuItem className="gap-2 p-2 cursor-pointer" onClick={() => { setNewOrgName(activeOrg?.name || ""); setDialogType("RENAME"); }}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Edit2 className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">{t("RenameCurrent" as any)}</div>
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogType === "CREATE" ? t("CreateOrganization" as any) : t("RenameOrganization" as any)}</DialogTitle>
          <DialogDescription>
            {dialogType === "CREATE" 
              ? t("CreateOrgDescription" as any)
              : t("RenameOrgDescription" as any)}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={dialogType === "CREATE" ? handleCreateOrg : handleRenameOrg}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-end">
                {t("Name" as any)}
              </Label>
              <Input
                id="name"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder={t("AcmeAuto" as any)}
                className="col-span-3"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!newOrgName.trim()}>{dialogType === "CREATE" ? t("Create" as any) : t("SaveChanges" as any)}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
