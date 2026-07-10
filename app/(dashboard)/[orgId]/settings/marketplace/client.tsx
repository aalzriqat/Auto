"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Handshake, Crown, Package, Clock } from "lucide-react";
import { toast } from "@/components/ui/sonner";

// Mirrors convex/marketplaceDealers.ts's FOUNDING_WINDOW_MS — used only as a
// display fallback for profiles created before Phase 63 stamped
// foundingWindowEndsAt, same lazy-default reasoning as the backend.
const FOUNDING_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

function MarketplaceTierCard({
  profile,
  activeOrgId,
}: {
  readonly profile: {
    tier: "FREE_FOUNDING" | "LEAD_PACKAGE" | "FEATURED";
    createdAt: number;
    foundingWindowEndsAt?: number;
    leadQuota?: number;
    leadsUsedThisPeriod: number;
  };
  readonly activeOrgId: string;
}) {
  const { t } = useLanguage();

  if (profile.tier === "FREE_FOUNDING") {
    const windowEndsAt = profile.foundingWindowEndsAt ?? profile.createdAt + FOUNDING_WINDOW_MS;
    const daysLeft = Math.max(0, Math.ceil((windowEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
    const expired = windowEndsAt <= Date.now();

    return (
      <Card>
        <CardContent className="p-4 flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Clock className={expired ? "h-5 w-5 text-red-500 shrink-0 mt-0.5" : "h-5 w-5 text-muted-foreground shrink-0 mt-0.5"} />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t("MarketplaceTierLabel" as any)}</span>
                <Badge variant="outline">{t("MarketplaceTierFounding" as any)}</Badge>
              </div>
              <p className={expired ? "text-xs text-red-600 mt-1" : "text-xs text-muted-foreground mt-1"}>
                {expired ? t("MarketplaceFoundingExpired" as any) : `${daysLeft} ${t("MarketplaceFoundingDaysLeft" as any)}`}
              </p>
            </div>
          </div>
          {expired && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/${activeOrgId}/settings/billing`}>{t("MarketplaceUpgradeCta" as any)}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (profile.tier === "LEAD_PACKAGE") {
    const quota = profile.leadQuota ?? 0;
    const used = profile.leadsUsedThisPeriod;
    const exhausted = used >= quota;

    return (
      <Card>
        <CardContent className="p-4 flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Package className={exhausted ? "h-5 w-5 text-red-500 shrink-0 mt-0.5" : "h-5 w-5 text-muted-foreground shrink-0 mt-0.5"} />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t("MarketplaceTierLabel" as any)}</span>
                <Badge variant="outline">{t("MarketplaceTierLeadPackage" as any)}</Badge>
              </div>
              <p className={exhausted ? "text-xs text-red-600 mt-1" : "text-xs text-muted-foreground mt-1"}>
                {used}/{quota} {t("MarketplaceLeadQuotaUsed" as any)}
                {exhausted ? ` — ${t("MarketplaceLeadQuotaExhausted" as any)}` : ""}
              </p>
            </div>
          </div>
          {exhausted && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/${activeOrgId}/settings/billing`}>{t("MarketplaceUpgradeCta" as any)}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <Crown className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t("MarketplaceTierLabel" as any)}</span>
            <Badge className="bg-amber-100 text-amber-700 border-amber-200">{t("MarketplaceTierFeatured" as any)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t("MarketplaceFeaturedActive" as any)}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function MarketplaceSettingsClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const profile = useQuery(api.marketplaceDealers.getMyProfile, activeOrgId ? { orgId: activeOrgId } : "skip");
  const updateProfile = useMutation(api.marketplaceDealers.updateProfile);

  const [isOptedIn, setIsOptedIn] = useState(false);
  const [areas, setAreas] = useState("");
  const [brands, setBrands] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [loadedOrgId, setLoadedOrgId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeOrgId || profile === undefined || loadedOrgId === activeOrgId) return;
    setIsOptedIn(profile?.isOptedIn ?? false);
    setAreas((profile?.areas ?? []).join(", "));
    setBrands((profile?.brandsCarried ?? []).join(", "));
    setWhatsappNumber(profile?.whatsappNumber ?? "");
    setLoadedOrgId(activeOrgId);
  }, [activeOrgId, profile, loadedOrgId]);

  const handleSave = async (overrides?: { isOptedIn?: boolean }) => {
    if (!activeOrgId) return;
    const previousIsOptedIn = isOptedIn;
    setSaving(true);
    try {
      await updateProfile({
        orgId: activeOrgId,
        isOptedIn: overrides?.isOptedIn ?? isOptedIn,
        areas: areas.split(",").map((area) => area.trim()).filter(Boolean),
        brandsCarried: brands.split(",").map((brand) => brand.trim()).filter(Boolean),
        whatsappNumber: whatsappNumber.trim() || undefined,
      });
      toast.success(t("MarketplaceSaved" as any));
    } catch (error: any) {
      if (overrides?.isOptedIn !== undefined) setIsOptedIn(previousIsOptedIn);
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      {activeOrgId && profile && <MarketplaceTierCard profile={profile} activeOrgId={activeOrgId} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Handshake className="h-5 w-5" />
            {t("MarketplaceSettingsTitle" as any)}
          </CardTitle>
          <CardDescription>{t("MarketplaceSettingsDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{t("MarketplaceOptIn" as any)}</p>
              <p className="text-xs text-muted-foreground">{t("MarketplaceOptInDescription" as any)}</p>
              {!isOptedIn && (
                <p className="text-xs text-amber-600 mt-1">{t("MarketplaceNotOptedInHint" as any)}</p>
              )}
            </div>
            <Switch
              checked={isOptedIn}
              disabled={saving || !activeOrgId || loadedOrgId !== activeOrgId}
              onCheckedChange={(checked) => {
                setIsOptedIn(checked);
                void handleSave({ isOptedIn: checked });
              }}
            />
          </div>

          <div className="space-y-4 rounded-xl border border-border p-6">
            <div>
              <p className="text-sm font-medium mb-1">{t("MarketplaceAreasLabel" as any)}</p>
              <Input
                value={areas}
                placeholder={t("MarketplaceAreasPlaceholder" as any)}
                onChange={(e) => setAreas(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">{t("MarketplaceAreasHint" as any)}</p>
            </div>

            <div>
              <p className="text-sm font-medium mb-1">{t("MarketplaceBrandsLabel" as any)}</p>
              <Input
                value={brands}
                placeholder={t("MarketplaceBrandsPlaceholder" as any)}
                onChange={(e) => setBrands(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">{t("MarketplaceBrandsHint" as any)}</p>
            </div>

            <div>
              <p className="text-sm font-medium mb-1">{t("MarketplaceWhatsAppLabel" as any)}</p>
              <Input
                value={whatsappNumber}
                placeholder={t("MarketplaceWhatsAppPlaceholder" as any)}
                onChange={(e) => setWhatsappNumber(e.target.value)}
              />
            </div>

            <div className="flex justify-end">
              <Button type="button" onClick={() => handleSave()} disabled={saving}>
                {t("MarketplaceSave" as any)}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
