"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";
import { translatePipelineStageLabel } from "@/lib/i18n/defaultLabels";

export default function PipelineSettingsPage() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();

  const stages = useQuery(
    api.orgPipelineStages.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const seedStages = useMutation(api.orgPipelineStages.seed);
  const updateStage = useMutation(api.orgPipelineStages.update);
  const reorderStages = useMutation(api.orgPipelineStages.reorder);

  const [editingLabel, setEditingLabel] = useState<Record<string, string>>({});

  const handleSeed = async () => {
    if (!activeOrgId) return;
    try {
      await seedStages({ orgId: activeOrgId });
      toast.success(t("DefaultStagesLoaded" as any));
    } catch (error: any) {
      toast.error(error.message || t("DefaultStagesLoadFail" as any));
    }
  };

  const handleToggleActive = async (stageId: Id<"orgPipelineStages">, isActive: boolean) => {
    if (!activeOrgId) return;
    try {
      await updateStage({ orgId: activeOrgId, stageId, isActive });
    } catch (error: any) {
      toast.error(error.message || t("PipelineStageUpdateFail" as any));
    }
  };

  const handleColorChange = async (stageId: Id<"orgPipelineStages">, color: string) => {
    if (!activeOrgId) return;
    try {
      await updateStage({ orgId: activeOrgId, stageId, color });
    } catch (error: any) {
      toast.error(error.message || t("PipelineStageColorFail" as any));
    }
  };

  const handleLabelSave = async (stageId: Id<"orgPipelineStages">) => {
    if (!activeOrgId) return;
    const label = editingLabel[stageId]?.trim();
    if (!label) return;
    try {
      await updateStage({ orgId: activeOrgId, stageId, label });
      setEditingLabel((prev) => {
        const next = { ...prev };
        delete next[stageId];
        return next;
      });
      toast.success(t("PipelineLabelUpdated" as any));
    } catch (error: any) {
      toast.error(error.message || t("PipelineLabelFail" as any));
    }
  };

  const handleMoveUp = async (index: number) => {
    if (!activeOrgId || !stages || index === 0) return;
    const orderedIds = stages.map((s) => s._id);
    [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
    try {
      await reorderStages({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || t("ReorderFail" as any));
    }
  };

  const handleMoveDown = async (index: number) => {
    if (!activeOrgId || !stages || index === stages.length - 1) return;
    const orderedIds = stages.map((s) => s._id);
    [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
    try {
      await reorderStages({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || t("ReorderFail" as any));
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("PipelineStagesPage" as any)}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("PipelineStagesDesc" as any)}</p>
        </div>
        {stages !== undefined && stages.length === 0 && (
          <Button variant="outline" onClick={handleSeed}>
            {t("LoadDefaults" as any)}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Stages" as any)}</CardTitle>
          <CardDescription>{t("StagesDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {stages === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              {t("Loading" as any)}
            </div>
          ) : stages.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {t("NoStagesYet" as any)}
            </div>
          ) : (
            stages.map((stage, index) => {
              const currentLabel = editingLabel[stage._id] ?? translatePipelineStageLabel(stage.label, locale);

              return (
                <div
                  key={stage._id}
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
                      disabled={index === stages.length - 1}
                      className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <input
                    type="color"
                    value={stage.color ?? "#6b7280"}
                    onChange={(e) => handleColorChange(stage._id, e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-input p-0.5 shrink-0"
                  />

                  <span className="text-xs font-mono text-muted-foreground w-24 shrink-0">
                    {stage.stageKey}
                  </span>

                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Input
                      value={currentLabel}
                      onChange={(e) =>
                        setEditingLabel((prev) => ({ ...prev, [stage._id]: e.target.value }))
                      }
                      onBlur={() => {
                        if (editingLabel[stage._id] !== undefined) handleLabelSave(stage._id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleLabelSave(stage._id);
                        if (e.key === "Escape") {
                          setEditingLabel((prev) => {
                            const next = { ...prev };
                            delete next[stage._id];
                            return next;
                          });
                        }
                      }}
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Label className="text-xs text-muted-foreground">{t("ActiveStage" as any)}</Label>
                    <Switch
                      checked={stage.isActive}
                      onCheckedChange={(checked) => handleToggleActive(stage._id, checked)}
                    />
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
