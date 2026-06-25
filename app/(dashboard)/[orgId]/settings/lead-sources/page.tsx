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
import { Plus, Trash2, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";
import { translateLeadSourceLabel } from "@/lib/i18n/defaultLabels";

export default function LeadSourcesPage() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();

  const sources = useQuery(
    api.orgLeadSources.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const seedSources = useMutation(api.orgLeadSources.seed);
  const createSource = useMutation(api.orgLeadSources.create);
  const updateSource = useMutation(api.orgLeadSources.update);
  const removeSource = useMutation(api.orgLeadSources.remove);
  const reorderSources = useMutation(api.orgLeadSources.reorder);

  const [newLabel, setNewLabel] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);

  const handleSeed = async () => {
    if (!activeOrgId) return;
    try {
      await seedSources({ orgId: activeOrgId });
      toast.success(t("DefaultSourcesLoaded" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleAdd = async () => {
    if (!activeOrgId || !newLabel.trim()) return;
    setIsAdding(true);
    try {
      await createSource({ orgId: activeOrgId, label: newLabel.trim() });
      setNewLabel("");
      setShowAddInput(false);
      toast.success(t("LeadSourceAdded" as any));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggleActive = async (sourceId: Id<"orgLeadSources">, isActive: boolean) => {
    if (!activeOrgId) return;
    try {
      await updateSource({ orgId: activeOrgId, sourceId, isActive });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleDelete = async (sourceId: Id<"orgLeadSources">) => {
    if (!activeOrgId) return;
    if (!confirm(t("LeadSourceDeleteConfirm" as any))) return;
    try {
      await removeSource({ orgId: activeOrgId, sourceId });
      toast.success(t("LeadSourceDeleted" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleMoveUp = async (index: number) => {
    if (!activeOrgId || !sources || index === 0) return;
    const orderedIds = sources.map((s) => s._id);
    [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
    try {
      await reorderSources({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleMoveDown = async (index: number) => {
    if (!activeOrgId || !sources || index === sources.length - 1) return;
    const orderedIds = sources.map((s) => s._id);
    [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
    try {
      await reorderSources({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("LeadSources" as any)}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("LeadSourcesDesc" as any)}</p>
        </div>
        <div className="flex gap-2">
          {sources !== undefined && sources.length === 0 && (
            <Button variant="outline" onClick={handleSeed}>
              {t("LoadDefaults" as any)}
            </Button>
          )}
          <Button onClick={() => setShowAddInput(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t("AddSource" as any)}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Sources" as any)}</CardTitle>
          <CardDescription>{t("SourcesDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddInput && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-dashed border-border bg-muted/30">
              <Input
                placeholder={t("SourceLabelPlaceholder" as any)}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") { setShowAddInput(false); setNewLabel(""); }
                }}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleAdd} disabled={isAdding || !newLabel.trim()}>
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : t("AddNew" as any)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowAddInput(false); setNewLabel(""); }}>
                {t("Cancel" as any)}
              </Button>
            </div>
          )}

          {sources === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              {t("Loading" as any)}
            </div>
          ) : sources.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {t("NoLeadSourcesYet" as any)}
            </div>
          ) : (
            sources.map((source, index) => (
              <div
                key={source._id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex flex-col gap-0.5">
                  <button
                    onClick={() => handleMoveUp(index)}
                    disabled={index === 0}
                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleMoveDown(index)}
                    disabled={index === sources.length - 1}
                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <span className="flex-1 text-sm font-medium">{translateLeadSourceLabel(source.label, locale)}</span>

                <Switch
                  checked={source.isActive}
                  onCheckedChange={(checked) => handleToggleActive(source._id, checked)}
                />

                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-500 hover:text-red-600 h-8 w-8"
                  onClick={() => handleDelete(source._id)}
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
