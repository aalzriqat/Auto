"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Handshake } from "lucide-react";
import { toast } from "@/components/ui/sonner";

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
