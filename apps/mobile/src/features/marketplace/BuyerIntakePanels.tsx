import type { MobileFoundationStringKey } from "@autoflow/shared";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import {
  api,
  type MobileBuyerTimeframe,
  type MobileMarketplaceDealer,
  type MobilePaymentType,
  type MobileTradeInCondition,
} from "../../convexApi";
import { FormField } from "../../components/FormField";
import { GuidedStepFlow, type GuidedStep } from "../../components/GuidedStepFlow";
import { RouteLoadingState } from "../../components/RouteState";
import { SearchableSelectField } from "../../components/SearchableSelectField";
import { getMobileEnv } from "../../config/env";
import { useLocale } from "../../providers/LocaleProvider";
import { type AppTheme } from "../../theme";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { getMarketplaceClientFingerprint } from "./marketplaceFingerprint";
import { getMarketplaceSelectOptions } from "./marketplaceSelectOptions";
import {
  formatNumber,
  parseOptionalWholeNumber,
  trimOrUndefined,
} from "./marketplaceUtils";
import { TurnstileVerification } from "./TurnstileVerification";

export type TradeInDealerTarget = Pick<MobileMarketplaceDealer, "orgId" | "dealershipName">;

type ChoiceOption<TValue extends string> = {
  value: TValue;
  labelKey: MobileFoundationStringKey;
};

type RequestFields = {
  buyerFirstName: string;
  buyerPhone: string;
  buyerWhatsApp: string;
  buyerCity: string;
  make: string;
  model: string;
  yearMin: string;
  yearMax: string;
  priceMin: string;
  priceMax: string;
  paymentType: MobilePaymentType;
  monthlyBudget: string;
  buyerTimeframe: MobileBuyerTimeframe;
  consentAccepted: boolean;
};

type TradeInFields = {
  buyerFirstName: string;
  buyerPhone: string;
  currentMake: string;
  currentModel: string;
  currentYear: string;
  currentMileage: string;
  condition: MobileTradeInCondition;
  notes: string;
  consentAccepted: boolean;
};

const DEFAULT_REQUEST_FIELDS: RequestFields = {
  buyerFirstName: "",
  buyerPhone: "",
  buyerWhatsApp: "",
  buyerCity: "",
  make: "",
  model: "",
  yearMin: "",
  yearMax: "",
  priceMin: "",
  priceMax: "",
  paymentType: "EITHER",
  monthlyBudget: "",
  buyerTimeframe: "THIS_MONTH",
  consentAccepted: false,
};

const DEFAULT_TRADE_IN_FIELDS: TradeInFields = {
  buyerFirstName: "",
  buyerPhone: "",
  currentMake: "",
  currentModel: "",
  currentYear: "",
  currentMileage: "",
  condition: "GOOD",
  notes: "",
  consentAccepted: false,
};

const PAYMENT_OPTIONS: Array<ChoiceOption<MobilePaymentType>> = [
  { value: "EITHER", labelKey: "marketplacePaymentEither" },
  { value: "CASH", labelKey: "marketplacePaymentCash" },
  { value: "FINANCE", labelKey: "marketplacePaymentFinance" },
];

const TIMEFRAME_OPTIONS: Array<ChoiceOption<MobileBuyerTimeframe>> = [
  { value: "ASAP", labelKey: "marketplaceTimeframeAsap" },
  { value: "THIS_WEEK", labelKey: "marketplaceTimeframeThisWeek" },
  { value: "THIS_MONTH", labelKey: "marketplaceTimeframeThisMonth" },
  { value: "JUST_LOOKING", labelKey: "marketplaceTimeframeLooking" },
];

const CONDITION_OPTIONS: Array<ChoiceOption<MobileTradeInCondition>> = [
  { value: "EXCELLENT", labelKey: "marketplaceConditionExcellent" },
  { value: "GOOD", labelKey: "marketplaceConditionGood" },
  { value: "FAIR", labelKey: "marketplaceConditionFair" },
  { value: "POOR", labelKey: "marketplaceConditionPoor" },
];

