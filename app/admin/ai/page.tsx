"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PageHeader } from "@/components/admin/ui";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { AiMasterSwitchCard } from "@/components/admin/ai/AiMasterSwitchCard";
import { AnthropicKeyCard, type ProviderKeyStatus } from "@/components/admin/ai/AnthropicKeyCard";
import { EnabledOrgsCard } from "@/components/admin/ai/EnabledOrgsCard";

const NOT_SET: ProviderKeyStatus = { kind: "unset", provider: "anthropic" };

/**
 * /admin/ai (SCRUM-980): super-admin control of AI drafts. Authority is decided
 * by `requireSuperAdmin` in every `aiAdmin` function; this page only reads the
 * explicit status projection and never receives a key.
 */
export default function AdminAiPage() {
  const { t } = useLanguage();
  const state = useQuery(api.aiAdmin.getAiControlState, {});

  const anthropicStatus: ProviderKeyStatus = state?.providers?.find((entry) => entry.provider === "anthropic") ?? NOT_SET;

  return (
    <div>
      <PageHeader title={t("AiAdminTitle")} description={t("AiAdminDescription")} />

      {state === undefined ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true">
          <span className="sr-only">{t("AiAdminLoading")}</span>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-40 motion-safe:animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <AiMasterSwitchCard draftsEnabled={state.draftsEnabled} />
          <AnthropicKeyCard encryptionConfigured={state.encryptionConfigured} status={anthropicStatus} />
          <EnabledOrgsCard orgs={state.enabledOrgs ?? []} truncated={state.truncated ?? false} />
        </div>
      )}
    </div>
  );
}
