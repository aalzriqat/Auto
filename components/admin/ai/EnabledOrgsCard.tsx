"use client";

import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { EmptyState, SectionCard } from "@/components/admin/ui";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { interpolate } from "@/lib/i18n/interpolate";

export type EnabledOrg = { orgId: Id<"organizations">; name: string };

/** `truncated` comes from `getAiControlState`: the server owns the limit and says when it cut the list. */
export function EnabledOrgsCard({ orgs, truncated }: { orgs: EnabledOrg[]; truncated: boolean }) {
  const { t } = useLanguage();

  return (
    <SectionCard title={t("AiAdminOrgsTitle")} bodyClassName={orgs.length > 0 ? "p-0 sm:p-0" : undefined}>
      {orgs.length === 0 ? (
        <EmptyState icon={Building2} title={t("AiAdminOrgsEmpty")} description={t("AiAdminOrgsEmptyHint")} />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {orgs.map((org) => (
              <li key={org.orgId}>
                <Link
                  href={`/admin/organizations/${org.orgId}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-muted sm:px-5"
                >
                  <span dir="auto" className="min-w-0 truncate font-medium">
                    {org.name}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {truncated && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-5">
              {interpolate(t("AiAdminOrgsCapped"), { count: orgs.length })}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}
