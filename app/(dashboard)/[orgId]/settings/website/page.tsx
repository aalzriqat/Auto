"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe2,
  LayoutTemplate,
  Loader2,
  Palette,
  Route,
  Save,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Id } from "@/convex/_generated/dataModel";
import {
  SENSITIVE_WEBSITE_SECTION_KEYS,
  WEBSITE_FORM_TYPES,
  WEBSITE_SECTION_GROUPS,
} from "@/lib/website/websiteSetupConfig";

type SectionState = Record<string, boolean>;
type DomainLookupResult = null | {
  available?: boolean;
  error?: string | null;
  domain?: string;
  price?: number;
  currency?: string;
  provider?: string;
};

function statusVariant(status?: string) {
  if (status === "active") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

export default function WebsiteSettingsPage() {
  const { activeOrgId } = useOrg();
  const { locale, t } = useLanguage();
  const status = useQuery(api.websites.getStatus, activeOrgId ? { orgId: activeOrgId } : "skip");
  const startSetup = useMutation(api.websites.startSetup);
  const checkSubdomain = useMutation(api.websites.checkSubdomain);
  const searchDomain = useMutation(api.websites.searchDomain);
  const purchaseDomain = useMutation(api.websites.purchaseDomain);
  const saveDraft = useMutation(api.websites.saveDraft);
  const publishWebsite = useMutation(api.websites.publish);
  const unpublishWebsite = useMutation(api.websites.unpublish);

  const [step, setStep] = useState(1);
  const [isBusy, setIsBusy] = useState(false);
  const [subdomainSlug, setSubdomainSlug] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [subdomainCheckResult, setSubdomainCheckResult] = useState<DomainLookupResult>(null);
  const [customDomainSearchResult, setCustomDomainSearchResult] = useState<DomainLookupResult>(null);
  const [templateId, setTemplateId] = useState("modern-showroom");
  const [defaultLanguage, setDefaultLanguage] = useState<"en" | "ar">("en");
  const [supportArabic, setSupportArabic] = useState(true);
  const [primaryColor, setPrimaryColor] = useState("#0f172a");
  const [secondaryColor, setSecondaryColor] = useState("#f97316");
  const [heroTitle, setHeroTitle] = useState("");
  const [heroSubtitle, setHeroSubtitle] = useState("");
  const [sections, setSections] = useState<SectionState>({});
  const [routing, setRouting] = useState<Record<string, { createTask: boolean; notifyByEmail: boolean; notifyByWhatsApp: boolean }>>({});

  const primaryDomain = status?.primaryDomain?.domain ?? status?.settings?.defaultSubdomain ?? null;

  useEffect(() => {
    if (!status) return;
    const settings = status.settings;
    if (settings) {
      setTemplateId(settings.templateId ?? "modern-showroom");
      setDefaultLanguage(settings.defaultLanguage ?? "en");
      setSupportArabic((settings.supportedLanguages ?? []).includes("ar"));
      setPrimaryColor(settings.primaryColor ?? "#0f172a");
      setSecondaryColor(settings.secondaryColor ?? "#f97316");
      setHeroTitle(settings.heroTitle ?? "");
      setHeroSubtitle(settings.heroSubtitle ?? "");
      const platform = status.domains?.find((domain) => domain.type === "platform_subdomain");
      setSubdomainSlug(platform?.domain?.replace(".autoflowdealer.com", "") ?? "");
    }

    const nextSections: SectionState = {};
    for (const section of status.sections ?? []) {
      nextSections[section.sectionKey] = section.enabled;
    }
    setSections(nextSections);

    const nextRouting: Record<string, { createTask: boolean; notifyByEmail: boolean; notifyByWhatsApp: boolean }> = {};
    for (const route of status.routing ?? []) {
      nextRouting[route.formType] = {
        createTask: route.createTask,
        notifyByEmail: route.notifyByEmail,
        notifyByWhatsApp: route.notifyByWhatsApp,
      };
    }
    setRouting(nextRouting);
  }, [status]);

  const enabledCount = useMemo(
    () => Object.values(sections).filter(Boolean).length,
    [sections]
  );
  const statusLabel = status?.settings?.status ?? "disabled";
  const setupExists = Boolean(status?.settings);
  const selectedAddress = primaryDomain ?? (subdomainSlug.trim() ? `${subdomainSlug.trim().toLowerCase()}.autoflowdealer.com` : null);
  const canPublish = Boolean(setupExists && selectedAddress);

  function websiteDraftInput(orgId: Id<"organizations">) {
    return {
      orgId,
      subdomainSlug: subdomainSlug.trim() || undefined,
      templateId,
      defaultLanguage,
      supportedLanguages: supportArabic ? (["en", "ar"] as Array<"en" | "ar">) : [defaultLanguage],
      primaryColor,
      secondaryColor,
      heroTitle: heroTitle.trim() || undefined,
      heroSubtitle: heroSubtitle.trim() || undefined,
      sections: Object.entries(sections).map(([sectionKey, enabled]) => ({ sectionKey, enabled })),
      routing: WEBSITE_FORM_TYPES.map(([formType]) => ({
        formType,
        createTask: routing[formType]?.createTask ?? formType === "test_drive",
        notifyByEmail: routing[formType]?.notifyByEmail ?? true,
        notifyByWhatsApp: routing[formType]?.notifyByWhatsApp ?? false,
      })),
    };
  }

  function previewPath(orgId: Id<"organizations">) {
    return `/dealer-site?previewOrgId=${orgId}`;
  }

  async function runAction(action: () => Promise<void>, success: string) {
    setIsBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      console.error("Website settings action failed", error);
      toast.error(t("WebsiteUnexpectedError"));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreate() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await startSetup({ orgId: activeOrgId });
      setStep(1);
    }, t("WebsiteSetupCreated"));
  }

  async function handleCheckSubdomain() {
    if (!activeOrgId || !subdomainSlug.trim()) return;
    setIsBusy(true);
    try {
      const result = await checkSubdomain({ orgId: activeOrgId, slug: subdomainSlug });
      setSubdomainCheckResult(result);
    } catch (error) {
      console.error("Subdomain check failed", error);
      toast.error(t("WebsiteUnexpectedError"));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSearchDomain() {
    if (!activeOrgId || !customDomain.trim()) return;
    setIsBusy(true);
    try {
      const result = await searchDomain({ orgId: activeOrgId, domain: customDomain });
      setCustomDomainSearchResult(result);
    } catch (error) {
      console.error("Domain search failed", error);
      toast.error(t("WebsiteUnexpectedError"));
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePurchaseDomain() {
    if (!activeOrgId || !customDomainSearchResult?.domain) return;
    await runAction(async () => {
      await purchaseDomain({ orgId: activeOrgId, domain: customDomainSearchResult.domain! });
    }, t("WebsiteMockPurchaseCompleted"));
  }

  async function handleSaveDraft() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await saveDraft(websiteDraftInput(activeOrgId));
    }, t("WebsiteDraftSaved"));
  }

  async function handlePreview() {
    if (!activeOrgId) return;
    const previewWindow = window.open("about:blank", "_blank");
    if (previewWindow) previewWindow.opener = null;
    await runAction(async () => {
      await saveDraft(websiteDraftInput(activeOrgId));
      const url = previewPath(activeOrgId);
      if (previewWindow) {
        previewWindow.location.href = url;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    }, t("WebsitePreviewOpening"));
  }

  async function handlePublish() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await saveDraft(websiteDraftInput(activeOrgId));
      await publishWebsite({ orgId: activeOrgId });
    }, t("WebsitePublished"));
  }

  const wizardSteps = [
    "WebsiteStepAddress",
    "WebsiteStepData",
    "WebsiteStepTheme",
    "WebsiteStepRouting",
    "WebsiteStepReview",
  ];
  const nextStepLabel = step < wizardSteps.length ? t(wizardSteps[step]) : "";
  const translatedStatus = t(`WebsiteStatus_${statusLabel}`);

  return (
    <div className="flex-1 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("WebsitePageTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("WebsitePageSubtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleCreate} disabled={isBusy || !activeOrgId}>
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
            {t("WebsiteCreate")}
          </Button>
          <Button variant="outline" onClick={() => setStep(1)} disabled={!setupExists}>
            <LayoutTemplate className="h-4 w-4" />
            {t("WebsiteEditSettings")}
          </Button>
          <Button variant="outline" onClick={handlePreview} disabled={!setupExists || isBusy}>
            <ExternalLink className="h-4 w-4" />
            {t("WebsitePreview")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("WebsiteStatus")}</CardDescription>
            <CardTitle><Badge variant={statusVariant(statusLabel)}>{translatedStatus}</Badge></CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("WebsiteDefaultSubdomain")}</CardDescription>
            <CardTitle className="text-sm break-words">{status?.settings?.defaultSubdomain ?? t("WebsiteNotSelected")}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("WebsiteCustomPurchasedDomain")}</CardDescription>
            <CardTitle className="text-sm break-words">
              {status?.domains?.find((domain) => domain.type === "purchased_custom_domain")?.domain ?? t("WebsiteNone")}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("WebsiteDnsSslStatus")}</CardDescription>
            <CardTitle className="text-sm">
              {status?.primaryDomain ? `${status.primaryDomain.dnsStatus} / ${status.primaryDomain.sslStatus}` : t("WebsiteNotConfigured")}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("WebsiteLastPublished")}</CardDescription>
            <CardTitle className="text-sm">
              {status?.settings?.publishedAt ? new Date(status.settings.publishedAt).toLocaleString(locale === "ar" ? "ar-JO" : "en-US") : t("WebsiteNever")}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>{t("WebsiteSafetyTitle")}</AlertTitle>
        <AlertDescription>
          {t("WebsiteSafetyDescription")}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2">
        {wizardSteps.map((label, index) => (
          <Button
            key={label}
            variant={step === index + 1 ? "default" : "outline"}
            size="sm"
            onClick={() => setStep(index + 1)}
            disabled={!setupExists && index > 0}
          >
            {index + 1}. {t(label)}
          </Button>
        ))}
      </div>

      {step === 1 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("WebsiteFreeSubdomainTitle")}</CardTitle>
              <CardDescription>{t("WebsiteFreeSubdomainDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t("WebsiteDesiredSlug")}</Label>
                <div className="flex gap-2">
                  <Input
                    value={subdomainSlug}
                    onChange={(event) => {
                      setSubdomainSlug(event.target.value);
                      setSubdomainCheckResult(null);
                    }}
                    placeholder="premiumcars"
                  />
                  <Button variant="outline" onClick={handleCheckSubdomain} disabled={isBusy}>
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("WebsiteSubdomainHelp")}</p>
              </div>
              {subdomainSlug && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  https://{subdomainSlug.toLowerCase()}.autoflowdealer.com
                </div>
              )}
              {subdomainCheckResult && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    {subdomainCheckResult.available ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                    <span>{subdomainCheckResult.available ? t("WebsiteAvailable") : subdomainCheckResult.error ?? t("WebsiteUnavailable")}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("WebsiteCustomDomainTitle")}</CardTitle>
              <CardDescription>{t("WebsiteCustomDomainDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t("WebsiteDomainName")}</Label>
                <div className="flex gap-2">
                  <Input
                    value={customDomain}
                    onChange={(event) => {
                      setCustomDomain(event.target.value);
                      setCustomDomainSearchResult(null);
                    }}
                    placeholder="premiumcarsjo.com"
                  />
                  <Button variant="outline" onClick={handleSearchDomain} disabled={isBusy}>
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {customDomainSearchResult && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    {customDomainSearchResult.available ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                    <span>{customDomainSearchResult.available ? t("WebsiteAvailable") : customDomainSearchResult.error ?? t("WebsiteUnavailable")}</span>
                  </div>
                  {customDomainSearchResult.available && customDomainSearchResult.price != null && (
                    <div className="mt-3 flex items-center justify-between">
                      <span>{customDomainSearchResult.domain} · {customDomainSearchResult.price} {customDomainSearchResult.currency}</span>
                      <Button size="sm" onClick={handlePurchaseDomain} disabled={isBusy}>{t("WebsiteMockPurchase")}</Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">{t("WebsiteSelectDataTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("WebsitePublicSectionsEnabled").replace("{0}", String(enabledCount))}</p>
            </div>
            <Button onClick={handleSaveDraft} disabled={isBusy}>
              <Save className="h-4 w-4" />
              {t("WebsiteSaveDraft")}
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {WEBSITE_SECTION_GROUPS.map((group) => (
              <Card key={group.title}>
                <CardHeader>
                  <CardTitle className="text-base">{t(group.title)}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {group.keys.map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-4 rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{t(label)}</p>
                        {SENSITIVE_WEBSITE_SECTION_KEYS.has(key) && (
                          <p className="text-xs text-amber-700">{t("WebsiteSensitiveOption")}</p>
                        )}
                        {key === "vehicle.vinChassis" && (
                          <p className="text-xs text-muted-foreground">{t("WebsiteVinWarning")}</p>
                        )}
                      </div>
                      <Switch checked={sections[key] ?? false} onCheckedChange={(checked) => setSections((prev) => ({ ...prev, [key]: checked }))} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("WebsiteThemeTitle")}</CardTitle>
            <CardDescription>{t("WebsiteThemeDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("WebsiteTemplate")}</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="modern-showroom">{t("WebsiteTemplateModernShowroom")}</SelectItem>
                  <SelectItem value="classic-inventory">{t("WebsiteTemplateClassicInventory")}</SelectItem>
                  <SelectItem value="premium-minimal">{t("WebsiteTemplatePremiumMinimal")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("WebsiteDefaultLanguage")}</Label>
              <Select value={defaultLanguage} onValueChange={(value) => setDefaultLanguage(value as "en" | "ar")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">{t("WebsiteEnglish")}</SelectItem>
                  <SelectItem value="ar">{t("WebsiteArabic")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("WebsitePrimaryColor")}</Label>
              <div className="flex gap-3">
                <input type="color" value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} className="h-10 w-14 rounded border p-1" />
                <Input value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("WebsiteSecondaryColor")}</Label>
              <div className="flex gap-3">
                <input type="color" value={secondaryColor} onChange={(event) => setSecondaryColor(event.target.value)} className="h-10 w-14 rounded border p-1" />
                <Input value={secondaryColor} onChange={(event) => setSecondaryColor(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label>{t("WebsiteHeroText")}</Label>
              <Input value={heroTitle} onChange={(event) => setHeroTitle(event.target.value)} placeholder={t("WebsiteHeroPlaceholder")} />
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label>{t("WebsiteSloganSubtitle")}</Label>
              <Textarea value={heroSubtitle} onChange={(event) => setHeroSubtitle(event.target.value)} placeholder={t("WebsiteSloganPlaceholder")} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3 lg:col-span-2">
              <div>
                <p className="text-sm font-medium">{t("WebsiteEnableArabicSupport")}</p>
                <p className="text-xs text-muted-foreground">{t("WebsiteEnableArabicDescription")}</p>
              </div>
              <Switch checked={supportArabic} onCheckedChange={setSupportArabic} />
            </div>
            <div className="lg:col-span-2 flex justify-end">
              <Button onClick={handleSaveDraft} disabled={isBusy}>
                <Palette className="h-4 w-4" />
                {t("WebsiteSaveTheme")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("WebsiteLeadRoutingTitle")}</CardTitle>
            <CardDescription>{t("WebsiteLeadRoutingDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {WEBSITE_FORM_TYPES.map(([formType, label]) => (
              <div key={formType} className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
                <div>
                  <p className="font-medium">{t(label)}</p>
                  <p className="text-xs text-muted-foreground">{formType === "test_drive" ? t("WebsiteLeadCreatesLeadAndTask") : t("WebsiteLeadCreatesLead")}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={routing[formType]?.createTask ?? formType === "test_drive"} onCheckedChange={(checked) => setRouting((prev) => ({ ...prev, [formType]: { createTask: checked, notifyByEmail: prev[formType]?.notifyByEmail ?? true, notifyByWhatsApp: prev[formType]?.notifyByWhatsApp ?? false } }))} />
                  {t("WebsiteCreateTask")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={routing[formType]?.notifyByEmail ?? true} onCheckedChange={(checked) => setRouting((prev) => ({ ...prev, [formType]: { createTask: prev[formType]?.createTask ?? formType === "test_drive", notifyByEmail: checked, notifyByWhatsApp: prev[formType]?.notifyByWhatsApp ?? false } }))} />
                  {t("WebsiteEmail")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={routing[formType]?.notifyByWhatsApp ?? false} onCheckedChange={(checked) => setRouting((prev) => ({ ...prev, [formType]: { createTask: prev[formType]?.createTask ?? formType === "test_drive", notifyByEmail: prev[formType]?.notifyByEmail ?? true, notifyByWhatsApp: checked } }))} />
                  WhatsApp
                </label>
              </div>
            ))}
            <div className="flex justify-end">
              <Button onClick={handleSaveDraft} disabled={isBusy}>
                <Route className="h-4 w-4" />
                {t("WebsiteSaveRouting")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 5 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("WebsiteReviewTitle")}</CardTitle>
            <CardDescription>{t("WebsiteReviewDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{t("WebsiteSelectedAddress")}</p>
                <p className="font-medium break-words">{selectedAddress ?? t("WebsiteChooseAddressFirst")}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{t("WebsiteTemplate")}</p>
                <p className="font-medium">{templateId}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{t("WebsitePublicSections")}</p>
                <p className="font-medium">{t("WebsiteEnabledCount").replace("{0}", String(enabledCount))}</p>
              </div>
            </div>
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t("WebsitePublicDataSafetyTitle")}</AlertTitle>
              <AlertDescription>
                {t("WebsitePublicDataSafetyDescription")}
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={handleSaveDraft} disabled={isBusy}>
                <Save className="h-4 w-4" />
                {t("WebsiteSaveDraft")}
              </Button>
              <Button variant="outline" onClick={handlePreview} disabled={!setupExists || isBusy}>
                <ExternalLink className="h-4 w-4" />
                {t("WebsitePreview")}
              </Button>
              {statusLabel === "active" && (
                <Button
                  variant="outline"
                  onClick={() => activeOrgId && runAction(async () => {
                    await unpublishWebsite({ orgId: activeOrgId });
                  }, t("WebsiteUnpublished"))}
                  disabled={isBusy}
                >
                  {t("WebsiteUnpublish")}
                </Button>
              )}
              <Button onClick={handlePublish} disabled={isBusy || !canPublish}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t("WebsitePublish")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="outline"
          onClick={() => setStep((currentStep) => Math.max(1, currentStep - 1))}
          disabled={step === 1 || isBusy}
        >
          {t("WebsiteBack")}
        </Button>
        {step < wizardSteps.length && (
          <Button
            onClick={() => setStep((currentStep) => Math.min(wizardSteps.length, currentStep + 1))}
            disabled={isBusy || (!setupExists && step === 1)}
          >
            {t("WebsiteNext")}
            {nextStepLabel ? `: ${nextStepLabel}` : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
