"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Camera, CheckCircle2, Plus, Trash2, ChevronDown, ChevronUp, UserCheck } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { socialSmartReplyEn, socialSmartReplyAr } from "@/lib/i18n/domains/socialSmartReply";
import { DEFAULT_MOBILE_RECEIVED_AUTO_REPLY } from "@/convex/utils/socialMobileReply";

const MAX_AUTO_REPLY_MESSAGES = 5;

type TemplateMap = Record<string, string>;

const TEMPLATE_KEYS: Array<{ key: string; label: string; placeholder: keyof typeof socialSmartReplyEn }> = [
  { key: "greeting", label: "SmartReplyTplGreeting", placeholder: "SmartReplyGreeting" },
  { key: "location", label: "SmartReplyTplLocation", placeholder: "SmartReplyLocation" },
  { key: "locationFallback", label: "SmartReplyTplLocationFallback", placeholder: "SmartReplyLocationFallback" },
  { key: "priceAvailable", label: "SmartReplyTplPriceAvailable", placeholder: "SmartReplyPriceAvailable" },
  { key: "financingGeneric", label: "SmartReplyTplFinancingGeneric", placeholder: "SmartReplyFinancingGeneric" },
  { key: "financingCalculated", label: "SmartReplyTplFinancingCalculated", placeholder: "SmartReplyFinancingCalculated" },
  { key: "availableYes", label: "SmartReplyTplAvailableYes", placeholder: "SmartReplyAvailableYes" },
  { key: "availableSold", label: "SmartReplyTplAvailableSold", placeholder: "SmartReplyAvailableSold" },
  { key: "availableUnclear", label: "SmartReplyTplAvailableUnclear", placeholder: "SmartReplyAvailableUnclear" },
  { key: "vehicleInfo", label: "SmartReplyTplVehicleInfo", placeholder: "SmartReplyVehicleInfo" },
];

function parseTemplates(json: string | undefined): TemplateMap {
  if (!json) return {};
  try { return JSON.parse(json) as TemplateMap; } catch { return {}; }
}

