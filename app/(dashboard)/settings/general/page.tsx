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
import { Settings, Palette, CreditCard, Upload, ShieldCheck } from "lucide-react";

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

  // Payment types tab state
  const [cashEnabled, setCashEnabled] = useState(true);
  const [installmentEnabled, setInstallmentEnabled] = useState(true);

  // Appearance tab state
  const [primaryColor, setPrimaryColor] = useState("#0f172a");

  // Approvals tab state
  const [approvalThresholdEnabled, setApprovalThresholdEnabled] = useState(false);
  const [approvalMinProfitPercent, setApprovalMinProfitPercent] = useState("");

  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // Sync state from loaded settings
  useEffect(() => {
    if (settings) {
      setCurrency(settings.currency ?? "JOD");
      setCountry(settings.country ?? "");
      setVatRate(settings.vatRate !== undefined ? String(settings.vatRate) : "");
      setTimezone(settings.timezone ?? "");
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
      });
      toast.success("General settings saved.");
    } catch (error: any) {
      toast.error(error.message || "Failed to save settings.");
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
      toast.success("Payment types saved.");
    } catch (error: any) {
      toast.error(error.message || "Failed to save settings.");
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
      toast.success("Approval settings saved.");
    } catch (error: any) {
      toast.error(error.message || "Failed to save settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAppearance = async () => {
    if (!activeOrgId) return;
    setIsSaving(true);
    try {
      await upsert({ orgId: activeOrgId, primaryColor });
      toast.success("Appearance settings saved.");
    } catch (error: any) {
      toast.error(error.message || "Failed to save settings.");
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
      toast.success("Logo uploaded successfully.");
    } catch (error: any) {
      toast.error(error.message || "Logo upload failed.");
    } finally {
      setIsUploadingLogo(false);
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">General Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure your organization&apos;s currency, payment types, and appearance.
        </p>
      </div>

      <Tabs defaultValue="general" className="space-y-4">
        <TabsList>
          <TabsTrigger value="general" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            General
          </TabsTrigger>
          <TabsTrigger value="payment-types" className="flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Payment Types
          </TabsTrigger>
          <TabsTrigger value="appearance" className="flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Appearance
          </TabsTrigger>
          <TabsTrigger value="approvals" className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Approvals
          </TabsTrigger>
        </TabsList>

        {/* ── General Tab ─────────────────────────────────────────────── */}
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
              <CardDescription>
                Set the currency, country, VAT rate, and timezone for your dealership.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select currency" />
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
                  <Label>Country</Label>
                  <Input
                    placeholder="e.g. Jordan"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>VAT Rate (%)</Label>
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
                  <Label>Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select timezone" />
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

              <div className="flex justify-end">
                <Button onClick={handleSaveGeneral} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save General Settings"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Payment Types Tab ────────────────────────────────────────── */}
        <TabsContent value="payment-types">
          <Card>
            <CardHeader>
              <CardTitle>Payment Types</CardTitle>
              <CardDescription>
                Enable or disable the sale types available in the Sales wizard.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div>
                    <p className="font-medium">Cash Sales</p>
                    <p className="text-sm text-muted-foreground">
                      Allow full upfront cash payments.
                    </p>
                  </div>
                  <Switch
                    checked={cashEnabled}
                    onCheckedChange={setCashEnabled}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div>
                    <p className="font-medium">Installment / Finance Sales</p>
                    <p className="text-sm text-muted-foreground">
                      Allow sales financed through banks or finance companies.
                    </p>
                  </div>
                  <Switch
                    checked={installmentEnabled}
                    onCheckedChange={setInstallmentEnabled}
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSavePaymentTypes} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save Payment Types"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Appearance Tab ───────────────────────────────────────────── */}
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>
                Customize your dealership&apos;s logo and brand color.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Primary Color</Label>
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
                <Label>Organization Logo</Label>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={isUploadingLogo}
                    onClick={() => document.getElementById("logo-upload")?.click()}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {isUploadingLogo ? "Uploading..." : "Upload Logo"}
                  </Button>
                  <input
                    id="logo-upload"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleLogoUpload}
                  />
                  <span className="text-sm text-muted-foreground">
                    PNG, JPG, SVG up to 5 MB
                  </span>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveAppearance} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save Appearance"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        {/* ── Approvals Tab ────────────────────────────────────────────── */}
        <TabsContent value="approvals">
          <Card>
            <CardHeader>
              <CardTitle>Approval Thresholds</CardTitle>
              <CardDescription>
                Require manager approval when a sale falls below a minimum profit percentage.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <p className="font-medium">Enable Profit Approval Workflow</p>
                  <p className="text-sm text-muted-foreground">
                    Sales below the minimum profit percentage must be approved by a manager.
                  </p>
                </div>
                <Switch
                  checked={approvalThresholdEnabled}
                  onCheckedChange={setApprovalThresholdEnabled}
                />
              </div>

              {approvalThresholdEnabled && (
                <div className="space-y-2">
                  <Label>Minimum Profit Percentage (%)</Label>
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
                  <p className="text-xs text-muted-foreground">
                    Sales with profit below this percentage of the vehicle cost will require approval.
                  </p>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={handleSaveApprovals} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save Approval Settings"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
