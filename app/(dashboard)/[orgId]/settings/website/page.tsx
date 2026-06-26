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
import {
  SENSITIVE_WEBSITE_SECTION_KEYS,
  WEBSITE_FORM_TYPES,
  WEBSITE_SECTION_GROUPS,
} from "@/lib/website/websiteSetupConfig";

type SectionState = Record<string, boolean>;

function statusVariant(status?: string) {
  if (status === "active") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

export default function WebsiteSettingsPage() {
  const { activeOrgId } = useOrg();
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
  const [domainSearchResult, setDomainSearchResult] = useState<null | {
    available?: boolean;
    error?: string | null;
    domain?: string;
    price?: number;
    currency?: string;
    provider?: string;
  }>(null);
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
  const previewUrl = primaryDomain ? `https://${primaryDomain}` : null;

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

  async function runAction(action: () => Promise<void>, success: string) {
    setIsBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      console.error("Website settings action failed", error);
      toast.error("An unexpected error occurred. Please try again later.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreate() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await startSetup({ orgId: activeOrgId });
      setStep(1);
    }, "Website setup created.");
  }

  async function handleCheckSubdomain() {
    if (!activeOrgId || !subdomainSlug.trim()) return;
    setIsBusy(true);
    try {
      const result = await checkSubdomain({ orgId: activeOrgId, slug: subdomainSlug });
      setDomainSearchResult(result);
    } catch (error) {
      console.error("Subdomain check failed", error);
      toast.error("An unexpected error occurred. Please try again later.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSearchDomain() {
    if (!activeOrgId || !customDomain.trim()) return;
    setIsBusy(true);
    try {
      const result = await searchDomain({ orgId: activeOrgId, domain: customDomain });
      setDomainSearchResult(result);
    } catch (error) {
      console.error("Domain search failed", error);
      toast.error("An unexpected error occurred. Please try again later.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePurchaseDomain() {
    if (!activeOrgId || !domainSearchResult?.domain) return;
    await runAction(async () => {
      await purchaseDomain({ orgId: activeOrgId, domain: domainSearchResult.domain! });
    }, "Mock domain purchase completed.");
  }

  async function handleSaveDraft() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await saveDraft({
        orgId: activeOrgId,
        subdomainSlug: subdomainSlug.trim() || undefined,
        templateId,
        defaultLanguage,
        supportedLanguages: supportArabic ? ["en", "ar"] : [defaultLanguage],
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
      });
    }, "Website draft saved.");
  }

  async function handlePublish() {
    if (!activeOrgId) return;
    await runAction(async () => {
      await saveDraft({
        orgId: activeOrgId,
        subdomainSlug: subdomainSlug.trim() || undefined,
        templateId,
        defaultLanguage,
        supportedLanguages: supportArabic ? ["en", "ar"] : [defaultLanguage],
        primaryColor,
        secondaryColor,
        heroTitle: heroTitle.trim() || undefined,
        heroSubtitle: heroSubtitle.trim() || undefined,
        sections: Object.entries(sections).map(([sectionKey, enabled]) => ({ sectionKey, enabled })),
      });
      await publishWebsite({ orgId: activeOrgId });
    }, "Website published.");
  }

  const statusLabel = status?.settings?.status ?? "disabled";

  return (
    <div className="flex-1 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create your dealership website</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Select what AutoFlow data appears on your website and publish it safely.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleCreate} disabled={isBusy || !activeOrgId}>
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
            Create Website
          </Button>
          <Button variant="outline" onClick={() => setStep(1)} disabled={!status?.settings}>
            <LayoutTemplate className="h-4 w-4" />
            Edit Website Settings
          </Button>
          <Button variant="outline" asChild disabled={!previewUrl}>
            <a href={previewUrl ?? "#"} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Preview Website
            </a>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Website status</CardDescription>
            <CardTitle><Badge variant={statusVariant(statusLabel)}>{statusLabel}</Badge></CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Default AutoFlow subdomain</CardDescription>
            <CardTitle className="text-sm break-words">{status?.settings?.defaultSubdomain ?? "Not selected"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Custom purchased domain</CardDescription>
            <CardTitle className="text-sm break-words">
              {status?.domains?.find((domain) => domain.type === "purchased_custom_domain")?.domain ?? "None"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>DNS / SSL status</CardDescription>
            <CardTitle className="text-sm">
              {status?.primaryDomain ? `${status.primaryDomain.dnsStatus} / ${status.primaryDomain.sslStatus}` : "Not configured"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last published</CardDescription>
            <CardTitle className="text-sm">
              {status?.settings?.publishedAt ? new Date(status.settings.publishedAt).toLocaleString() : "Never"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Only public-safe data can be published</AlertTitle>
        <AlertDescription>
          Customer records, internal notes, acquisition costs, profit, margins, commissions, tasks, payment records, and accounting data are never included in the public website projection.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2">
        {["Choose address", "Select public data", "Theme and layout", "Lead routing", "Review and publish"].map((label, index) => (
          <Button
            key={label}
            variant={step === index + 1 ? "default" : "outline"}
            size="sm"
            onClick={() => setStep(index + 1)}
            disabled={!status?.settings && index > 0}
          >
            {index + 1}. {label}
          </Button>
        ))}
      </div>

      {step === 1 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Use a free AutoFlow subdomain</CardTitle>
              <CardDescription>Example: https://premiumcars.autoflowdealer.com</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Desired slug</Label>
                <div className="flex gap-2">
                  <Input value={subdomainSlug} onChange={(event) => setSubdomainSlug(event.target.value)} placeholder="premiumcars" />
                  <Button variant="outline" onClick={handleCheckSubdomain} disabled={isBusy}>
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only. Uses autoflowdealer.com.</p>
              </div>
              {subdomainSlug && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  https://{subdomainSlug.toLowerCase()}.autoflowdealer.com
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Buy a custom domain through AutoFlow</CardTitle>
              <CardDescription>Registrar integration is mocked behind a clean service abstraction.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Domain name</Label>
                <div className="flex gap-2">
                  <Input value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} placeholder="premiumcarsjo.com" />
                  <Button variant="outline" onClick={handleSearchDomain} disabled={isBusy}>
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {domainSearchResult && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    {domainSearchResult.available ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                    <span>{domainSearchResult.available ? "Available" : domainSearchResult.error ?? "Unavailable"}</span>
                  </div>
                  {domainSearchResult.available && domainSearchResult.price != null && (
                    <div className="mt-3 flex items-center justify-between">
                      <span>{domainSearchResult.domain} · {domainSearchResult.price} {domainSearchResult.currency}</span>
                      <Button size="sm" onClick={handlePurchaseDomain} disabled={isBusy}>Mock purchase</Button>
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
              <h2 className="text-lg font-semibold">Select what AutoFlow data appears on your website</h2>
              <p className="text-sm text-muted-foreground">{enabledCount} public sections enabled</p>
            </div>
            <Button onClick={handleSaveDraft} disabled={isBusy}>
              <Save className="h-4 w-4" />
              Save as draft
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {WEBSITE_SECTION_GROUPS.map((group) => (
              <Card key={group.title}>
                <CardHeader>
                  <CardTitle className="text-base">{group.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {group.keys.map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-4 rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        {SENSITIVE_WEBSITE_SECTION_KEYS.has(key) && (
                          <p className="text-xs text-amber-700">Sensitive option. Disabled by default.</p>
                        )}
                        {key === "vehicle.vinChassis" && (
                          <p className="text-xs text-muted-foreground">Plate number, internal notes, acquisition cost, and profit never publish.</p>
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
            <CardTitle>Theme and layout</CardTitle>
            <CardDescription>Preview before publishing, with EN/AR and RTL-ready configuration.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              <Label>Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="modern-showroom">Modern Showroom</SelectItem>
                  <SelectItem value="classic-inventory">Classic Inventory</SelectItem>
                  <SelectItem value="premium-minimal">Premium Minimal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Default language</Label>
              <Select value={defaultLanguage} onValueChange={(value) => setDefaultLanguage(value as "en" | "ar")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ar">Arabic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Primary color</Label>
              <div className="flex gap-3">
                <input type="color" value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} className="h-10 w-14 rounded border p-1" />
                <Input value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Secondary color</Label>
              <div className="flex gap-3">
                <input type="color" value={secondaryColor} onChange={(event) => setSecondaryColor(event.target.value)} className="h-10 w-14 rounded border p-1" />
                <Input value={secondaryColor} onChange={(event) => setSecondaryColor(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label>Homepage hero text</Label>
              <Input value={heroTitle} onChange={(event) => setHeroTitle(event.target.value)} placeholder="Premium cars, ready to drive" />
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label>Slogan / subtitle</Label>
              <Textarea value={heroSubtitle} onChange={(event) => setHeroSubtitle(event.target.value)} placeholder="Browse available vehicles and speak with our sales team." />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3 lg:col-span-2">
              <div>
                <p className="text-sm font-medium">Enable Arabic support</p>
                <p className="text-xs text-muted-foreground">Public pages use RTL layout when Arabic is selected.</p>
              </div>
              <Switch checked={supportArabic} onCheckedChange={setSupportArabic} />
            </div>
            <div className="lg:col-span-2 flex justify-end">
              <Button onClick={handleSaveDraft} disabled={isBusy}>
                <Palette className="h-4 w-4" />
                Save theme
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle>Lead destination settings</CardTitle>
            <CardDescription>Website actions create AutoFlow records and can create follow-up tasks.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {WEBSITE_FORM_TYPES.map(([formType, label]) => (
              <div key={formType} className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
                <div>
                  <p className="font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">Creates a lead{formType === "test_drive" ? " and optional task/calendar item" : ""}.</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={routing[formType]?.createTask ?? formType === "test_drive"} onCheckedChange={(checked) => setRouting((prev) => ({ ...prev, [formType]: { createTask: checked, notifyByEmail: prev[formType]?.notifyByEmail ?? true, notifyByWhatsApp: prev[formType]?.notifyByWhatsApp ?? false } }))} />
                  Create task
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={routing[formType]?.notifyByEmail ?? true} onCheckedChange={(checked) => setRouting((prev) => ({ ...prev, [formType]: { createTask: prev[formType]?.createTask ?? formType === "test_drive", notifyByEmail: checked, notifyByWhatsApp: prev[formType]?.notifyByWhatsApp ?? false } }))} />
                  Email
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
                Save routing
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 5 && (
        <Card>
          <CardHeader>
            <CardTitle>Review and publish</CardTitle>
            <CardDescription>Preview before publishing. Purchased domain billing hooks are logged as placeholder events.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Selected address</p>
                <p className="font-medium break-words">{primaryDomain ?? "Choose an address first"}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Template</p>
                <p className="font-medium">{templateId}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Public sections</p>
                <p className="font-medium">{enabledCount} enabled</p>
              </div>
            </div>
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Public data safety check</AlertTitle>
              <AlertDescription>
                Internal notes, acquisition cost, landed cost, minimum profit, margins, commissions, lead notes, customer records, accounting data, and private documents are excluded from the public API.
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={handleSaveDraft} disabled={isBusy}>
                <Save className="h-4 w-4" />
                Save as draft
              </Button>
              <Button variant="outline" asChild disabled={!previewUrl}>
                <a href={previewUrl ?? "#"} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Preview website
                </a>
              </Button>
              {statusLabel === "active" && (
                <Button
                  variant="outline"
                  onClick={() => activeOrgId && runAction(async () => {
                    await unpublishWebsite({ orgId: activeOrgId });
                  }, "Website unpublished.")}
                  disabled={isBusy}
                >
                  Unpublish
                </Button>
              )}
              <Button onClick={handlePublish} disabled={isBusy || !primaryDomain}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Publish website
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
