import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileWebsiteLanguage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { type SelectableOption, type WebsiteColorPreset, WEBSITE_TEMPLATE_OPTIONS, WEBSITE_COLOR_PRESETS, HERO_TITLE_PRESETS, HERO_SUBTITLE_PRESETS, compactNumber, maybeText, useGenericError, PrimaryButton, FormField, SelectField, RecordCard, MetricCard, getOptionLabel, websiteTemplateLabel, websiteTemplateOptions, heroPresetOptions, websiteAddressPreview, websiteEnabledCount, DetailPill, SummaryRow, SummaryPanel, WizardActions, ModuleScroll, LockedFeature } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function WebsiteModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const canUseWebsite = subscription?.planDetails.gates.websiteBuilder === true;
  const status = useQuery(api.websites.getStatus, canUseWebsite ? { orgId } : "skip");
  const companies = useQuery(api.finance.listCompanies, canUseWebsite ? { orgId } : "skip");
  const startSetup = useMutation(api.websites.startSetup);
  const saveDraft = useMutation(api.websites.saveDraft);
  const publishWebsite = useMutation(api.websites.publish);
  const unpublishWebsite = useMutation(api.websites.unpublish);
  const [saving, setSaving] = useState(false);
  const [websiteStep, setWebsiteStep] = useState(0);
  const [form, setForm] = useState({
    subdomainSlug: "",
    templateId: "modern-showroom",
    defaultLanguage: "en" as MobileWebsiteLanguage,
    supportArabic: "true",
    primaryColor: "#0f172a",
    secondaryColor: "#f97316",
    heroTitle: "",
    heroSubtitle: "",
    heroBadgeText: "",
    slogan: "",
    activeFinanceCompanyId: "none",
  });
  const [sections, setSections] = useState<Array<{ sectionKey: string; enabled: boolean }>>([]);
  const [routing, setRouting] = useState<Array<{ formType: string; createTask: boolean; notifyByEmail: boolean; notifyByWhatsApp: boolean }>>([]);
  const templateOptions = websiteTemplateOptions(locale);
  const financeCompanyOptions: SelectableOption[] = [
    { label: locale === "ar" ? "بدون شركة تمويل" : "No finance company", value: "none" },
    ...(companies ?? [])
      .filter((company) => company.isActive)
      .map((company) => ({
        label: company.name,
        subLabel: `${company.profitRate}% · ${company.maxTermMonths}m`,
        value: company._id,
      })),
  ];
  const enabledSectionCount = websiteEnabledCount(sections);
  const websiteSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العنوان واللغة" : "Address and language",
      subtitle: locale === "ar" ? "حدد رابط الموقع واللغة العامة." : "Choose the public address and language behavior.",
    },
    {
      title: locale === "ar" ? "القالب والهوية" : "Template and brand",
      subtitle: locale === "ar" ? "اختر قالبا، لوحة ألوان، ونص البطل." : "Pick a template, palette, and hero copy.",
    },
    {
      title: locale === "ar" ? "البيانات العامة" : "Public data",
      subtitle: locale === "ar" ? "اختر ما يظهر من بيانات المعرض والمخزون." : "Control what dealership and inventory data appears.",
    },
    {
      title: locale === "ar" ? "توجيه العملاء" : "Lead routing",
      subtitle: locale === "ar" ? "حول نماذج الموقع إلى مهام وتنبيهات." : "Route public forms into tasks and notifications.",
    },
    {
      title: locale === "ar" ? "مراجعة ونشر" : "Review and publish",
      subtitle: locale === "ar" ? "راجع الإعدادات قبل النشر." : "Check the setup before publishing.",
    },
  ];

  useEffect(() => {
    if (!status) return;
    const settings = status.settings;
    if (settings) {
      setForm({
        subdomainSlug: (settings.defaultSubdomain ?? "").replace(".autoflowdealer.com", ""),
        templateId: settings.templateId ?? "modern-showroom",
        defaultLanguage: settings.defaultLanguage ?? "en",
        supportArabic: (settings.supportedLanguages ?? []).includes("ar") ? "true" : "false",
        primaryColor: settings.primaryColor ?? "#0f172a",
        secondaryColor: settings.secondaryColor ?? "#f97316",
        heroTitle: settings.heroTitle ?? "",
        heroSubtitle: settings.heroSubtitle ?? "",
        heroBadgeText: settings.heroBadgeText ?? "",
        slogan: settings.slogan ?? "",
        activeFinanceCompanyId: settings.activeFinanceCompanyId ?? "none",
      });
    }
    setSections(status.sections.map((section) => ({ sectionKey: section.sectionKey, enabled: section.enabled })));
    setRouting(status.routing.map((route) => ({
      formType: route.formType,
      createTask: route.createTask,
      notifyByEmail: route.notifyByEmail,
      notifyByWhatsApp: route.notifyByWhatsApp,
    })));
  }, [status]);

  function applyWebsitePalette(palette: WebsiteColorPreset) {
    setForm((prev) => ({
      ...prev,
      primaryColor: palette.primaryColor,
      secondaryColor: palette.secondaryColor,
    }));
  }

  async function ensureSetup() {
    setSaving(true);
    try {
      await startSetup({ orgId });
      setWebsiteStep(0);
    } catch (error) {
      reportError("Mobile website setup failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await saveDraft({
        orgId,
        subdomainSlug: maybeText(form.subdomainSlug),
        templateId: maybeText(form.templateId),
        defaultLanguage: form.defaultLanguage,
        supportedLanguages: form.supportArabic === "true" ? ["en", "ar"] : [form.defaultLanguage],
        primaryColor: maybeText(form.primaryColor),
        secondaryColor: maybeText(form.secondaryColor),
        heroTitle: maybeText(form.heroTitle),
        heroSubtitle: maybeText(form.heroSubtitle),
        heroBadgeText: maybeText(form.heroBadgeText),
        slogan: maybeText(form.slogan),
        activeFinanceCompanyId: form.activeFinanceCompanyId === "none" ? null : form.activeFinanceCompanyId,
        sections,
        routing,
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile website save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function publish(active: boolean) {
    setSaving(true);
    try {
      if (active) {
        await publishWebsite({ orgId });
      } else {
        await unpublishWebsite({ orgId });
      }
    } catch (error) {
      reportError("Mobile website publish failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (subscription === undefined || (canUseWebsite && (status === undefined || companies === undefined))) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  if (!canUseWebsite) {
    return <LockedFeature feature={locale === "ar" ? "منشئ المواقع" : "Website builder"} />;
  }

  if (status === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  const websiteStatus = status;
  const websiteSettings = websiteStatus.settings;

  if (!websiteSettings) {
    return (
      <ModuleScroll>
        <SummaryPanel
          title={locale === "ar" ? "موقع المعرض جاهز للبناء" : "Your dealer website is ready to build"}
          subtitle={locale === "ar" ? "ابدأ إعدادا موجها بدل تعبئة كل شيء يدويا." : "Start a guided setup instead of manually entering every field."}
        >
          <SummaryRow label={locale === "ar" ? "القوالب" : "Templates"} value={`${WEBSITE_TEMPLATE_OPTIONS.length}`} />
          <SummaryRow label={locale === "ar" ? "النماذج" : "Forms"} value="6" />
          <SummaryRow label={locale === "ar" ? "اللغات" : "Languages"} value="EN / AR" />
        </SummaryPanel>
        <PrimaryButton disabled={saving} label={locale === "ar" ? "بدء الإعداد" : "Start setup"} onPress={ensureSetup} />
      </ModuleScroll>
    );
  }

  const selectedAddress = websiteAddressPreview(form.subdomainSlug, websiteStatus.primaryDomain?.domain ?? websiteSettings.defaultSubdomain);
  const activeFinanceLabel = getOptionLabel(financeCompanyOptions, form.activeFinanceCompanyId, locale === "ar" ? "بدون شركة تمويل" : "No finance company");
  const selectedTemplateLabel = websiteTemplateLabel(form.templateId, locale);
  const canPublish = selectedAddress !== "-";

  return (
    <ModuleScroll>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>{websiteStatus.primaryDomain?.domain ?? websiteSettings.defaultSubdomain ?? "-"}</Text>
          <Text style={styles.statusPill}>{websiteSettings.status}</Text>
        </View>
        <Text style={styles.recordMeta}>{locale === "ar" ? "النطاقات" : "Domains"}: {websiteStatus.domains.length}</Text>
      </RecordCard>
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "الأقسام" : "Sections"} value={`${enabledSectionCount}/${sections.length}`} caption={locale === "ar" ? "ظاهرة" : "visible"} />
        <MetricCard title={locale === "ar" ? "النماذج" : "Forms"} value={compactNumber(routing.length, locale)} caption={locale === "ar" ? "موجهة" : "routed"} />
        <MetricCard title={locale === "ar" ? "القالب" : "Template"} value={selectedTemplateLabel} caption={locale === "ar" ? "مختار" : "selected"} />
        <MetricCard title={locale === "ar" ? "اللغة" : "Language"} value={form.supportArabic === "true" ? "EN/AR" : form.defaultLanguage.toUpperCase()} caption={locale === "ar" ? "عام" : "public"} />
      </View>
      <GuidedStepFlow activeIndex={websiteStep} steps={websiteSteps}>
        {websiteStep === 0 ? (
          <>
            <FormField label={locale === "ar" ? "النطاق الفرعي" : "Subdomain slug"} value={form.subdomainSlug} placeholder="premiumcars" onChangeText={(subdomainSlug) => setForm((prev) => ({ ...prev, subdomainSlug }))} />
            <SelectField label={locale === "ar" ? "اللغة الأساسية" : "Default language"} value={form.defaultLanguage} options={[{ label: "English", value: "en" }, { label: "العربية", value: "ar" }]} onChange={(defaultLanguage) => setForm((prev) => ({ ...prev, defaultLanguage: defaultLanguage as MobileWebsiteLanguage }))} />
            <SelectField label={locale === "ar" ? "دعم العربية" : "Support Arabic"} value={form.supportArabic} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(supportArabic) => setForm((prev) => ({ ...prev, supportArabic }))} />
            <SummaryPanel title={locale === "ar" ? "معاينة الرابط" : "Address preview"}>
              <SummaryRow label={locale === "ar" ? "الموقع" : "Website"} value={selectedAddress} />
              <SummaryRow label={locale === "ar" ? "اللغات" : "Languages"} value={form.supportArabic === "true" ? "English + العربية" : form.defaultLanguage.toUpperCase()} />
            </SummaryPanel>
          </>
        ) : null}
        {websiteStep === 1 ? (
          <>
            <SelectField label={locale === "ar" ? "القالب" : "Template"} value={form.templateId} options={templateOptions} onChange={(templateId) => setForm((prev) => ({ ...prev, templateId }))} />
            <View style={styles.swatchRow}>
              {WEBSITE_COLOR_PRESETS.map((palette) => {
                const selected = form.primaryColor === palette.primaryColor && form.secondaryColor === palette.secondaryColor;
                return (
                  <Pressable
                    key={palette.labelEn}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[styles.swatchButton, selected && styles.swatchSelected]}
                    onPress={() => applyWebsitePalette(palette)}
                  >
                    <View style={styles.swatchStack}>
                      <View style={[styles.swatchFill, { backgroundColor: palette.primaryColor }]} />
                      <View style={[styles.swatchFill, { backgroundColor: palette.secondaryColor }]} />
                    </View>
                    <Text style={styles.swatchLabel}>{locale === "ar" ? palette.labelAr : palette.labelEn}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.inlineActionGroup}>
              <View style={styles.inlineActionField}>
                <FormField label={locale === "ar" ? "اللون الأساسي" : "Primary color"} value={form.primaryColor} onChangeText={(primaryColor) => setForm((prev) => ({ ...prev, primaryColor }))} />
              </View>
              <View style={styles.inlineActionField}>
                <FormField label={locale === "ar" ? "اللون الثانوي" : "Secondary color"} value={form.secondaryColor} onChangeText={(secondaryColor) => setForm((prev) => ({ ...prev, secondaryColor }))} />
              </View>
            </View>
            <SelectField label={locale === "ar" ? "عنوان جاهز" : "Hero title preset"} value={form.heroTitle} options={heroPresetOptions(HERO_TITLE_PRESETS[form.defaultLanguage])} onChange={(heroTitle) => setForm((prev) => ({ ...prev, heroTitle }))} />
            <FormField label={locale === "ar" ? "عنوان البطل" : "Hero title"} value={form.heroTitle} onChangeText={(heroTitle) => setForm((prev) => ({ ...prev, heroTitle }))} />
            <SelectField label={locale === "ar" ? "وصف جاهز" : "Hero subtitle preset"} value={form.heroSubtitle} options={heroPresetOptions(HERO_SUBTITLE_PRESETS[form.defaultLanguage])} onChange={(heroSubtitle) => setForm((prev) => ({ ...prev, heroSubtitle }))} />
            <FormField multiline label={locale === "ar" ? "وصف البطل" : "Hero subtitle"} value={form.heroSubtitle} onChangeText={(heroSubtitle) => setForm((prev) => ({ ...prev, heroSubtitle }))} />
            <FormField label={locale === "ar" ? "شارة البطل" : "Hero badge"} value={form.heroBadgeText} onChangeText={(heroBadgeText) => setForm((prev) => ({ ...prev, heroBadgeText }))} />
            <FormField label={locale === "ar" ? "الشعار النصي" : "Slogan"} value={form.slogan} onChangeText={(slogan) => setForm((prev) => ({ ...prev, slogan }))} />
            <SelectField label={locale === "ar" ? "شركة التمويل العامة" : "Public finance company"} value={form.activeFinanceCompanyId} options={financeCompanyOptions} onChange={(activeFinanceCompanyId) => setForm((prev) => ({ ...prev, activeFinanceCompanyId }))} />
            <View style={[styles.websitePreview, { backgroundColor: form.primaryColor }]}>
              <Text style={styles.websitePreviewBadge}>{form.heroBadgeText || (locale === "ar" ? "متوفر الآن" : "Now available")}</Text>
              <Text style={styles.websitePreviewTitle}>{form.heroTitle || selectedTemplateLabel}</Text>
              <Text style={styles.websitePreviewSubtitle}>{form.heroSubtitle || selectedAddress}</Text>
              <View style={[styles.websitePreviewAccent, { backgroundColor: form.secondaryColor }]} />
            </View>
          </>
        ) : null}
        {websiteStep === 2 ? (
          <>
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "مفعل" : "Enabled"} value={compactNumber(enabledSectionCount, locale)} caption={locale === "ar" ? "عام" : "public"} />
              <MetricCard title={locale === "ar" ? "مخفي" : "Hidden"} value={compactNumber(sections.length - enabledSectionCount, locale)} caption={locale === "ar" ? "خاص" : "private"} />
            </View>
            {sections.map((section) => (
              <RecordCard key={section.sectionKey}>
                <View style={styles.recordHeader}>
                  <Text style={styles.recordTitle}>{section.sectionKey}</Text>
                  <Text style={styles.statusPill}>{section.enabled ? "ON" : "OFF"}</Text>
                </View>
                <PrimaryButton
                  label={section.enabled ? (locale === "ar" ? "إخفاء" : "Hide") : (locale === "ar" ? "إظهار" : "Show")}
                  tone="muted"
                  onPress={() => setSections((prev) => prev.map((item) => item.sectionKey === section.sectionKey ? { ...item, enabled: !item.enabled } : item))}
                />
              </RecordCard>
            ))}
          </>
        ) : null}
        {websiteStep === 3 ? (
          <>
            {routing.map((route) => (
              <RecordCard key={route.formType}>
                <View style={styles.recordHeader}>
                  <Text style={styles.recordTitle}>{route.formType}</Text>
                  <Text style={styles.statusPill}>{route.createTask ? "TASK" : "LEAD"}</Text>
                </View>
                <View style={styles.detailPillRow}>
                  <DetailPill label={route.notifyByEmail ? "Email on" : "Email off"} tone={route.notifyByEmail ? "success" : "neutral"} />
                  <DetailPill label={route.notifyByWhatsApp ? "WhatsApp on" : "WhatsApp off"} tone={route.notifyByWhatsApp ? "success" : "neutral"} />
                </View>
                <View style={styles.cardActions}>
                  <PrimaryButton label={route.createTask ? (locale === "ar" ? "مهمة: نعم" : "Task: yes") : (locale === "ar" ? "مهمة: لا" : "Task: no")} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, createTask: !item.createTask } : item))} />
                  <PrimaryButton label={route.notifyByEmail ? "Email: yes" : "Email: no"} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, notifyByEmail: !item.notifyByEmail } : item))} />
                  <PrimaryButton label={route.notifyByWhatsApp ? "WhatsApp: yes" : "WhatsApp: no"} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, notifyByWhatsApp: !item.notifyByWhatsApp } : item))} />
                </View>
              </RecordCard>
            ))}
          </>
        ) : null}
        {websiteStep === 4 ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "مراجعة الموقع" : "Website review"}
              subtitle={locale === "ar" ? "هذه هي الإعدادات التي سيتم حفظها أو نشرها." : "These settings will be saved or published."}
            >
              <SummaryRow label={locale === "ar" ? "الرابط" : "Address"} value={selectedAddress} />
              <SummaryRow label={locale === "ar" ? "القالب" : "Template"} value={selectedTemplateLabel} />
              <SummaryRow label={locale === "ar" ? "الألوان" : "Colors"} value={`${form.primaryColor} / ${form.secondaryColor}`} />
              <SummaryRow label={locale === "ar" ? "الأقسام" : "Sections"} value={`${enabledSectionCount}/${sections.length}`} />
              <SummaryRow label={locale === "ar" ? "شركة التمويل" : "Finance company"} value={activeFinanceLabel} />
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ المسودة" : "Save draft")} onPress={save} />
              <PrimaryButton disabled={saving || !canPublish} label={websiteSettings.status === "active" ? (locale === "ar" ? "إلغاء النشر" : "Unpublish") : (locale === "ar" ? "نشر" : "Publish")} tone="muted" onPress={() => publish(websiteSettings.status !== "active")} />
            </View>
          </>
        ) : null}
        <WizardActions
          activeStep={websiteStep}
          backLabel={locale === "ar" ? "السابق" : "Back"}
          nextLabel={locale === "ar" ? "التالي" : "Next"}
          saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ المسودة" : "Save draft")}
          saving={saving}
          totalSteps={websiteSteps.length}
          onBack={() => setWebsiteStep((step) => Math.max(0, step - 1))}
          onNext={() => setWebsiteStep((step) => Math.min(websiteSteps.length - 1, step + 1))}
          onSave={save}
        />
      </GuidedStepFlow>
    </ModuleScroll>
  );
}