function getTurnstileSiteKey(): string | undefined {
  try {
    return getMobileEnv().turnstileSiteKey;
  } catch {
    return undefined;
  }
}

function reportMarketplaceSubmitFailure(error: unknown, userMessage: string) {
  console.error(userMessage, error);
  Alert.alert("AutoFlow", userMessage);
}

function ChoiceGroup<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: Array<ChoiceOption<TValue>>;
  onChange: (value: TValue) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useLocale();

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.choiceWrap}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.choiceButton,
                selected && styles.choiceButtonSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(option.value)}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                {t(option.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ConsentRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      style={({ pressed }) => [styles.consentRow, pressed && styles.pressed]}
      onPress={() => onChange(!value)}
    >
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primarySoft }}
        thumbColor={value ? theme.colors.primary : theme.colors.surface}
      />
      <Text style={styles.consentText}>{label}</Text>
    </Pressable>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeTitle}>{title}</Text>
      {body ? <Text style={styles.noticeBody}>{body}</Text> : null}
    </View>
  );
}

function SubmitButton({
  label,
  submitting,
  onPress,
}: {
  label: string;
  submitting: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useLocale();

  return (
    <Pressable
      disabled={submitting}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.primaryButton,
        submitting && styles.disabledButton,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Text style={styles.primaryButtonText}>
        {submitting ? t("marketplaceSubmitting") : label}
      </Text>
    </Pressable>
  );
}

function StepActions({
  activeStep,
  nextLabel,
  onBack,
  onNext,
  onSubmit,
  previousLabel,
  submitLabel,
  submitting,
  totalSteps,
}: {
  activeStep: number;
  nextLabel: string;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  previousLabel: string;
  submitLabel: string;
  submitting: boolean;
  totalSteps: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const isLast = activeStep >= totalSteps - 1;

  return (
    <View style={styles.stepActions}>
      {activeStep > 0 ? (
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={onBack}
        >
          <Text style={styles.secondaryButtonText}>{previousLabel}</Text>
        </Pressable>
      ) : null}
      <View style={styles.stepPrimaryAction}>
        {isLast ? (
          <SubmitButton label={submitLabel} submitting={submitting} onPress={onSubmit} />
        ) : (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={onNext}
          >
            <Text style={styles.primaryButtonText}>{nextLabel}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function BuyerRequestPanel() {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const submitRequest = useAction(api.marketplaceRequests.submitRequest);
  const [fields, setFields] = useState<RequestFields>(DEFAULT_REQUEST_FIELDS);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [verificationResetKey, setVerificationResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedRequest, setSubmittedRequest] = useState<{ requestId: string; matchedCount: number } | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const turnstileSiteKey = getTurnstileSiteKey();
  const selectOptions = getMarketplaceSelectOptions(locale);
  const requestSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "بيانات المشتري" : "Buyer details",
      subtitle: locale === "ar" ? "ابدأ بوسيلة التواصل والمدينة." : "Start with contact and city.",
    },
    {
      title: locale === "ar" ? "السيارة المطلوبة" : "Desired vehicle",
      subtitle: locale === "ar" ? "اختر الماركة وأدخل المواصفات المهمة." : "Pick the make and key preferences.",
    },
    {
      title: locale === "ar" ? "الميزانية والتوقيت" : "Budget and timing",
      subtitle: locale === "ar" ? "حدد طريقة الدفع ومدى الجدية." : "Set payment, budget, and urgency.",
    },
    {
      title: locale === "ar" ? "المراجعة والإرسال" : "Review and submit",
      subtitle: locale === "ar" ? "أكد الموافقة ثم أرسل الطلب." : "Confirm consent, verify, and send.",
    },
  ];
  function setField<TKey extends keyof RequestFields>(key: TKey, value: RequestFields[TKey]) {
    setError(null);
    setFields((current) => ({ ...current, [key]: value }));
  }

  function getBuyerRequestStepError(step: number): string | null {
    if (
      step === 0 &&
      (!trimOrUndefined(fields.buyerFirstName) ||
        !trimOrUndefined(fields.buyerPhone) ||
        !trimOrUndefined(fields.buyerCity))
    ) {
      return t("marketplaceRequiredFields");
    }

    return null;
  }

  function moveBuyerRequestStep(nextStep: number) {
    setError(null);
    setActiveStep(Math.min(Math.max(nextStep, 0), requestSteps.length - 1));
  }

  function advanceBuyerRequestStep() {
    const stepError = getBuyerRequestStepError(activeStep);
    if (stepError) {
      setError(stepError);
      return;
    }

    moveBuyerRequestStep(activeStep + 1);
  }

  async function submitBuyerRequest() {
    setError(null);

    const buyerFirstName = trimOrUndefined(fields.buyerFirstName);
    const buyerPhone = trimOrUndefined(fields.buyerPhone);
    const buyerCity = trimOrUndefined(fields.buyerCity);
    if (!buyerFirstName || !buyerPhone || !buyerCity) {
      setError(t("marketplaceRequiredFields"));
      return;
    }

    if (!fields.consentAccepted) {
      setError(t("marketplaceConsentRequired"));
      return;
    }

    if (!turnstileToken) {
      setError(t("marketplaceVerificationRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const clientFingerprint = await getMarketplaceClientFingerprint(locale);
      const submitResponse = await submitRequest({
        buyerFirstName,
        buyerPhone,
        buyerWhatsApp: trimOrUndefined(fields.buyerWhatsApp),
        buyerCity,
        make: trimOrUndefined(fields.make),
        model: trimOrUndefined(fields.model),
        yearMin: parseOptionalWholeNumber(fields.yearMin),
        yearMax: parseOptionalWholeNumber(fields.yearMax),
        priceMin: parseOptionalWholeNumber(fields.priceMin),
        priceMax: parseOptionalWholeNumber(fields.priceMax),
        paymentType: fields.paymentType,
        monthlyBudget:
          fields.paymentType === "CASH"
            ? undefined
            : parseOptionalWholeNumber(fields.monthlyBudget),
        buyerTimeframe: fields.buyerTimeframe,
        consentAccepted: true,
        clientFingerprint,
        turnstileToken,
      });

      setSubmittedRequest(submitResponse);
      setFields(DEFAULT_REQUEST_FIELDS);
      setActiveStep(0);
      setTurnstileToken(null);
      setVerificationResetKey((value) => value + 1);
    } catch (error) {
      const message = t("marketplaceSubmitFailed");
      setError(message);
      reportMarketplaceSubmitFailure(error, message);
      setTurnstileToken(null);
      setVerificationResetKey((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.panel, { direction: textDirection }]}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("marketplaceBuyerRequestTitle")}</Text>
        <Text style={styles.panelSubtitle}>{t("marketplaceBuyerRequestSubtitle")}</Text>
      </View>

      {submittedRequest ? (
        <Notice
          title={t("marketplaceRequestSent")}
          body={
            submittedRequest.matchedCount > 0
              ? `${formatNumber(submittedRequest.matchedCount, locale)} ${t("marketplaceRequestSentMatched")}`
              : t("marketplaceRequestSentZero")
          }
        />
      ) : null}
      {submittedRequest ? (
        <View style={styles.idBox}>
          <Text style={styles.fieldLabel}>{t("marketplaceRequestIdLabel")}</Text>
          <Text selectable style={styles.idText}>
            {submittedRequest.requestId}
          </Text>
        </View>
      ) : null}

      <GuidedStepFlow activeIndex={activeStep} steps={requestSteps}>
        {activeStep === 0 ? (
          <View style={styles.formGrid}>
            <FormField
              label={t("marketplaceBuyerFirstName")}
              value={fields.buyerFirstName}
              onChangeText={(value) => setField("buyerFirstName", value)}
            />
            <FormField
              label={t("marketplaceBuyerPhone")}
              value={fields.buyerPhone}
              keyboardType="phone-pad"
              onChangeText={(value) => setField("buyerPhone", value)}
            />
            <FormField
              label={t("marketplaceBuyerWhatsapp")}
              value={fields.buyerWhatsApp}
              keyboardType="phone-pad"
              onChangeText={(value) => setField("buyerWhatsApp", value)}
            />
            <SearchableSelectField
              allowCustomValue
              closeLabel={selectOptions.closeLabel}
              customValueLabel={selectOptions.customValueLabel}
              emptyLabel={selectOptions.emptyLabel}
              label={t("marketplaceCity")}
              options={selectOptions.cityOptions}
              placeholder={selectOptions.cityPlaceholder}
              searchPlaceholder={selectOptions.citySearchPlaceholder}
              value={fields.buyerCity}
              onChange={(value) => setField("buyerCity", value)}
            />
          </View>
        ) : null}
        {activeStep === 1 ? (
          <View style={styles.formGrid}>
            <SearchableSelectField
              allowCustomValue
              closeLabel={selectOptions.closeLabel}
              customValueLabel={selectOptions.customValueLabel}
              emptyLabel={selectOptions.emptyLabel}
              label={t("marketplaceMake")}
              options={selectOptions.makeOptions}
              placeholder={selectOptions.makePlaceholder}
              searchPlaceholder={selectOptions.makeSearchPlaceholder}
              value={fields.make}
              onChange={(value) => setField("make", value)}
            />
            <FormField
              label={t("marketplaceBuyerModel")}
              value={fields.model}
              onChangeText={(value) => setField("model", value)}
            />
            <FormField
              label={t("marketplaceBuyerYearMin")}
              value={fields.yearMin}
              keyboardType="number-pad"
              onChangeText={(value) => setField("yearMin", value)}
            />
            <FormField
              label={t("marketplaceBuyerYearMax")}
              value={fields.yearMax}
              keyboardType="number-pad"
              onChangeText={(value) => setField("yearMax", value)}
            />
          </View>
        ) : null}
        {activeStep === 2 ? (
          <>
            <View style={styles.formGrid}>
              <FormField
                label={t("marketplacePriceMin")}
                value={fields.priceMin}
                keyboardType="number-pad"
                onChangeText={(value) => setField("priceMin", value)}
              />
              <FormField
                label={t("marketplacePriceMax")}
                value={fields.priceMax}
                keyboardType="number-pad"
                onChangeText={(value) => setField("priceMax", value)}
              />
            </View>
            <ChoiceGroup
              label={t("marketplaceBuyerPayment")}
              value={fields.paymentType}
              options={PAYMENT_OPTIONS}
              onChange={(value) => setField("paymentType", value)}
            />
            {fields.paymentType !== "CASH" ? (
              <FormField
                label={t("marketplaceBuyerMonthlyBudget")}
                value={fields.monthlyBudget}
                keyboardType="number-pad"
                onChangeText={(value) => setField("monthlyBudget", value)}
              />
            ) : null}
            <ChoiceGroup
              label={t("marketplaceBuyerTimeframe")}
              value={fields.buyerTimeframe}
              options={TIMEFRAME_OPTIONS}
              onChange={(value) => setField("buyerTimeframe", value)}
            />
          </>
        ) : null}
        {activeStep === 3 ? (
          <>
            <ConsentRow
              label={t("marketplaceBuyerConsent")}
              value={fields.consentAccepted}
              onChange={(value) => setField("consentAccepted", value)}
            />
            <TurnstileVerification
              siteKey={turnstileSiteKey}
              resetKey={verificationResetKey}
              onTokenChange={setTurnstileToken}
            />
          </>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <StepActions
          activeStep={activeStep}
          nextLabel={locale === "ar" ? "التالي" : "Next"}
          previousLabel={locale === "ar" ? "السابق" : "Back"}
          submitLabel={t("marketplaceSubmitRequest")}
          submitting={submitting}
          totalSteps={requestSteps.length}
          onBack={() => moveBuyerRequestStep(activeStep - 1)}
          onNext={advanceBuyerRequestStep}
          onSubmit={submitBuyerRequest}
        />
      </GuidedStepFlow>
    </View>
  );
}

function DealerSelector({
  onSelectDealer,
}: {
  onSelectDealer: (dealer: TradeInDealerTarget) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const [search, setSearch] = useState("");
  const dealers = useQuery(api.marketplaceDealers.listPublicDirectory, {});

  if (dealers === undefined) {
    return <RouteLoadingState label={t("marketplaceLoadingDealers")} />;
  }

  if (dealers.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceNoTradeInDealers")}</Text>;
  }

  const query = search.trim().toLowerCase();
  const visibleDealers = query
    ? dealers.filter((dealer) =>
        `${dealer.dealershipName} ${dealer.address ?? ""}`.toLowerCase().includes(query),
      )
    : dealers;

  return (
    <View style={[styles.selectorList, { direction: textDirection }]}>
      <FormField
        label={locale === "ar" ? "بحث المعارض" : "Search dealers"}
        value={search}
        onChangeText={setSearch}
      />
      {visibleDealers.length === 0 ? (
        <Text style={styles.emptyText}>{locale === "ar" ? "لا توجد نتائج." : "No dealers match your search."}</Text>
      ) : null}
      {visibleDealers.map((dealer) => (
        <View key={dealer.orgId} style={styles.selectorCard}>
          <View style={styles.selectorText}>
            <Text style={styles.selectorTitle}>{dealer.dealershipName}</Text>
            {dealer.address ? <Text style={styles.selectorMeta}>{dealer.address}</Text> : null}
          </View>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
            onPress={() => onSelectDealer(dealer)}
          >
            <Text style={styles.smallButtonText}>{t("marketplaceChooseDealer")}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export function TradeInRequestPanel({
  selectedDealer,
  onSelectDealer,
  onClearDealer,
}: {
  selectedDealer: TradeInDealerTarget | null;
  onSelectDealer: (dealer: TradeInDealerTarget) => void;
  onClearDealer: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const submitTradeInRequest = useAction(api.marketplaceTradeIns.submitTradeInRequest);
  const [fields, setFields] = useState<TradeInFields>(DEFAULT_TRADE_IN_FIELDS);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [verificationResetKey, setVerificationResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedTradeIn, setSubmittedTradeIn] = useState<{ tradeInRequestId: string } | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const turnstileSiteKey = getTurnstileSiteKey();
  const selectOptions = getMarketplaceSelectOptions(locale);
  const tradeInSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "بيانات المالك" : "Owner details",
      subtitle: locale === "ar" ? "ابدأ بالاسم ورقم التواصل." : "Start with name and phone.",
    },
    {
      title: locale === "ar" ? "السيارة الحالية" : "Current vehicle",
      subtitle: locale === "ar" ? "اختر الماركة وأدخل معلومات السيارة." : "Pick the make and vehicle details.",
    },
    {
      title: locale === "ar" ? "الحالة والإرسال" : "Condition and submit",
      subtitle: locale === "ar" ? "حدد الحالة وأكد الموافقة." : "Set condition, consent, and verify.",
    },
  ];

  function setField<TKey extends keyof TradeInFields>(key: TKey, value: TradeInFields[TKey]) {
    setError(null);
    setFields((current) => ({ ...current, [key]: value }));
  }

  function getTradeInStepError(step: number): string | null {
    if (step === 0 && (!trimOrUndefined(fields.buyerFirstName) || !trimOrUndefined(fields.buyerPhone))) {
      return t("marketplaceRequiredFields");
    }

    if (
      step === 1 &&
      (!trimOrUndefined(fields.currentMake) ||
        !trimOrUndefined(fields.currentModel) ||
        !parseOptionalWholeNumber(fields.currentYear) ||
        parseOptionalWholeNumber(fields.currentMileage) === undefined)
    ) {
      return t("marketplaceRequiredFields");
    }

    return null;
  }

  function moveTradeInStep(nextStep: number) {
    setError(null);
    setActiveStep(Math.min(Math.max(nextStep, 0), tradeInSteps.length - 1));
  }

  function advanceTradeInStep() {
    const stepError = getTradeInStepError(activeStep);
    if (stepError) {
      setError(stepError);
      return;
    }

    moveTradeInStep(activeStep + 1);
  }

  async function submitTradeInOfferRequest() {
    setError(null);
    if (!selectedDealer) {
      setError(t("marketplaceNoTradeInDealers"));
      return;
    }

    const buyerFirstName = trimOrUndefined(fields.buyerFirstName);
    const buyerPhone = trimOrUndefined(fields.buyerPhone);
    const currentMake = trimOrUndefined(fields.currentMake);
    const currentModel = trimOrUndefined(fields.currentModel);
    const currentYear = parseOptionalWholeNumber(fields.currentYear);
    const currentMileage = parseOptionalWholeNumber(fields.currentMileage);
    if (!buyerFirstName || !buyerPhone || !currentMake || !currentModel || !currentYear || currentMileage === undefined) {
      setError(t("marketplaceRequiredFields"));
      return;
    }

    if (!fields.consentAccepted) {
      setError(t("marketplaceConsentRequired"));
      return;
    }

    if (!turnstileToken) {
      setError(t("marketplaceVerificationRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const clientFingerprint = await getMarketplaceClientFingerprint(locale);
      const submitResponse = await submitTradeInRequest({
        orgId: selectedDealer.orgId,
        buyerFirstName,
        buyerPhone,
        currentMake,
        currentModel,
        currentYear,
        currentMileage,
        condition: fields.condition,
        notes: trimOrUndefined(fields.notes),
        consentAccepted: true,
        clientFingerprint,
        turnstileToken,
      });

      setSubmittedTradeIn(submitResponse);
      setFields(DEFAULT_TRADE_IN_FIELDS);
      setActiveStep(0);
      setTurnstileToken(null);
      setVerificationResetKey((value) => value + 1);
    } catch (error) {
      const message = t("marketplaceSubmitFailed");
      setError(message);
      reportMarketplaceSubmitFailure(error, message);
      setTurnstileToken(null);
      setVerificationResetKey((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.panel, { direction: textDirection }]}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("marketplaceTradeInTitle")}</Text>
        <Text style={styles.panelSubtitle}>{t("marketplaceTradeInSubtitle")}</Text>
      </View>

      {selectedDealer ? (
        <View style={styles.selectedDealerCard}>
          <View style={styles.selectorText}>
            <Text style={styles.fieldLabel}>{t("marketplaceSelectedDealer")}</Text>
            <Text style={styles.selectorTitle}>{selectedDealer.dealershipName}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
            onPress={() => {
              setActiveStep(0);
              onClearDealer();
            }}
          >
            <Text style={styles.smallButtonText}>{t("marketplaceChangeDealer")}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.sectionTitle}>{t("marketplaceSelectDealerTitle")}</Text>
          <DealerSelector onSelectDealer={onSelectDealer} />
        </>
      )}

      {selectedDealer ? (
        <>
          {submittedTradeIn ? (
            <Notice title={t("marketplaceTradeInSent")} body={t("marketplaceTradeInSentDetail")} />
          ) : null}
          {submittedTradeIn ? (
            <View style={styles.idBox}>
              <Text style={styles.fieldLabel}>{t("marketplaceTradeInIdLabel")}</Text>
              <Text selectable style={styles.idText}>
                {submittedTradeIn.tradeInRequestId}
              </Text>
            </View>
          ) : null}

          <GuidedStepFlow activeIndex={activeStep} steps={tradeInSteps}>
            {activeStep === 0 ? (
              <View style={styles.formGrid}>
                <FormField
                  label={t("marketplaceBuyerFirstName")}
                  value={fields.buyerFirstName}
                  onChangeText={(value) => setField("buyerFirstName", value)}
                />
                <FormField
                  label={t("marketplaceBuyerPhone")}
                  value={fields.buyerPhone}
                  keyboardType="phone-pad"
                  onChangeText={(value) => setField("buyerPhone", value)}
                />
              </View>
            ) : null}
            {activeStep === 1 ? (
              <View style={styles.formGrid}>
                <SearchableSelectField
                  allowCustomValue
                  closeLabel={selectOptions.closeLabel}
                  customValueLabel={selectOptions.customValueLabel}
                  emptyLabel={selectOptions.emptyLabel}
                  label={t("marketplaceCurrentMake")}
                  options={selectOptions.makeOptions}
                  placeholder={selectOptions.makePlaceholder}
                  searchPlaceholder={selectOptions.makeSearchPlaceholder}
                  value={fields.currentMake}
                  onChange={(value) => setField("currentMake", value)}
                />
                <FormField
                  label={t("marketplaceCurrentModel")}
                  value={fields.currentModel}
                  onChangeText={(value) => setField("currentModel", value)}
                />
                <FormField
                  label={t("marketplaceCurrentYear")}
                  value={fields.currentYear}
                  keyboardType="number-pad"
                  onChangeText={(value) => setField("currentYear", value)}
                />
                <FormField
                  label={t("marketplaceCurrentMileage")}
                  value={fields.currentMileage}
                  keyboardType="number-pad"
                  onChangeText={(value) => setField("currentMileage", value)}
                />
              </View>
            ) : null}
            {activeStep === 2 ? (
              <>
                <ChoiceGroup
                  label={t("marketplaceCondition")}
                  value={fields.condition}
                  options={CONDITION_OPTIONS}
                  onChange={(value) => setField("condition", value)}
                />
                <FormField
                  label={t("marketplaceTradeInNotes")}
                  value={fields.notes}
                  multiline
                  onChangeText={(value) => setField("notes", value)}
                />
                <ConsentRow
                  label={t("marketplaceTradeInConsent")}
                  value={fields.consentAccepted}
                  onChange={(value) => setField("consentAccepted", value)}
                />
                <TurnstileVerification
                  siteKey={turnstileSiteKey}
                  resetKey={verificationResetKey}
                  onTokenChange={setTurnstileToken}
                />
              </>
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <StepActions
              activeStep={activeStep}
              nextLabel={locale === "ar" ? "التالي" : "Next"}
              previousLabel={locale === "ar" ? "السابق" : "Back"}
              submitLabel={t("marketplaceSubmitTradeIn")}
              submitting={submitting}
              totalSteps={tradeInSteps.length}
              onBack={() => moveTradeInStep(activeStep - 1)}
              onNext={advanceTradeInStep}
              onSubmit={submitTradeInOfferRequest}
            />
          </GuidedStepFlow>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  panelHeader: {
    gap: theme.spacing.xs,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
  },
  panelSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  formGrid: {
    gap: theme.spacing.md,
  },
  field: {
    gap: theme.spacing.xs,
  },
  fieldLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  choiceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  choiceButton: {
    minHeight: 38,
    minWidth: 92,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  choiceButtonSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  choiceText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  choiceTextSelected: {
    color: theme.colors.text,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  consentText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  notice: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.successSoft,
    padding: theme.spacing.md,
  },
  noticeTitle: {
    color: theme.colors.success,
    fontSize: 15,
    fontWeight: "700",
  },
  noticeBody: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  idBox: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  idText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  primaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  secondaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  stepActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  stepPrimaryAction: {
    flex: 1,
  },
  disabledButton: {
    opacity: 0.48,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
    lineHeight: 19,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  selectorList: {
    gap: theme.spacing.sm,
  },
  selectorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  selectedDealerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  selectorText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  selectorTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  selectorMeta: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  smallButton: {
    minHeight: 38,
    minWidth: 74,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
  },
  smallButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 12,
    fontWeight: "700",
  },
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingVertical: theme.spacing.lg,
  },
  pressed: {
    opacity: 0.82,
  },
});
