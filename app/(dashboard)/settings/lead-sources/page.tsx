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
import { toast } from "sonner";
import { Plus, Trash2, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";

export default function LeadSourcesPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

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
      toast.success("Default lead sources loaded.");
    } catch (error: any) {
      toast.error(error.message || "Failed to seed lead sources.");
    }
  };

  const handleAdd = async () => {
    if (!activeOrgId || !newLabel.trim()) return;
    setIsAdding(true);
    try {
      await createSource({ orgId: activeOrgId, label: newLabel.trim() });
      setNewLabel("");
      setShowAddInput(false);
      toast.success("Lead source added.");
    } catch (error: any) {
      toast.error(error.message || "Failed to add lead source.");
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggleActive = async (
    sourceId: Id<"orgLeadSources">,
    isActive: boolean
  ) => {
    if (!activeOrgId) return;
    try {
      await updateSource({ orgId: activeOrgId, sourceId, isActive });
    } catch (error: any) {
      toast.error(error.message || "Failed to update lead source.");
    }
  };

  const handleDelete = async (sourceId: Id<"orgLeadSources">) => {
    if (!activeOrgId) return;
    if (!confirm("Delete this lead source?")) return;
    try {
      await removeSource({ orgId: activeOrgId, sourceId });
      toast.success("Lead source deleted.");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete lead source.");
    }
  };

  const handleMoveUp = async (index: number) => {
    if (!activeOrgId || !sources || index === 0) return;
    const orderedIds = sources.map((s) => s._id);
    [orderedIds[index - 1], orderedIds[index]] = [
      orderedIds[index],
      orderedIds[index - 1],
    ];
    try {
      await reorderSources({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || "Failed to reorder.");
    }
  };

  const handleMoveDown = async (index: number) => {
    if (!activeOrgId || !sources || index === sources.length - 1) return;
    const orderedIds = sources.map((s) => s._id);
    [orderedIds[index], orderedIds[index + 1]] = [
      orderedIds[index + 1],
      orderedIds[index],
    ];
    try {
      await reorderSources({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || "Failed to reorder.");
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lead Sources</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage the lead source options available when creating a lead.
          </p>
        </div>
        <div className="flex gap-2">
          {sources !== undefined && sources.length === 0 && (
            <Button variant="outline" onClick={handleSeed}>
              Load Defaults
            </Button>
          )}
          <Button onClick={() => setShowAddInput(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Source
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>
            Toggle active state or reorder using the arrows. Inactive sources won&apos;t appear in the lead form.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddInput && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-dashed border-border bg-muted/30">
              <Input
                placeholder="Source label..."
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") {
                    setShowAddInput(false);
                    setNewLabel("");
                  }
                }}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleAdd} disabled={isAdding || !newLabel.trim()}>
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAddInput(false);
                  setNewLabel("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {sources === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading...
            </div>
          ) : sources.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No lead sources yet. Click &quot;Load Defaults&quot; or add one manually.
            </div>
          ) : (
            sources.map((source, index) => (
              <div
                key={source._id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                {/* Reorder arrows */}
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

                <span className="flex-1 text-sm font-medium">{source.label}</span>

                <Switch
                  checked={source.isActive}
                  onCheckedChange={(checked) =>
                    handleToggleActive(source._id, checked)
                  }
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
