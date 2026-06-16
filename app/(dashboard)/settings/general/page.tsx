"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Settings, Palette, CreditCard, Upload, ShieldCheck, MessageCircle } from "lucide-react";

const CURRENCIES = [
  { code: "JOD", symbol: "د.أ", label: "Jordanian Dinar (JOD)" },
  { code: "SAR", symbol: "ر.س", label: "Saudi Riyal (SAR)" },
  { code: "AED", symbol: "د.إ", label: "UAE Dirham (AED)" },
  { code: "KWD", symbol: "د.ك", label: "Kuwaiti Dinar (KWD)" },
  { code: "EGP", symbol: "ج.م", label: "Egyptian Pound (EGP)" },
  { code: "QAR", symbol: "ر.ق", label: "Qatari Riyal (QAR)" },
  { code: "BHD", symbol: "د.ب", label: "Bahraini Dinar (BHD)" },
  { code: "OMR", symbol: "ر.ع", label: "Omani Rial (OMR)" },
];

const TIMEZONES = [
  "Asia/Amman",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Africa/Cairo",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
];

export default function GeneralSettingsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const settings = useOrgSettings();
  const upsert = useMutation(api.orgSettings.upsert);
  const generateLogoUploadUrl = useMutation(api.orgSettings.generateLogoUploadUrl);

  // General tab state
  const [currency, setCurrency] = useState("JOD");
  const [country, setCountry] = useState("");
  const [vatRate, setVatRate] = useState("");
  const [timezone, setTimezone] = useState("");
  const [dealershipName, setDealershipName] = useState("");
  const [dealershipAddress, setDealershipAddress] = useState("");
  const [dealershipPhone, setDealershipPhone] = useState("");

  // Payment types tab state
  const [cashEnabled, setCashEnabled] = useState(true);
  const [installmentEnabled, setInstallmentEnabled] = useState(true);

  // Appearance tab state
  const [primaryColor, setPrimaryColor] = useState("#0f172a");

  // Approvals tab state
  const [approvalThresholdEnabled, setApprovalThresholdEnabled] = useState(false);
  const [approvalMinProfitPercent, setApprovalMinProfitPercent] = useState("");

  // WhatsApp tab state
  const [waPhoneNumberId, setWaPhoneNumberId] = useState("");
  const [waApiToken, setWaApiToken] = useState("");
  const [waWebhookSecret, setWaWebhookSecret] = useState("");

  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // Sync state from loaded settings
  useEffect(() => {
    if (settings) {
      setCurrency(settings.currency ?? "JOD");
      setCountry(settings.country ?? "");
      setVatRate(settings.vatRate !== undefined ? String(settings.vatRate) : "");
      setTimezone(settings.timezone ?? "");
      setDealershipName(settings.dealershipName ?? "");
      setDealershipAddress(settings.dealershipAddress ?? "");
      setDealershipPhone(settings.dealershipPhone ?? "");
      const pt = settings.enabledPaymentTypes ?? ["CASH", "INSTALLMENT"];
      setCashEnabled(pt.includes("CASH"));
      setInstallmentEnabled(pt.includes("INSTALLMENT"));
      setPrimaryColor(settings.primaryColor ?? "#0f172a");
      setApprovalThresholdEnabled(settings.approvalThresholdEnabled ?? false);
      setApprovalMinProfitPercent(
        settings.approvalMinProfitPercent !== undefined
          ? String(settings.approvalMinProfitPercent)
          : ""
      );
      setWaPhoneNumberId(settings.whatsappPhoneNumberId ?? "");
      setWaApiToken(settings.whatsappApiToken ?? "");
      setWaWebhookSecret(settings.whatsappWebhookSecret ?? "");
    }
  }, [settings]);

  const handleSaveGeneral = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      const selectedCurrency = CURRENCIES.find((c) => c.code === currency);
      await upsert({
        orgId: activeOrgId,
        currency,
        currencySymbol: selectedCurrency?.symbol ?? "د.أ",
        country: country || undefined,
        vatRate: vatRate ? parseFloat(vatRate) : undefined,
        timezone: timezone || undefined,
        dealershipName: dealershipName || undefined,
        dealershipAddress: dealershipAddress || undefined,
        dealershipPhone: dealershipPhone || undefined,
      });
      toast.success(t("GeneralSettingsSaved"));
    } catch (error: any) {
      toast.error(error.message || t("FailedToSaveSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePaymentTypes = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      const enabledPaymentTypes: string[] = [];
      if (cashEnabled) enabledPaymentTypes.push("CASH");
      if (installmentEnabled) enabledPaymentTypes.push("INSTALLMENT");
      await upsert({ orgId: activeOrgId, enabledPaymentTypes });
      toast.success(t("PaymentTypesSaved"));
    } catch (error: any) {
      toast.error(error.message || t("FailedToSaveSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveApprovals = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      await upsert({
        orgId: activeOrgId,
        approvalThresholdEnabled,
        approvalMinProfitPercent: approvalMinProfitPercent
          ? parseFloat(approvalMinProfitPercent)
          : undefined,
      });
      toast.success(t("ApprovalSettingsSaved"));
    } catch (error: any) {
      toast.error(error.message || t("FailedToSaveSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAppearance = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      await upsert({ orgId: activeOrgId, primaryColor });
      toast.success(t("AppearanceSaved"));
    } catch (error: any) {
      toast.error(error.message || t("FailedToSaveSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveWhatsApp = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      await upsert({
        orgId: activeOrgId,
        whatsappPhoneNumberId: waPhoneNumberId || undefined,
        whatsappApiToken: waApiToken || undefined,
        whatsappWebhookSecret: waWebhookSecret || undefined,
      });
      toast.success(t("WhatsAppSettingsSaved"));
    } catch (error: any) {
      toast.error(error.message || t("FailedToSaveSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeOrgId || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    setIsUploadingLogo(true);
    try {
      const uploadUrl = await generateLogoUploadUrl({ orgId: activeOrgId });
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!result.ok) throw new Error("Upload failed.");
      const { storageId } = await result.json();
      await upsert({ orgId: activeOrgId, logoStorageId: storageId });
      toast.success(t("LogoUploadedSuccess"));
    } catch (error: any) {
      toast.error(error.message || t("LogoUploadFailed"));
    } finally {
      setIsUploadingLogo(false);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("GeneralSettings")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("GeneralSettingsDesc")}</p>
      </div>

      <Tabs defaultValue="general" className="space-y-4">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            <TabsTrigger value="general" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              {t("GeneralTab")}
            </TabsTrigger>
            <TabsTrigger value="payment-types" className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              {t("PaymentTypes")}
            </TabsTrigger>
            <TabsTrigger value="appearance" className="flex items-center gap-2">
              <Palette className="h-4 w-4" />
              {t("AppearanceTab")}
            </TabsTrigger>
            <TabsTrigger value="approvals" className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              {t("ApprovalsTab")}
            </TabsTrigger>
            <TabsTrigger value="whatsapp" className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4" />
              {t("WhatsAppTab")}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── General Tab ─────────────────────────────────────────────── */}
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>{t("GeneralTab")}</CardTitle>
              <CardDescription>{t("GeneralTabDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>{t("Currency")}</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("SelectCurrencyPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t("Country")}</Label>
                  <Input
                    placeholder="e.g. Jordan"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t("VATRate")}</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    placeholder="e.g. 16"
                    value={vatRate}
                    onChange={(e) => setVatRate(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t("Timezone")}</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("SelectTimezonePlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="col-span-1 md:col-span-2 border-t pt-4">
                <p className="text-sm font-semibold mb-1">{t("DealershipInfo")}</p>
                <p className="text-xs text-muted-foreground mb-4">{t("DealershipInfoDesc")}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>{t("DealershipName")}</Label>
                    <Input
                      placeholder={t("DealershipNamePlaceholder")}
                      value={dealershipName}
                      onChange={(e) => setDealershipName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("DealershipPhone")}</Label>
                    <Input
                      placeholder={t("DealershipPhonePlaceholder")}
                      value={dealershipPhone}
                      onChange={(e) => setDealershipPhone(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>{t("DealershipAddress")}</Label>
                    <Input
                      placeholder={t("DealershipAddressPlaceholder")}
                      value={dealershipAddress}
                      onChange={(e) => setDealershipAddress(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveGeneral} disabled={isSaving}>
                  {isSaving ? t("Saving") : t("SaveGeneralSettings")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Payment Types Tab ────────────────────────────────────────── */}
        <TabsContent value="payment-types">
          <Card>
            <CardHeader>
              <CardTitle>{t("PaymentTypes")}</CardTitle>
              <CardDescription>{t("PaymentTypesDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div>
                    <p className="font-medium">{t("CashSales")}</p>
                    <p className="text-sm text-muted-foreground">{t("CashSalesDesc")}</p>
                  </div>
                  <Switch
                    checked={cashEnabled}
                    onCheckedChange={setCashEnabled}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div>
                    <p className="font-medium">{t("InstallmentFinanceSales")}</p>
                    <p className="text-sm text-muted-foreground">{t("InstallmentFinanceSalesDesc")}</p>
                  </div>
                  <Switch
                    checked={installmentEnabled}
                    onCheckedChange={setInstallmentEnabled}
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSavePaymentTypes} disabled={isSaving}>
                  {isSaving ? t("Saving") : t("SavePaymentTypes")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Appearance Tab ───────────────────────────────────────────── */}
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>{t("AppearanceTab")}</CardTitle>
              <CardDescription>{t("AppearanceDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>{t("PrimaryColor")}</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded border border-input p-1"
                  />
                  <Input
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    placeholder="#0f172a"
                    className="max-w-[160px] font-mono"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("OrganizationLogo")}</Label>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={isUploadingLogo}
                    onClick={() => document.getElementById("logo-upload")?.click()}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {isUploadingLogo ? t("UploadingLogo") : t("UploadLogo")}
                  </Button>
                  <input
                    id="logo-upload"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleLogoUpload}
                  />
                  <span className="text-sm text-muted-foreground">{t("LogoMaxSize")}</span>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveAppearance} disabled={isSaving}>
                  {isSaving ? t("Saving") : t("SaveAppearance")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        {/* ── Approvals Tab ────────────────────────────────────────────── */}
        <TabsContent value="approvals">
          <Card>
            <CardHeader>
              <CardTitle>{t("ApprovalsTab")}</CardTitle>
              <CardDescription>{t("ApprovalsTabDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <p className="font-medium">{t("EnableProfitApprovalWorkflow")}</p>
                  <p className="text-sm text-muted-foreground">{t("EnableProfitApprovalWorkflowDesc")}</p>
                </div>
                <Switch
                  checked={approvalThresholdEnabled}
                  onCheckedChange={setApprovalThresholdEnabled}
                />
              </div>

              {approvalThresholdEnabled && (
                <div className="space-y-2">
                  <Label>{t("MinimumProfitPercentage")}</Label>
                  <div className="flex items-center gap-3 max-w-xs">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      placeholder="e.g. 5"
                      value={approvalMinProfitPercent}
                      onChange={(e) => setApprovalMinProfitPercent(e.target.value)}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("MinimumProfitPercentageDesc")}</p>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={handleSaveApprovals} disabled={isSaving}>
                  {isSaving ? t("Saving") : t("SaveApprovalSettings")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── WhatsApp Tab ─────────────────────────────────────────────── */}
        <TabsContent value="whatsapp">
          <Card>
            <CardHeader>
              <CardTitle>{t("WhatsAppTab")}</CardTitle>
              <CardDescription>
                {t("WhatsAppTabDesc")}{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  {process.env.NEXT_PUBLIC_CONVEX_URL?.replace("convex.cloud", "convex.site")}/whatsapp-webhook?orgId=YOUR_ORG_ID
                </code>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>{t("PhoneNumberId")}</Label>
                  <Input
                    placeholder="e.g. 123456789012345"
                    value={waPhoneNumberId}
                    onChange={(e) => setWaPhoneNumberId(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("PhoneNumberIdDesc")}</p>
                </div>

                <div className="space-y-2">
                  <Label>{t("WebhookVerifyToken")}</Label>
                  <Input
                    type="password"
                    placeholder={t("WebhookVerifyTokenPlaceholder")}
                    value={waWebhookSecret}
                    onChange={(e) => setWaWebhookSecret(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("WebhookVerifyTokenDesc")}</p>
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>{t("PermanentAccessToken")}</Label>
                  <Input
                    type="password"
                    placeholder="EAAxxxxxxxx..."
                    value={waApiToken}
                    onChange={(e) => setWaApiToken(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("PermanentAccessTokenDesc")}</p>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveWhatsApp} disabled={isSaving}>
                  {isSaving ? t("Saving") : t("SaveWhatsAppSettings")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