export function IntegrationsClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();

  const igStatus = useQuery(
    api.socialIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const fbStatus = useQuery(
    api.facebookIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const orgSettings = useQuery(api.orgSettings.get, activeOrgId ? { orgId: activeOrgId } : "skip");
  const financeCompanies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createInstagramConnectUrl = useMutation(api.socialIntegrations.createConnectUrl);
  const disconnectInstagram = useMutation(api.socialIntegrations.disconnect);
  const setAutoPostEnabled = useMutation(api.socialIntegrations.setAutoPostEnabled);
  const setInstagramAutoReplyConfig = useMutation(api.socialIntegrations.setInstagramAutoReplyConfig);
  const setInstagramLeadCreationConfig = useMutation(api.socialIntegrations.setInstagramLeadCreationConfig);

  const createFacebookConnectUrl = useMutation(api.facebookIntegrations.createConnectUrl);
  const disconnectFacebook = useMutation(api.facebookIntegrations.disconnect);
  const selectFacebookPage = useAction(api.facebookIntegrations.selectFacebookPage);
  const setFacebookAutoReplyConfig = useMutation(api.facebookIntegrations.setFacebookAutoReplyConfig);
  const setFacebookLeadCreationConfig = useMutation(api.facebookIntegrations.setFacebookLeadCreationConfig);

  const setSmartReplyConfig = useMutation(api.smartReply.setSmartReplyConfig);
  const setGeneratedLeadAutoAssignmentEnabled = useMutation(api.orgSettings.setGeneratedLeadAutoAssignmentEnabled);

  // ── Instagram state ──
  const [igAutoReplyForDms, setIgAutoReplyForDms] = useState(false);
  const [igAutoReplyForComments, setIgAutoReplyForComments] = useState(false);
  const [igAutoReplyMessages, setIgAutoReplyMessages] = useState<string[]>([]);
  const [igMobileReceivedReply, setIgMobileReceivedReply] = useState(DEFAULT_MOBILE_RECEIVED_AUTO_REPLY);
  const [igAutoReplyLoaded, setIgAutoReplyLoaded] = useState(false);
  const [igSavingAutoReply, setIgSavingAutoReply] = useState(false);
  const [igLeadFromComments, setIgLeadFromComments] = useState(true);
  const [igLeadFromDms, setIgLeadFromDms] = useState(true);
  const [igLeadFromDmsRequiresMobile, setIgLeadFromDmsRequiresMobile] = useState(false);

  // ── Facebook state ──
  const [fbAutoReplyForDms, setFbAutoReplyForDms] = useState(false);
  const [fbAutoReplyForComments, setFbAutoReplyForComments] = useState(false);
  const [fbAutoReplyMessages, setFbAutoReplyMessages] = useState<string[]>([]);
  const [fbMobileReceivedReply, setFbMobileReceivedReply] = useState(DEFAULT_MOBILE_RECEIVED_AUTO_REPLY);
  const [fbAutoReplyLoaded, setFbAutoReplyLoaded] = useState(false);
  const [fbSavingAutoReply, setFbSavingAutoReply] = useState(false);
  const [fbLeadFromComments, setFbLeadFromComments] = useState(true);
  const [fbLeadFromDms, setFbLeadFromDms] = useState(true);
  const [fbLeadFromDmsRequiresMobile, setFbLeadFromDmsRequiresMobile] = useState(false);
  const [fbSelectingPage, setFbSelectingPage] = useState(false);

  // ── Generated lead assignment state ──
  const [autoAssignGeneratedLeads, setAutoAssignGeneratedLeads] = useState(false);
  const [autoAssignLoadedOrgId, setAutoAssignLoadedOrgId] = useState<string | null>(null);
  const [savingAutoAssign, setSavingAutoAssign] = useState(false);

  // ── Smart Reply state ──
  const [smartReplyLoaded, setSmartReplyLoaded] = useState(false);
  const [igSmartReplyForDms, setIgSmartReplyForDms] = useState(false);
  const [igSmartReplyForComments, setIgSmartReplyForComments] = useState(false);
  const [fbSmartReplyForDms, setFbSmartReplyForDms] = useState(false);
  const [fbSmartReplyForComments, setFbSmartReplyForComments] = useState(false);
  const [smartReplyFinancingMode, setSmartReplyFinancingMode] = useState<"calculated" | "generic">("generic");
  const [smartReplyDownPaymentPercent, setSmartReplyDownPaymentPercent] = useState("20");
  const [smartReplyFinanceCompanyId, setSmartReplyFinanceCompanyId] = useState<string>("");
  const [smartReplyVisibility, setSmartReplyVisibility] = useState<"public" | "dm">("public");
  const [savingSmartReply, setSavingSmartReply] = useState(false);

  // ── Templates state ──
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesEn, setTemplatesEn] = useState<TemplateMap>({});
  const [templatesAr, setTemplatesAr] = useState<TemplateMap>({});
  const [templateTab, setTemplateTab] = useState<"en" | "ar">("en");
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplates, setSavingTemplates] = useState(false);

  // ── Load server state once ──
  useEffect(() => {
    if (!igStatus || igAutoReplyLoaded) return;
    setIgAutoReplyForDms(igStatus.instagramAutoReplyForDmsEnabled);
    setIgAutoReplyForComments(igStatus.instagramAutoReplyForCommentsEnabled);
    setIgAutoReplyMessages(igStatus.instagramAutoReplyMessages.length > 0 ? igStatus.instagramAutoReplyMessages : [""]);
    setIgMobileReceivedReply(
      igStatus.instagramAutoReplyMobileReceivedMessage ?? DEFAULT_MOBILE_RECEIVED_AUTO_REPLY
    );
    setIgLeadFromComments(igStatus.instagramLeadFromCommentsEnabled);
    setIgLeadFromDms(igStatus.instagramLeadFromDmsEnabled);
    setIgLeadFromDmsRequiresMobile(igStatus.instagramLeadFromDmsRequiresMobile);
    setIgAutoReplyLoaded(true);
  }, [igStatus, igAutoReplyLoaded]);

  useEffect(() => {
    if (!fbStatus || fbAutoReplyLoaded) return;
    setFbAutoReplyForDms(fbStatus.facebookAutoReplyForDmsEnabled);
    setFbAutoReplyForComments(fbStatus.facebookAutoReplyForCommentsEnabled);
    setFbAutoReplyMessages(fbStatus.facebookAutoReplyMessages.length > 0 ? fbStatus.facebookAutoReplyMessages : [""]);
    setFbMobileReceivedReply(
      fbStatus.facebookAutoReplyMobileReceivedMessage ?? DEFAULT_MOBILE_RECEIVED_AUTO_REPLY
    );
    setFbLeadFromComments(fbStatus.facebookLeadFromCommentsEnabled);
    setFbLeadFromDms(fbStatus.facebookLeadFromDmsEnabled);
    setFbLeadFromDmsRequiresMobile(fbStatus.facebookLeadFromDmsRequiresMobile);
    setFbAutoReplyLoaded(true);
  }, [fbStatus, fbAutoReplyLoaded]);

  useEffect(() => {
    if (!activeOrgId || autoAssignLoadedOrgId === activeOrgId || orgSettings === undefined) return;
    setAutoAssignGeneratedLeads(orgSettings?.generatedLeadAutoAssignmentEnabled ?? false);
    setAutoAssignLoadedOrgId(activeOrgId);
  }, [activeOrgId, orgSettings, autoAssignLoadedOrgId]);

  useEffect(() => {
    if (smartReplyLoaded || !igStatus || !fbStatus) return;
    setIgSmartReplyForDms(igStatus.instagramSmartReplyForDmsEnabled);
    setIgSmartReplyForComments(igStatus.instagramSmartReplyForCommentsEnabled);
    setFbSmartReplyForDms(fbStatus.facebookSmartReplyForDmsEnabled);
    setFbSmartReplyForComments(fbStatus.facebookSmartReplyForCommentsEnabled);
    setSmartReplyFinancingMode(igStatus.smartReplyFinancingMode);
    setSmartReplyDownPaymentPercent(String(igStatus.smartReplyDefaultDownPaymentPercent ?? 20));
    setSmartReplyFinanceCompanyId(igStatus.smartReplyDefaultFinanceCompanyId ?? "");
    setSmartReplyVisibility(igStatus.smartReplyVisibility);
    setSmartReplyLoaded(true);
  }, [igStatus, fbStatus, smartReplyLoaded]);

  useEffect(() => {
    if (templatesLoaded || !igStatus) return;
    setTemplatesEn(parseTemplates(igStatus.smartReplyCustomTemplatesEn));
    setTemplatesAr(parseTemplates(igStatus.smartReplyCustomTemplatesAr));
    setTemplatesLoaded(true);
  }, [igStatus, templatesLoaded]);

  // ── OAuth redirect result ──
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const errorMessage = searchParams.get("errorMessage");
    if (!connected) return;

    if (connected === "facebook") {
      if (error) {
        toast.error(errorMessage ? `${t("FacebookConnectFailed" as any)} ${errorMessage}` : t("FacebookConnectFailed" as any));
      } else {
        toast.success(t("FacebookConnectedSuccess" as any));
      }
    } else {
      if (error) {
        toast.error(errorMessage ? `${t("InstagramConnectFailed" as any)} ${errorMessage}` : t("InstagramConnectFailed" as any));
      } else {
        toast.success(t("InstagramConnectedSuccess" as any));
      }
    }
    router.replace(`/${activeOrgId}/settings/integrations`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleConnectInstagram = async () => {
    if (!activeOrgId) return;
    try {
      const url = await createInstagramConnectUrl({ orgId: activeOrgId });
      window.location.href = url;
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleDisconnectInstagram = async () => {
    if (!activeOrgId) return;
    try {
      await disconnectInstagram({ orgId: activeOrgId });
      toast.success(t("InstagramDisconnectedSuccess" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleConnectFacebook = async () => {
    if (!activeOrgId) return;
    try {
      const url = await createFacebookConnectUrl({ orgId: activeOrgId });
      window.location.href = url;
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleDisconnectFacebook = async () => {
    if (!activeOrgId) return;
    try {
      await disconnectFacebook({ orgId: activeOrgId });
      toast.success(t("FacebookDisconnectedSuccess" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleSelectFacebookPage = async (pageId: string) => {
    if (!activeOrgId) return;
    setFbSelectingPage(true);
    try {
      await selectFacebookPage({ orgId: activeOrgId, pageId });
      toast.success(t("FacebookConnectedSuccess" as any));
    } catch (error: any) {
      toast.error(error?.message ?? String(error));
    } finally {
      setFbSelectingPage(false);
    }
  };

  const handleToggleAutoPost = async (enabled: boolean) => {
    if (!activeOrgId) return;
    try {
      await setAutoPostEnabled({ orgId: activeOrgId, enabled });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleSaveIgAutoReply = async (overrides?: {
    enabledForDms?: boolean;
    enabledForComments?: boolean;
    messages?: string[];
    mobileReceivedMessage?: string;
  }) => {
    if (!activeOrgId) return;
    const enabledForDms = overrides?.enabledForDms ?? igAutoReplyForDms;
    const enabledForComments = overrides?.enabledForComments ?? igAutoReplyForComments;
    const messages = overrides?.messages ?? igAutoReplyMessages;
    const mobileReceivedMessage = overrides?.mobileReceivedMessage ?? igMobileReceivedReply;
    setIgSavingAutoReply(true);
    try {
      await setInstagramAutoReplyConfig({
        orgId: activeOrgId,
        enabledForDms,
        enabledForComments,
        messages: messages.filter((m) => m.trim().length > 0),
        mobileReceivedMessage,
      });
      toast.success(t("AutoRepliesSaved" as any));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIgSavingAutoReply(false);
    }
  };

  const handleSaveFbAutoReply = async (overrides?: {
    enabledForDms?: boolean;
    enabledForComments?: boolean;
    messages?: string[];
    mobileReceivedMessage?: string;
  }) => {
    if (!activeOrgId) return;
    const enabledForDms = overrides?.enabledForDms ?? fbAutoReplyForDms;
    const enabledForComments = overrides?.enabledForComments ?? fbAutoReplyForComments;
    const messages = overrides?.messages ?? fbAutoReplyMessages;
    const mobileReceivedMessage = overrides?.mobileReceivedMessage ?? fbMobileReceivedReply;
    setFbSavingAutoReply(true);
    try {
      await setFacebookAutoReplyConfig({
        orgId: activeOrgId,
        enabledForDms,
        enabledForComments,
        messages: messages.filter((m) => m.trim().length > 0),
        mobileReceivedMessage,
      });
      toast.success(t("AutoRepliesSaved" as any));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setFbSavingAutoReply(false);
    }
  };

  const handleToggleIgLeadCreation = async (overrides: {
    leadFromComments?: boolean;
    leadFromDms?: boolean;
    leadFromDmsRequiresMobile?: boolean;
  }) => {
    if (!activeOrgId) return;
    const leadFromCommentsEnabled = overrides.leadFromComments ?? igLeadFromComments;
    const leadFromDmsEnabled = overrides.leadFromDms ?? igLeadFromDms;
    const leadFromDmsRequiresMobile = overrides.leadFromDmsRequiresMobile ?? igLeadFromDmsRequiresMobile;
    if (overrides.leadFromComments !== undefined) setIgLeadFromComments(overrides.leadFromComments);
    if (overrides.leadFromDms !== undefined) setIgLeadFromDms(overrides.leadFromDms);
    if (overrides.leadFromDmsRequiresMobile !== undefined) {
      setIgLeadFromDmsRequiresMobile(overrides.leadFromDmsRequiresMobile);
    }
    try {
      await setInstagramLeadCreationConfig({
        orgId: activeOrgId,
        leadFromCommentsEnabled,
        leadFromDmsEnabled,
        leadFromDmsRequiresMobile,
      });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleToggleFbLeadCreation = async (overrides: {
    leadFromComments?: boolean;
    leadFromDms?: boolean;
    leadFromDmsRequiresMobile?: boolean;
  }) => {
    if (!activeOrgId) return;
    const leadFromCommentsEnabled = overrides.leadFromComments ?? fbLeadFromComments;
    const leadFromDmsEnabled = overrides.leadFromDms ?? fbLeadFromDms;
    const leadFromDmsRequiresMobile = overrides.leadFromDmsRequiresMobile ?? fbLeadFromDmsRequiresMobile;
    if (overrides.leadFromComments !== undefined) setFbLeadFromComments(overrides.leadFromComments);
    if (overrides.leadFromDms !== undefined) setFbLeadFromDms(overrides.leadFromDms);
    if (overrides.leadFromDmsRequiresMobile !== undefined) {
      setFbLeadFromDmsRequiresMobile(overrides.leadFromDmsRequiresMobile);
    }
    try {
      await setFacebookLeadCreationConfig({
        orgId: activeOrgId,
        leadFromCommentsEnabled,
        leadFromDmsEnabled,
        leadFromDmsRequiresMobile,
      });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleToggleGeneratedLeadAutoAssignment = async (enabled: boolean) => {
    if (!activeOrgId) return;
    const previous = autoAssignGeneratedLeads;
    setAutoAssignGeneratedLeads(enabled);
    setSavingAutoAssign(true);
    try {
      await setGeneratedLeadAutoAssignmentEnabled({ orgId: activeOrgId, enabled });
      toast.success(t("GeneratedLeadAutoAssignmentSaved" as any));
    } catch (error: any) {
      setAutoAssignGeneratedLeads(previous);
      toast.error(error);
    } finally {
      setSavingAutoAssign(false);
    }
  };

  const handleSaveSmartReply = async (overrides?: {
    igForDms?: boolean;
    igForComments?: boolean;
    fbForDms?: boolean;
    fbForComments?: boolean;
    financingMode?: "calculated" | "generic";
    visibility?: "public" | "dm";
  }) => {
    if (!activeOrgId) return;
    const financingMode = overrides?.financingMode ?? smartReplyFinancingMode;
    const downPaymentPercent = Number(smartReplyDownPaymentPercent);
    setSavingSmartReply(true);
    try {
      const igForDms = overrides?.igForDms ?? igSmartReplyForDms;
      const igForComments = overrides?.igForComments ?? igSmartReplyForComments;
      const fbForDms = overrides?.fbForDms ?? fbSmartReplyForDms;
      const fbForComments = overrides?.fbForComments ?? fbSmartReplyForComments;
      await setSmartReplyConfig({
        orgId: activeOrgId,
        instagramEnabled: igForDms || igForComments,
        facebookEnabled: fbForDms || fbForComments,
        instagramEnabledForDms: igForDms,
        instagramEnabledForComments: igForComments,
        facebookEnabledForDms: fbForDms,
        facebookEnabledForComments: fbForComments,
        financingMode,
        defaultDownPaymentPercent: Number.isFinite(downPaymentPercent) ? downPaymentPercent : undefined,
        defaultFinanceCompanyId: smartReplyFinanceCompanyId ? (smartReplyFinanceCompanyId as any) : undefined,
        visibility: overrides?.visibility ?? smartReplyVisibility,
      });
      toast.success(t("SmartReplySaved" as any));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setSavingSmartReply(false);
    }
  };

  const handleSaveTemplates = async () => {
    if (!activeOrgId) return;
    setSavingTemplates(true);
    try {
      const filtered = (map: TemplateMap) =>
        Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim().length > 0));
      const igForDms = igSmartReplyForDms;
      const igForComments = igSmartReplyForComments;
      const fbForDms = fbSmartReplyForDms;
      const fbForComments = fbSmartReplyForComments;
      await setSmartReplyConfig({
        orgId: activeOrgId,
        instagramEnabled: igForDms || igForComments,
        facebookEnabled: fbForDms || fbForComments,
        instagramEnabledForDms: igForDms,
        instagramEnabledForComments: igForComments,
        facebookEnabledForDms: fbForDms,
        facebookEnabledForComments: fbForComments,
        financingMode: smartReplyFinancingMode,
        defaultDownPaymentPercent: Number.isFinite(Number(smartReplyDownPaymentPercent))
          ? Number(smartReplyDownPaymentPercent)
          : undefined,
        defaultFinanceCompanyId: smartReplyFinanceCompanyId ? (smartReplyFinanceCompanyId as any) : undefined,
        visibility: smartReplyVisibility,
        customTemplatesEn: JSON.stringify(filtered(templatesEn)),
        customTemplatesAr: JSON.stringify(filtered(templatesAr)),
      });
      toast.success(t("SmartReplyTemplatesSaved" as any));
    } catch (error: any) {
      toast.error(error);
    } finally {
      setSavingTemplates(false);
    }
  };

  const anyConnected = Boolean(igStatus?.instagramConnected || fbStatus?.facebookConnected);

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            {t("Integrations" as any)}
          </CardTitle>
          <CardDescription>{t("IntegrationsDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <UserCheck className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t("GeneratedLeadAutoAssignment" as any)}</p>
                <p className="text-xs text-muted-foreground">{t("GeneratedLeadAutoAssignmentDescription" as any)}</p>
              </div>
            </div>
            <Switch
              checked={autoAssignGeneratedLeads}
              disabled={savingAutoAssign || !activeOrgId || autoAssignLoadedOrgId !== activeOrgId}
              onCheckedChange={handleToggleGeneratedLeadAutoAssignment}
            />
          </div>

          {/* Shared auto-post toggle */}
          {anyConnected && (
            <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{t("AutoPostInstagram" as any)}</p>
                <p className="text-xs text-muted-foreground">{t("AutoPostInstagramDescription" as any)}</p>
              </div>
              <Switch
                checked={igStatus?.socialAutoPostEnabled ?? false}
                onCheckedChange={handleToggleAutoPost}
              />
            </div>
          )}

          {/* ── Instagram ── */}
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 text-white">
                  <Camera className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold flex items-center gap-2">
                    {t("InstagramBusinessAccount" as any)}
                    {igStatus?.instagramConnected && (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-50">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Connected" as any)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {igStatus?.instagramConnected
                      ? `${t("InstagramConnectedAs" as any)} ${igStatus.instagramPageName ?? ""}`
                      : t("InstagramNotConnected" as any)}
                  </p>
                </div>
              </div>
              {igStatus?.instagramConnected ? (
                <Button variant="outline" onClick={handleDisconnectInstagram}>
                  {t("Disconnect" as any)}
                </Button>
              ) : (
                <Button onClick={handleConnectInstagram}>{t("ConnectInstagram" as any)}</Button>
              )}
            </div>

            {igStatus?.instagramConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igLeadFromComments}
                    onCheckedChange={(v) => handleToggleIgLeadCreation({ leadFromComments: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igLeadFromDms}
                    onCheckedChange={(v) => handleToggleIgLeadCreation({ leadFromDms: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 ps-4 border-s border-border/70">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDmsRequiresMobile" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsRequiresMobileDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igLeadFromDmsRequiresMobile}
                    disabled={!igLeadFromDms}
                    onCheckedChange={(v) => handleToggleIgLeadCreation({ leadFromDmsRequiresMobile: v })}
                  />
                </div>
              </div>
            )}

            {/* Instagram Auto-Reply (split into DMs + Comments) */}
            {igStatus?.instagramConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("AutoReplyForDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("AutoReplyForDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igAutoReplyForDms}
                    onCheckedChange={(v) => {
                      setIgAutoReplyForDms(v);
                      void handleSaveIgAutoReply({ enabledForDms: v });
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("AutoReplyForComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("AutoReplyForCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={igAutoReplyForComments}
                    onCheckedChange={(v) => {
                      setIgAutoReplyForComments(v);
                      void handleSaveIgAutoReply({ enabledForComments: v });
                    }}
                  />
                </div>

                <div className="space-y-2">
                  {igAutoReplyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Textarea
                        value={message}
                        placeholder={t("InstagramAutoReplyMessagePlaceholder" as any)}
                        onChange={(e) =>
                          setIgAutoReplyMessages(igAutoReplyMessages.map((m, i) => (i === index ? e.target.value : m)))
                        }
                        rows={2}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setIgAutoReplyMessages(igAutoReplyMessages.filter((_, i) => i !== index))}
                        aria-label={t("RemoveReply" as any)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 rounded-md border border-border/70 p-3">
                  <div>
                    <p className="text-sm font-medium">{t("MobileReceivedAutoReply" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("MobileReceivedAutoReplyDescription" as any)}</p>
                  </div>
                  <Textarea
                    value={igMobileReceivedReply}
                    placeholder={t("MobileReceivedAutoReplyPlaceholder" as any)}
                    onChange={(e) => setIgMobileReceivedReply(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIgAutoReplyMessages([...igAutoReplyMessages, ""])}
                    disabled={igAutoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("AddReply" as any)}
                  </Button>
                  <Button type="button" size="sm" onClick={() => handleSaveIgAutoReply()} disabled={igSavingAutoReply}>
                    {t("SaveAutoReplies" as any)}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Facebook ── */}
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white font-bold text-sm">
                  f
                </div>
                <div>
                  <p className="font-semibold flex items-center gap-2">
                    {t("FacebookPage" as any)}
                    {fbStatus?.facebookConnected && (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-50">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Connected" as any)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {fbStatus?.facebookConnected
                      ? `${t("FacebookConnectedAs" as any)} ${fbStatus.facebookPageName ?? ""}`
                      : t("FacebookNotConnected" as any)}
                  </p>
                </div>
              </div>
              {fbStatus?.facebookConnected ? (
                <Button variant="outline" onClick={handleDisconnectFacebook}>
                  {t("Disconnect" as any)}
                </Button>
              ) : (
                <Button onClick={handleConnectFacebook}>{t("ConnectFacebook" as any)}</Button>
              )}
            </div>

            {/* Page picker — shown after OAuth when the admin manages >1 Facebook Page */}
            {!fbStatus?.facebookConnected && (fbStatus?.facebookAvailablePages ?? []).length > 0 && (
              <div className="space-y-2 border border-border rounded-md p-4 bg-muted/30">
                <p className="text-sm font-medium">{t("SelectFacebookPage" as any)}</p>
                <p className="text-xs text-muted-foreground">{t("SelectFacebookPageDescription" as any)}</p>
                <div className="space-y-2 mt-2">
                  {(fbStatus?.facebookAvailablePages ?? []).map((page: { id: string; name: string }) => (
                    <Button
                      key={page.id}
                      variant="outline"
                      size="sm"
                      disabled={fbSelectingPage}
                      onClick={() => handleSelectFacebookPage(page.id)}
                      className="w-full justify-start"
                    >
                      {page.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {fbStatus?.facebookConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbLeadFromComments}
                    onCheckedChange={(v) => handleToggleFbLeadCreation({ leadFromComments: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbLeadFromDms}
                    onCheckedChange={(v) => handleToggleFbLeadCreation({ leadFromDms: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 ps-4 border-s border-border/70">
                  <div>
                    <p className="text-sm font-medium">{t("LeadFromDmsRequiresMobile" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("LeadFromDmsRequiresMobileDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbLeadFromDmsRequiresMobile}
                    disabled={!fbLeadFromDms}
                    onCheckedChange={(v) => handleToggleFbLeadCreation({ leadFromDmsRequiresMobile: v })}
                  />
                </div>
              </div>
            )}

            {/* Facebook Auto-Reply (split into DMs + Comments) */}
            {fbStatus?.facebookConnected && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("AutoReplyForDms" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("AutoReplyForDmsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbAutoReplyForDms}
                    onCheckedChange={(v) => {
                      setFbAutoReplyForDms(v);
                      void handleSaveFbAutoReply({ enabledForDms: v });
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t("AutoReplyForComments" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("AutoReplyForCommentsDescription" as any)}</p>
                  </div>
                  <Switch
                    checked={fbAutoReplyForComments}
                    onCheckedChange={(v) => {
                      setFbAutoReplyForComments(v);
                      void handleSaveFbAutoReply({ enabledForComments: v });
                    }}
                  />
                </div>

                <div className="space-y-2">
                  {fbAutoReplyMessages.map((message, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <Textarea
                        value={message}
                        placeholder={t("FacebookAutoReplyMessagePlaceholder" as any)}
                        onChange={(e) =>
                          setFbAutoReplyMessages(fbAutoReplyMessages.map((m, i) => (i === index ? e.target.value : m)))
                        }
                        rows={2}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setFbAutoReplyMessages(fbAutoReplyMessages.filter((_, i) => i !== index))}
                        aria-label={t("RemoveReply" as any)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 rounded-md border border-border/70 p-3">
                  <div>
                    <p className="text-sm font-medium">{t("MobileReceivedAutoReply" as any)}</p>
                    <p className="text-xs text-muted-foreground">{t("MobileReceivedAutoReplyDescription" as any)}</p>
                  </div>
                  <Textarea
                    value={fbMobileReceivedReply}
                    placeholder={t("MobileReceivedAutoReplyPlaceholder" as any)}
                    onChange={(e) => setFbMobileReceivedReply(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setFbAutoReplyMessages([...fbAutoReplyMessages, ""])}
                    disabled={fbAutoReplyMessages.length >= MAX_AUTO_REPLY_MESSAGES}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("AddReply" as any)}
                  </Button>
                  <Button type="button" size="sm" onClick={() => handleSaveFbAutoReply()} disabled={fbSavingAutoReply}>
                    {t("SaveAutoReplies" as any)}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Smart Reply (Instant Auto-Reply) ── */}
          {anyConnected && (
            <div className="rounded-xl border border-border p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold">{t("SmartReplyTitle" as any)}</p>
                  <p className="text-sm text-muted-foreground">{t("SmartReplyDescription" as any)}</p>
                </div>
              </div>

              {/* Per-platform, per-kind toggles */}
              <div className="space-y-3 border-t border-border pt-4">
                {igStatus?.instagramConnected && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Instagram</p>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium">{t("SmartReplyEnableForDms" as any)}</p>
                      <Switch
                        checked={igSmartReplyForDms}
                        onCheckedChange={(v) => {
                          setIgSmartReplyForDms(v);
                          void handleSaveSmartReply({ igForDms: v });
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium">{t("SmartReplyEnableForComments" as any)}</p>
                      <Switch
                        checked={igSmartReplyForComments}
                        onCheckedChange={(v) => {
                          setIgSmartReplyForComments(v);
                          void handleSaveSmartReply({ igForComments: v });
                        }}
                      />
                    </div>
                  </div>
                )}
                {fbStatus?.facebookConnected && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Facebook</p>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium">{t("SmartReplyEnableForDms" as any)}</p>
                      <Switch
                        checked={fbSmartReplyForDms}
                        onCheckedChange={(v) => {
                          setFbSmartReplyForDms(v);
                          void handleSaveSmartReply({ fbForDms: v });
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium">{t("SmartReplyEnableForComments" as any)}</p>
                      <Switch
                        checked={fbSmartReplyForComments}
                        onCheckedChange={(v) => {
                          setFbSmartReplyForComments(v);
                          void handleSaveSmartReply({ fbForComments: v });
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Shared config */}
              <div className="space-y-3 border-t border-border pt-4">
                <div>
                  <p className="text-sm font-medium mb-1">{t("SmartReplyFinancingModeLabel" as any)}</p>
                  <Select
                    value={smartReplyFinancingMode}
                    onValueChange={(v) => {
                      const mode = v as "calculated" | "generic";
                      setSmartReplyFinancingMode(mode);
                      void handleSaveSmartReply({ financingMode: mode });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="generic">{t("SmartReplyFinancingModeGeneric" as any)}</SelectItem>
                      <SelectItem value="calculated">{t("SmartReplyFinancingModeCalculated" as any)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {smartReplyFinancingMode === "calculated" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <p className="text-sm font-medium mb-1">{t("SmartReplyDownPaymentLabel" as any)}</p>
                      <Input
                        type="number"
                        min={0}
                        max={99}
                        value={smartReplyDownPaymentPercent}
                        onChange={(e) => setSmartReplyDownPaymentPercent(e.target.value)}
                        onBlur={() => void handleSaveSmartReply()}
                      />
                    </div>
                    <div>
                      <p className="text-sm font-medium mb-1">{t("SmartReplyFinanceCompanyLabel" as any)}</p>
                      <Select
                        value={smartReplyFinanceCompanyId}
                        onValueChange={(v) => {
                          setSmartReplyFinanceCompanyId(v);
                          void handleSaveSmartReply();
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(financeCompanies ?? [])
                            .filter((c) => c.isActive)
                            .map((c) => (
                              <SelectItem key={c._id} value={c._id}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium mb-1">{t("SmartReplyVisibilityLabel" as any)}</p>
                  <Select
                    value={smartReplyVisibility}
                    onValueChange={(v) => {
                      const visibility = v as "public" | "dm";
                      setSmartReplyVisibility(visibility);
                      void handleSaveSmartReply({ visibility });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">{t("SmartReplyVisibilityPublic" as any)}</SelectItem>
                      <SelectItem value="dm">{t("SmartReplyVisibilityDm" as any)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {savingSmartReply && <p className="text-xs text-muted-foreground">{t("Saving" as any)}</p>}
              </div>

              {/* ── Editable response templates ── */}
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left"
                  onClick={() => setShowTemplates((v) => !v)}
                >
                  <div>
                    <p className="text-sm font-medium">{t("SmartReplyTemplatesTitle" as any)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t("SmartReplyTemplatesDesc" as any)}</p>
                  </div>
                  {showTemplates ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                </button>

                {showTemplates && (
                  <div className="mt-4 space-y-4">
                    {/* Language tabs */}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={templateTab === "en" ? "default" : "outline"}
                        onClick={() => setTemplateTab("en")}
                      >
                        {t("SmartReplyTemplatesEnTab" as any)}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={templateTab === "ar" ? "default" : "outline"}
                        onClick={() => setTemplateTab("ar")}
                      >
                        {t("SmartReplyTemplatesArTab" as any)}
                      </Button>
                    </div>

                    {/* Template fields */}
                    <div className="space-y-3">
                      {TEMPLATE_KEYS.map(({ key, label, placeholder }) => {
                        const map = templateTab === "en" ? templatesEn : templatesAr;
                        const defaults = templateTab === "en" ? socialSmartReplyEn : socialSmartReplyAr;
                        const setMap = templateTab === "en" ? setTemplatesEn : setTemplatesAr;
                        return (
                          <div key={key}>
                            <p className="text-xs font-medium mb-1">{t(label as any)}</p>
                            <Textarea
                              value={map[key] ?? ""}
                              placeholder={defaults[placeholder]}
                              onChange={(e) => setMap((prev) => ({ ...prev, [key]: e.target.value }))}
                              rows={2}
                              className="text-sm font-mono"
                            />
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex justify-end">
                      <Button type="button" size="sm" onClick={handleSaveTemplates} disabled={savingTemplates}>
                        {t("SmartReplyTemplatesSaved" as any)}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
