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
import { RouteLoadingState } from "../../components/RouteState";
import { getMobileEnv } from "../../config/env";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import { getMarketplaceClientFingerprint } from "./marketplaceFingerprint";
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
        trackColor={{ false: "#cbd5e1", true: "#99f6e4" }}
        thumbColor={value ? theme.colors.primary : theme.colors.surface}
      />
      <Text style={styles.consentText}>{label}</Text>
    </Pressable>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
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

export function BuyerRequestPanel() {
  const { locale, t, textDirection } = useLocale();
  const submitRequest = useAction(api.marketplaceRequests.submitRequest);
  const [fields, setFields] = useState<RequestFields>(DEFAULT_REQUEST_FIELDS);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [verificationResetKey, setVerificationResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedRequest, setSubmittedRequest] = useState<{ requestId: string; matchedCount: number } | null>(null);
  const turnstileSiteKey = getTurnstileSiteKey();

  function setField<TKey extends keyof RequestFields>(key: TKey, value: RequestFields[TKey]) {
    setFields((current) => ({ ...current, [key]: value }));
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
        <FormField
          label={t("marketplaceCity")}
          value={fields.buyerCity}
          onChangeText={(value) => setField("buyerCity", value)}
        />
        <FormField
          label={t("marketplaceMake")}
          value={fields.make}
          onChangeText={(value) => setField("make", value)}
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
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <SubmitButton label={t("marketplaceSubmitRequest")} submitting={submitting} onPress={submitBuyerRequest} />
    </View>
  );
}

function DealerSelector({
  onSelectDealer,
}: {
  onSelectDealer: (dealer: TradeInDealerTarget) => void;
}) {
  const { t, textDirection } = useLocale();
  const dealers = useQuery(api.marketplaceDealers.listPublicDirectory, {});

  if (dealers === undefined) {
    return <RouteLoadingState label={t("marketplaceLoadingDealers")} />;
  }

  if (dealers.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceNoTradeInDealers")}</Text>;
  }

  return (
    <View style={[styles.selectorList, { direction: textDirection }]}>
      {dealers.map((dealer) => (
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
  const { locale, t, textDirection } = useLocale();
  const submitTradeInRequest = useAction(api.marketplaceTradeIns.submitTradeInRequest);
  const [fields, setFields] = useState<TradeInFields>(DEFAULT_TRADE_IN_FIELDS);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [verificationResetKey, setVerificationResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedTradeIn, setSubmittedTradeIn] = useState<{ tradeInRequestId: string } | null>(null);
  const turnstileSiteKey = getTurnstileSiteKey();

  function setField<TKey extends keyof TradeInFields>(key: TKey, value: TradeInFields[TKey]) {
    setFields((current) => ({ ...current, [key]: value }));
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
            onPress={onClearDealer}
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
              label={t("marketplaceCurrentMake")}
              value={fields.currentMake}
              onChangeText={(value) => setField("currentMake", value)}
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
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <SubmitButton
            label={t("marketplaceSubmitTradeIn")}
            submitting={submitting}
            onPress={submitTradeInOfferRequest}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  panelHeader: {
    gap: theme.spacing.xs,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "900",
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
    fontWeight: "800",
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
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  choiceButtonSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: "#ccfbf1",
  },
  choiceText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
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
    borderRadius: theme.radius.sm,
    backgroundColor: "#dcfce7",
    padding: theme.spacing.md,
  },
  noticeTitle: {
    color: theme.colors.success,
    fontSize: 15,
    fontWeight: "900",
  },
  noticeBody: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  idBox: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  idText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  primaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
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
    fontWeight: "900",
  },
  selectorList: {
    gap: theme.spacing.sm,
  },
  selectorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  selectedDealerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  selectorText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  selectorTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
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
    fontWeight: "900",
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
