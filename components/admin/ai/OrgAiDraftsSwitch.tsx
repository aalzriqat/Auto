"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";

const ORG_SWITCH_ID = "ai-drafts-org-switch";

/**
 * Per-dealership AI drafts switch for the admin organization page. Same
 * flip-save-revert pattern as the platform switch; the dealership gets drafts
 * only when the platform switch is on and a provider key is saved as well.
 */
export function OrgAiDraftsSwitch({ orgId }: { orgId: Id<"organizations"> }) {
  const { t } = useLanguage();
  const settings = useQuery(api.aiAdmin.getOrgAiSettings, { orgId });
  const setOrgAiDraftsEnabled = useMutation(api.aiAdmin.setOrgAiDraftsEnabled);
  // See AiMasterSwitchCard: the value being saved is shown until the save
  // settles, then the server's value (new on success, old on failure).
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? settings?.draftsEnabled ?? false;

  async function handleToggle(next: boolean) {
    setPending(next);
    try {
      await setOrgAiDraftsEnabled({ orgId, enabled: next });
      toast.success(next ? t("AiAdminOrgSwitchTurnedOn") : t("AiAdminOrgSwitchTurnedOff"));
    } catch (error: unknown) {
      toast.error(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={ORG_SWITCH_ID} className="font-medium text-foreground">
          {t("AiAdminOrgSwitchLabel")}
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("AiAdminOrgSwitchHint")}{" "}
          <Link href="/admin/ai" className="text-primary underline-offset-2 hover:underline">
            {t("AiAdminOrgSwitchManage")}
          </Link>
        </p>
      </div>
      <Switch
        id={ORG_SWITCH_ID}
        checked={enabled}
        onCheckedChange={(next) => void handleToggle(next)}
        disabled={settings === undefined || pending !== null}
        aria-busy={settings === undefined}
      />
    </div>
  );
}
