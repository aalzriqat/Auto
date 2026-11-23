"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { SectionCard } from "@/components/admin/ui";
import { useLanguage } from "@/components/providers/LanguageProvider";

const MASTER_SWITCH_ID = "ai-drafts-platform-switch";

/**
 * Platform-wide switch for AI drafts. Same behaviour as the `showPlanPricing`
 * switch on the admin dashboard (flip at once, save, flip back if the save
 * fails), derived from the server value instead of copied into state.
 */
export function AiMasterSwitchCard({ draftsEnabled }: { draftsEnabled: boolean }) {
  const { t } = useLanguage();
  const setAiDraftsEnabled = useMutation(api.aiAdmin.setAiDraftsEnabled);
  // The value being saved, shown until the save settles. Clearing it shows the
  // server's value again: the new one after success (the Convex client resolves
  // a mutation only once its query results include that mutation's writes;
  // see `removeCompleted` in convex/browser's request manager), the old one
  // after failure.
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? draftsEnabled;

  async function handleToggle(next: boolean) {
    setPending(next);
    try {
      await setAiDraftsEnabled({ enabled: next });
      toast.success(next ? t("AiAdminMasterTurnedOn") : t("AiAdminMasterTurnedOff"));
    } catch (error: unknown) {
      toast.error(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionCard title={t("AiAdminMasterTitle")}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor={MASTER_SWITCH_ID} className="font-medium text-foreground">
              {t("AiAdminMasterLabel")}
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("AiAdminMasterHint")}</p>
          </div>
          <Switch
            id={MASTER_SWITCH_ID}
            checked={enabled}
            onCheckedChange={(next) => void handleToggle(next)}
            disabled={pending !== null}
          />
        </div>

        <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{t("AiAdminConditionsTitle")}</p>
          <ol className="mt-2 list-decimal space-y-1 ps-5">
            <li>{t("AiAdminConditionPlatform")}</li>
            <li>{t("AiAdminConditionDealership")}</li>
            <li>{t("AiAdminConditionKey")}</li>
          </ol>
        </div>
      </div>
    </SectionCard>
  );
}
