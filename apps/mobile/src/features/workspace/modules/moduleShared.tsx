import { calculateUnifiedMurabaha } from "@autoflow/shared/financing";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import { EmptyState } from "../../../components/EmptyState";
import { FormField as SharedFormField, type FormFieldProps as SharedFormFieldProps } from "../../../components/FormField";
import { FadeSlideIn } from "../../../components/Motion";
import { Icon, type SemanticIconName } from "../../../components/Icon";
import { LocaleToggle } from "../../../components/LocaleToggle";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { SearchableSelectField, type SearchableSelectOption } from "../../../components/SearchableSelectField";
import { SkeletonRow } from "../../../components/SkeletonRow";
import { api, type MobileDirectConversation, type MobileFinanceCompany, type MobileOrgSummary, type MobileSale, type MobileSaleStatus, type MobileVehicle } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useAppTheme } from "../../../providers/ThemeProvider";
import { getFirstNhtsaResult, getFirstNhtsaWmiName, mapNhtsaVinPayload, type MobileVinDecodedFields, type MobileVinReadiness } from "../mobileVinDecode";
import { getNativeModule, getVisibleNativeModulesByCategory, labelFor, nativeModulePath, type NativeModuleId } from "../nativeModules";
import { useStyles } from "./moduleStyles";

export const PAGE_SIZE = 25;
export const SELECTOR_PAGE_SIZE = 100;

export type Option<T extends string> = {
  label: string;
  value: T;
};

export type SelectableOption = SearchableSelectOption;
export type AppLocale = "en" | "ar";
export type MobileSaleStatusFilter = MobileSaleStatus | "ALL";
export type MobileFinanceCompanyFilter = "ALL" | "ACTIVE" | "INACTIVE";

export type FinancePreviewInput = {
  adminFees: number;
  commission: number;
  downPayment: number;
  gracePeriodMonths: number;
  includesCommissionInDebt: boolean;
  insuranceRate: number;
  profitRate: number;
  termMonths: number;
  vehiclePrice: number;
};

export type WebsiteTemplateOption = {
  id: string;
  labelEn: string;
  labelAr: string;
  tier: "standard" | "signature";
};

export type WebsiteColorPreset = {
  labelEn: string;
  labelAr: string;
  primaryColor: string;
  secondaryColor: string;
};

export type FormFieldProps = Omit<SharedFormFieldProps, "variant">;

export const TERM_MONTH_PRESETS = ["36", "48", "60", "72"] as const;

export const FINANCE_SCENARIO_PRESETS = [
  { labelEn: "Compact", labelAr: "سيارة اقتصادية", price: "12000", downPayment: "2400" },
  { labelEn: "Family SUV", labelAr: "سيارة عائلية", price: "24000", downPayment: "4800" },
  { labelEn: "Premium", labelAr: "سيارة مميزة", price: "42000", downPayment: "8400" },
] as const;

export const WEBSITE_TEMPLATE_OPTIONS: WebsiteTemplateOption[] = [
  { id: "modern-showroom", labelEn: "Modern Showroom", labelAr: "معرض عصري", tier: "standard" },
  { id: "classic-inventory", labelEn: "Classic Inventory", labelAr: "مخزون كلاسيكي", tier: "standard" },
  { id: "premium-minimal", labelEn: "Premium Minimal", labelAr: "فاخر بسيط", tier: "standard" },
  { id: "prestige", labelEn: "Prestige", labelAr: "برستيج", tier: "signature" },
  { id: "velocity", labelEn: "Velocity", labelAr: "فيلوسيتي", tier: "signature" },
  { id: "avant", labelEn: "Avant", labelAr: "أفانت", tier: "signature" },
  { id: "obsidian-atelier", labelEn: "Obsidian Atelier", labelAr: "أوبسيديان أتولييه", tier: "signature" },
  { id: "desert-grand-tourer", labelEn: "Desert Grand Tourer", labelAr: "رحلة الصحراء", tier: "signature" },
  { id: "velocity-command", labelEn: "Velocity Command", labelAr: "مركز السرعة", tier: "signature" },
  { id: "lucent-studio", labelEn: "Lucent Studio", labelAr: "استوديو لوسنت", tier: "signature" },
  { id: "concierge-editorial", labelEn: "Concierge Editorial", labelAr: "كونسيرج تحريري", tier: "signature" },
  { id: "neon-grid", labelEn: "Neon Grid", labelAr: "شبكة نيون", tier: "signature" },
  { id: "cinema-noir", labelEn: "Cinema Noir", labelAr: "سينما نوار", tier: "signature" },
  { id: "atlas-rally", labelEn: "Atlas Rally", labelAr: "أطلس رالي", tier: "signature" },
  { id: "glass-horizon", labelEn: "Glass Horizon", labelAr: "أفق زجاجي", tier: "signature" },
  { id: "torque-lab", labelEn: "Torque Lab", labelAr: "مختبر العزم", tier: "signature" },
  { id: "pearl-majlis", labelEn: "Pearl Majlis", labelAr: "مجلس اللؤلؤ", tier: "signature" },
  { id: "prism-motion", labelEn: "Prism Motion", labelAr: "حركة بريزم", tier: "signature" },
  { id: "carbon-track", labelEn: "Carbon Track", labelAr: "مسار الكربون", tier: "signature" },
  { id: "solaris-bay", labelEn: "Solaris Bay", labelAr: "خليج سولاريس", tier: "signature" },
  { id: "pixel-showroom", labelEn: "Pixel Showroom", labelAr: "معرض بكسل", tier: "signature" },
  { id: "kinetic-luxury", labelEn: "Kinetic Luxury", labelAr: "فخامة حركية", tier: "signature" },
  { id: "kinetic-ev", labelEn: "Kinetic EV", labelAr: "كهرباء حركية", tier: "signature" },
  { id: "kinetic-sales", labelEn: "Kinetic Sales", labelAr: "مبيعات حركية", tier: "signature" },
];

export const WEBSITE_COLOR_PRESETS: WebsiteColorPreset[] = [
  { labelEn: "Executive Teal", labelAr: "تركواز تنفيذي", primaryColor: "#0f766e", secondaryColor: "#f97316" },
  { labelEn: "Graphite Gold", labelAr: "جرافيت ذهبي", primaryColor: "#111827", secondaryColor: "#d97706" },
  { labelEn: "Electric Lime", labelAr: "لايم كهربائي", primaryColor: "#155e75", secondaryColor: "#84cc16" },
  { labelEn: "Crimson Steel", labelAr: "فولاذ قرمزي", primaryColor: "#991b1b", secondaryColor: "#475569" },
  { labelEn: "Royal Emerald", labelAr: "زمرد ملكي", primaryColor: "#065f46", secondaryColor: "#7c3aed" },
];

export const HERO_TITLE_PRESETS: Record<AppLocale, readonly string[]> = {
  en: [
    "Premium Cars at Your Fingertips",
    "Your Trusted Auto Dealer",
    "Find Your Perfect Vehicle",
    "Quality Cars, Unbeatable Prices",
    "Certified Pre-Owned Vehicles",
  ],
  ar: [
    "سيارات مميزة بين يديك",
    "وكيلك الموثوق للسيارات",
    "اعثر على سيارتك المثالية",
    "جودة عالية وأسعار لا تقاوم",
    "مركبات معتمدة مضمونة",
  ],
};

export const HERO_SUBTITLE_PRESETS: Record<AppLocale, readonly string[]> = {
  en: [
    "Browse our public inventory and contact our team.",
    "We make car buying simple, fast, and transparent.",
    "Premium selection. Fair pricing. Outstanding service.",
    "Finance available. Drive away today.",
    "Contact us to schedule a test drive.",
  ],
  ar: [
    "تصفح مخزوننا وتواصل مع فريقنا.",
    "نجعل شراء السيارات بسيطا وسريعا وشفافا.",
    "اختيار متميز. أسعار عادلة. خدمة استثنائية.",
    "تمويل متاح. اقود سيارتك اليوم.",
    "تواصل معنا لحجز تجربة قيادة.",
  ],
};

export function vinNotReadyMessage(readiness: MobileVinReadiness, locale: AppLocale): string | null {
  if (readiness === "invalid-characters") {
    return locale === "ar" ? "رقم الشاصي لا يمكن أن يحتوي I أو O أو Q." : "VIN cannot contain I, O, or Q.";
  }

  if (readiness === "empty" || readiness === "incomplete") {
    return locale === "ar" ? "أدخل رقم شاصي كامل من 17 خانة." : "Enter a complete 17-character VIN.";
  }

  return null;
}

export function vinChecksumWarningMessage(locale: AppLocale): string {
  return locale === "ar"
    ? "تحذير: رقم الشاصي لا يطابق رقم التحقق، سنحاول فكّه كمعلومة إرشادية."
    : "Warning: VIN checksum did not match, decoding as advisory data.";
}

export function vinDecodeResultMessage(decoded: MobileVinDecodedFields, locale: AppLocale): string {
  if (decoded.make || decoded.model || decoded.year) {
    return locale === "ar" ? "تمت تعبئة بيانات السيارة من رقم الشاصي." : "Vehicle details filled from VIN.";
  }

  return locale === "ar"
    ? "لم نجد بيانات كافية لهذا الرقم، أكمل الحقول يدوياً."
    : "No usable VIN data found, complete the fields manually.";
}

export async function fetchDecodedMobileVin(vin: string): Promise<MobileVinDecodedFields> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const [vinResponse, wmiResponse] = await Promise.all([
      fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
        { signal: controller.signal },
      ),
      fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeWMI/${encodeURIComponent(vin.slice(0, 3))}?format=json`,
        { signal: controller.signal },
      ),
    ]);

    if (!vinResponse.ok || !wmiResponse.ok) {
      throw new Error("NHTSA VIN decode request failed");
    }

    const [vinPayload, wmiPayload]: [unknown, unknown] = await Promise.all([
      vinResponse.json(),
      wmiResponse.json(),
    ]);

    return mapNhtsaVinPayload({
      vin,
      vinValues: getFirstNhtsaResult(vinPayload),
      wmiName: getFirstNhtsaWmiName(wmiPayload),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function firstAvailableOrg(orgs: Array<MobileOrgSummary | null> | undefined): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

export function compactNumber(value: number, locale: "en" | "ar"): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(safeValue);
  } catch {
    return Math.round(safeValue).toString();
  }
}

// Decimal places to display per currency. JOD keeps this screen's existing
// whole-currency display convention (0) rather than its ISO subdivision (the
// ledger itself still stores JOD in 3-decimal minor units — see
// convex/utils/money.ts's CURRENCY_SCALES — this is a display-only choice).
// KWD/BHD/OMR are genuinely 3-decimal currencies (1000 fils/baisa per unit),
// so they need the extra precision or a value like "5.500" would render as
// misleadingly-rounded "6". Everything else defaults to the standard 2.
const CURRENCY_DISPLAY_FRACTION_DIGITS: Record<string, number> = {
  JOD: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

function fractionDigitsForCurrency(currency: string): number {
  return CURRENCY_DISPLAY_FRACTION_DIGITS[currency.toUpperCase()] ?? 2;
}

export function money(value: number | undefined | null, locale: "en" | "ar", currency: string = "JOD"): string {
  const safeValue = Number.isFinite(value ?? 0) ? Number(value ?? 0) : 0;
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: fractionDigitsForCurrency(currency),
      style: "currency",
      currency,
    }).format(safeValue);
  } catch {
    return `${Math.round(safeValue)} ${currency}`;
  }
}

export function dateLabel(value: number | undefined, locale: "en" | "ar"): string {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleDateString();
  }
}

export function relativeTimeLabel(value: number, locale: "en" | "ar"): string {
  const diff = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return locale === "ar" ? "الآن" : "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return dateLabel(value, locale);
}

export function directConversationTitle(
  conversation: MobileDirectConversation,
  currentUserId: string | undefined,
  fallback: string,
): string {
  if (conversation.type === "GROUP") {
    return conversation.name || fallback;
  }

  const otherMember = conversation.members.find((member) => member?._id !== currentUserId);
  return otherMember?.name || fallback;
}

export function maybeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseRequiredNumber(value: string): number | null {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? null : parsed;
}

export function parseRequiredPositiveNumber(value: string): number | null {
  const parsed = parseRequiredNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

export function splitLinesOrCommas(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinList(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

let idempotencyFallbackCounter = 0;

export function idempotencyKey(operation: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${operation}-${globalThis.crypto.randomUUID()}`;
  }

  idempotencyFallbackCounter += 1;
  return `${operation}-${Date.now().toString(36)}-${idempotencyFallbackCounter.toString(36)}`;
}

export function isPaginationLoading(status: string): boolean {
  return status === "LoadingFirstPage" || status === "LoadingMore";
}

export function canLoadMore(status: string): boolean {
  return status === "CanLoadMore";
}

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

/**
 * Per-field validation state for a module form.
 *
 * Validation used to be a blocking `Alert.alert("Required fields")`: it
 * interrupted modally, named no field, and left the user to guess which of a
 * dozen inputs was wrong. `validate` records a message per field instead and
 * returns whether the form may proceed, so the message can be rendered against
 * the field it belongs to.
 */
export function useFormErrors<Field extends string>() {
  const [errors, setErrors] = useState<FieldErrors<Field>>({});

  return useMemo(
    () => ({
      errors,
      /** Drop every message — call when (re)opening a form. */
      reset: () => setErrors({}),
      /** Records the failing fields. Returns true when none failed. */
      validate: (candidate: FieldErrors<Field>) => {
        const failed = Object.fromEntries(
          Object.entries(candidate).filter(([, message]) => Boolean(message)),
        ) as FieldErrors<Field>;
        setErrors(failed);
        return Object.keys(failed).length === 0;
      },
    }),
    [errors],
  );
}

export function requiredFieldMessage(locale: AppLocale): string {
  return locale === "ar" ? "هذا الحقل مطلوب" : "This field is required";
}

export function requiredSelectionMessage(locale: AppLocale): string {
  return locale === "ar" ? "اختر خياراً" : "Choose an option";
}

export function invalidNumberMessage(locale: AppLocale): string {
  return locale === "ar" ? "أدخل رقماً صالحاً" : "Enter a valid number";
}

/** `undefined` when the text is present, the required message when it is not. */
export function requiredText(value: string, locale: AppLocale): string | undefined {
  return value.trim() ? undefined : requiredFieldMessage(locale);
}

export function useGenericError() {
  const { locale } = useLocale();
  return (context: string, error: unknown) => {
    console.error(context, error);
    Alert.alert(
      locale === "ar" ? "تعذر الحفظ" : "Could not save",
      locale === "ar" ? "حدث خطأ غير متوقع. حاول مرة أخرى." : "An unexpected error occurred. Please try again.",
    );
  };
}

export function ModuleHeader({
  subtitle,
  title,
}: {
  subtitle: string;
  title: string;
}) {
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const styles = useStyles();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.back()}
      >
        <Icon color="text" name="back" size={22} />
      </Pressable>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        <Text numberOfLines={2} style={styles.headerSubtitle}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.headerActions}>
        <ThemeToggle />
        <LocaleToggle />
      </View>
    </View>
  );
}

export function PushedScreenHeader({
  onOverflow,
  subtitle,
  title,
}: {
  onOverflow?: () => void;
  subtitle?: string;
  title: string;
}) {
  const router = useRouter();
  const { locale, t, textDirection } = useLocale();
  const styles = useStyles();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.back()}
      >
        <Icon color="text" name="back" size={22} />
      </Pressable>
      <View style={styles.headerText}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.headerSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {onOverflow ? (
        <Pressable
          accessibilityLabel={locale === "ar" ? "المزيد" : "More options"}
          accessibilityRole="button"
          style={({ pressed }) => [styles.overflowButton, pressed && styles.pressed]}
          onPress={onOverflow}
        >
          <Icon color="text" name="more" size={22} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function ModuleSwitcherBar({
  activeModuleId,
  orgId,
  permissions,
  roleName,
}: {
  activeModuleId: NativeModuleId;
  orgId: string;
  permissions: readonly string[];
  roleName: string;
}) {
  const router = useRouter();
  const { locale, textDirection } = useLocale();
  const styles = useStyles();
  const activeModule = getNativeModule(activeModuleId);
  const modules = activeModule
    ? getVisibleNativeModulesByCategory(activeModule.category, permissions, roleName)
    : [];

  if (modules.length <= 1) {
    return null;
  }

  return (
    <View style={[styles.moduleSwitcher, { direction: textDirection }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.moduleSwitcherContent}
      >
        {modules.map((module) => {
          const selected = module.id === activeModuleId;
          return (
            <Pressable
              key={module.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.moduleSwitchChip,
                selected && styles.moduleSwitchChipSelected,
                pressed && styles.pressed,
              ]}
              onPress={() =>
                router.replace({
                  pathname: nativeModulePath(module.id),
                  params: { orgId, moduleId: module.id },
                })
              }
            >
              <View style={styles.moduleSwitchChipContent}>
                <Icon color={selected ? "onPrimary" : "mutedText"} name={module.icon} size={16} />
                <Text
                  numberOfLines={1}
                  style={[styles.moduleSwitchText, selected && styles.moduleSwitchTextSelected]}
                >
                  {labelFor(module.title, locale)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function SearchInput({
  onChangeText,
  placeholder,
  value,
}: {
  onChangeText: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const styles = useStyles();
  const theme = useAppTheme();
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.mutedText}
      style={styles.searchInput}
      value={value}
      onChangeText={onChangeText}
    />
  );
}

export function PrimaryButton({
  disabled,
  label,
  onPress,
  tone = "primary",
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone?: "primary" | "danger" | "muted";
}) {
  const styles = useStyles();
  const buttonStyle =
    tone === "danger"
      ? styles.dangerButton
      : tone === "muted"
        ? styles.mutedButton
        : styles.primaryButton;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      style={({ pressed }) => [
        buttonStyle,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Text
        style={
          tone === "muted"
            ? styles.mutedButtonText
            : tone === "danger"
              ? styles.dangerButtonText
              : styles.primaryButtonText
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Chip<T extends string>({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
  value: T;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function SegmentedControl<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void;
  options: Array<Option<T>>;
  value: T;
}) {
  const styles = useStyles();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => (
        <Chip
          key={option.value}
          label={option.label}
          selected={option.value === value}
          value={option.value}
          onPress={() => onChange(option.value)}
        />
      ))}
    </View>
  );
}

export function UnderlineTabBar<T extends string>({
  onChange,
  tabs,
  value,
}: {
  onChange: (value: T) => void;
  tabs: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}) {
  const { textDirection } = useLocale();
  const styles = useStyles();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.underlineTabBar}
      contentContainerStyle={[styles.underlineTabBarContent, { direction: textDirection }]}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.underlineTab, selected && styles.underlineTabSelected]}
            onPress={() => onChange(tab.value)}
          >
            <Text style={[styles.underlineTabText, selected && styles.underlineTabTextSelected]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * The module forms' text field. This used to be a second, divergent copy of
 * components/FormField that had lost its accessibilityLabel (so every field in
 * every module form announced as an unlabelled box — React Native has no
 * htmlFor, the visible label is not connected to the input) and its RTL
 * textAlign. It is now the same component in its `filled` skin.
 */
export function FormField(props: FormFieldProps) {
  return <SharedFormField {...props} variant="filled" />;
}

/**
 * Refs + wiring for return-key focus chaining across a form's text fields.
 *
 * `fieldProps(index)` gives each field its ref and, for every field but the
 * last, an onSubmitEditing that focuses the next one — so the keyboard's return
 * key walks the form instead of the user tapping every input by hand.
 */
export function useFieldFocusChain(count: number) {
  const refs = useRef<Array<TextInput | null>>([]);

  return useMemo(
    () => ({
      fieldProps: (index: number) => ({
        inputRef: (instance: TextInput | null) => {
          refs.current[index] = instance;
        },
        onSubmitEditing:
          index < count - 1
            ? () => {
              refs.current[index + 1]?.focus();
            }
            : undefined,
      }),
    }),
    [count],
  );
}

export function SelectField({
  allowCustomValue,
  customValueLabel,
  error,
  label,
  onChange,
  options,
  testID,
  value,
}: {
  allowCustomValue?: boolean;
  customValueLabel?: string;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  options: SelectableOption[];
  testID?: string;
  value: string;
}) {
  const { locale } = useLocale();

  return (
    <SearchableSelectField
      allowCustomValue={allowCustomValue}
      closeLabel={locale === "ar" ? "إغلاق" : "Close"}
      customValueLabel={customValueLabel}
      emptyLabel={locale === "ar" ? "لا توجد نتائج." : "No results found."}
      error={error}
      label={label}
      options={options}
      placeholder={locale === "ar" ? "اختر" : "Select"}
      searchPlaceholder={locale === "ar" ? "بحث" : "Search"}
      testID={testID}
      value={value}
      onChange={onChange}
    />
  );
}

export function FormModal({
  children,
  onClose,
  title,
  visible,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
}) {
  const { locale, textDirection } = useLocale();
  const styles = useStyles();

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modalRoot}
      >
        <View style={[styles.modalSheet, { direction: textDirection }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <PrimaryButton
              label={locale === "ar" ? "إغلاق" : "Close"}
              tone="muted"
              onPress={onClose}
            />
          </View>
          <ScrollView contentContainerStyle={styles.modalContent}>{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function RecordCard({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <View style={styles.recordCard}>{children}</View>;
}

export function MetricCard({
  caption,
  title,
  value,
}: {
  caption?: string;
  title: string;
  value: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricTitle}>{title}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.metricValue}>
        {value}
      </Text>
      {caption ? <Text style={styles.metricCaption}>{caption}</Text> : null}
    </View>
  );
}

/**
 * The modules' empty state. Was bare centred text in a card while the app
 * already had a richer EmptyState (icon + hint + action) that no module list
 * used — two components for one job, and the lists got the worse one. This is
 * now a thin adapter over that component so every empty list in the app looks
 * the same and can offer a way out of the dead end.
 */
export function EmptyList({
  actionLabel,
  hint,
  icon,
  label,
  onAction,
}: {
  actionLabel?: string;
  hint?: string;
  icon?: SemanticIconName;
  label: string;
  onAction?: () => void;
}) {
  return (
    <EmptyState
      actionLabel={actionLabel}
      hint={hint}
      icon={icon}
      title={label}
      onAction={onAction}
    />
  );
}

export function LoadMoreFooter({
  loadMore,
  status,
}: {
  loadMore: (numItems: number) => void;
  status: string;
}) {
  const { locale } = useLocale();
  const theme = useAppTheme();
  const styles = useStyles();

  if (canLoadMore(status)) {
    return (
      <PrimaryButton
        label={locale === "ar" ? "تحميل المزيد" : "Load more"}
        tone="muted"
        onPress={() => loadMore(PAGE_SIZE)}
      />
    );
  }

  if (isPaginationLoading(status)) {
    // A spinner, not the word "Loading…": the footer is a progress indicator,
    // and static text gives no signal that anything is still happening.
    return (
      <View style={styles.loadMoreFooter}>
        <ActivityIndicator
          accessibilityLabel={locale === "ar" ? "جاري التحميل" : "Loading"}
          color={theme.colors.primary}
        />
      </View>
    );
  }

  return null;
}

export function getOptionLabel(
  options: readonly SelectableOption[],
  value: string,
  fallback: string,
): string {
  return options.find((option) => option.value === value)?.label ?? fallback;
}

export function saleMatchesView(
  sale: MobileSale,
  statusFilter: MobileSaleStatusFilter,
  search: string,
): boolean {
  const query = search.trim().toLowerCase();
  const matchesStatus = statusFilter === "ALL" || sale.status === statusFilter;
  if (!query) return matchesStatus;

  const searchIndex = [
    sale.vehicleSummary,
    sale.vehicleVin,
    sale.customerName,
    sale.salespersonName,
    sale.financingType ?? "",
  ].join(" ");

  return matchesStatus && searchIndex.toLowerCase().includes(query);
}

export function averageSalePrice(sales: readonly MobileSale[]): number {
  if (sales.length === 0) return 0;
  return sales.reduce((total, sale) => total + sale.salePrice, 0) / sales.length;
}

export function saleRemainingBalance(sale: MobileSale): number {
  return Math.max(0, sale.salePrice - (sale.downPayment ?? 0));
}

export function vehicleListPriceLabel(
  sellingPrice: number | undefined,
  locale: AppLocale,
): string {
  return sellingPrice != null
    ? money(sellingPrice, locale)
    : locale === "ar" ? "بدون سعر" : "No list price";
}

/**
 * Finance preview for the workspace modules.
 *
 * This was a third hand-written copy of the Murabaha math, and it had already
 * drifted: it clamped `financedAmount` and `totalContractValue` with
 * `Math.max(0, …)`, which the canonical engine does not. The clamp is not
 * cosmetic — a down payment larger than the vehicle price produces a negative
 * financed amount, and the two implementations then disagree about both the
 * total and the monthly figure for the same deal.
 *
 * It delegates to the shared engine now. The clamps are gone rather than pushed
 * into the engine: a down payment exceeding the price is bad input, and the
 * honest fix is for the caller to reject it, not for the model to quietly
 * report a floor of zero and let a nonsense deal look plausible.
 */
export function calculateFinancePreview(input: FinancePreviewInput) {
  const result = calculateUnifiedMurabaha({
    vehiclePrice: input.vehiclePrice,
    downPayment: input.downPayment,
    commission: input.commission,
    processingFees: input.adminFees,
    annualProfitRate: input.profitRate,
    annualInsuranceRate: input.insuranceRate,
    termMonths: input.termMonths,
    gracePeriodMonths: input.gracePeriodMonths,
    includesCommissionInDebt: input.includesCommissionInDebt,
  });

  return {
    financedAmount: result.financedAmount,
    monthlyInstallment: result.monthlyInstallment,
    totalContractValue: result.totalContractValue,
    totalProfit: result.totalProfit,
  };
}

export function financeCompanyMatchesView(
  company: MobileFinanceCompany,
  statusFilter: MobileFinanceCompanyFilter,
  search: string,
): boolean {
  const matchesStatus =
    statusFilter === "ALL"
    || (statusFilter === "ACTIVE" && company.isActive)
    || (statusFilter === "INACTIVE" && !company.isActive);
  const query = search.trim().toLowerCase();
  if (!query) return matchesStatus;

  const searchIndex = [
    company.name,
    `${company.profitRate}`,
    `${company.maxTermMonths}`,
    `${company.maxFinancingLTV ?? ""}`,
  ].join(" ");

  return matchesStatus && searchIndex.toLowerCase().includes(query);
}

export function averageFinanceRate(companies: readonly MobileFinanceCompany[]): number {
  if (companies.length === 0) return 0;
  return companies.reduce((total, company) => total + company.profitRate, 0) / companies.length;
}

export function websiteTemplateLabel(templateId: string, locale: AppLocale): string {
  const template = WEBSITE_TEMPLATE_OPTIONS.find((option) => option.id === templateId);
  if (!template) return locale === "ar" ? "معرض عصري" : "Modern Showroom";
  return locale === "ar" ? template.labelAr : template.labelEn;
}

export function websiteTemplateOptions(locale: AppLocale): SelectableOption[] {
  return WEBSITE_TEMPLATE_OPTIONS.map((template) => ({
    label: locale === "ar" ? template.labelAr : template.labelEn,
    subLabel: template.tier === "signature"
      ? locale === "ar" ? "قالب مميز" : "Signature template"
      : locale === "ar" ? "قالب قياسي" : "Standard template",
    value: template.id,
  }));
}

export function heroPresetOptions(presets: readonly string[]): SelectableOption[] {
  return presets.map((preset) => ({ label: preset, value: preset }));
}

export function websiteAddressPreview(subdomainSlug: string, fallback?: string): string {
  const slug = subdomainSlug.trim().toLowerCase();
  if (slug) return `${slug}.autoflowdealer.com`;
  return fallback ?? "-";
}

export function websiteEnabledCount(sections: readonly { enabled: boolean }[]): number {
  return sections.filter((section) => section.enabled).length;
}

export function firstVehicleImageUrl(vehicle: MobileVehicle): string | undefined {
  return vehicle.imageUrls?.find((url): url is string => Boolean(url));
}

export function DetailPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "info";
}) {
  const styles = useStyles();
  return (
    <View
      style={[
        styles.detailPill,
        tone === "success" && styles.detailPillSuccess,
        tone === "warning" && styles.detailPillWarning,
        tone === "info" && styles.detailPillInfo,
      ]}
    >
      <Text style={styles.detailPillText}>{label}</Text>
    </View>
  );
}

export function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text numberOfLines={2} style={styles.summaryValue}>
        {value}
      </Text>
    </View>
  );
}

export function SummaryPanel({
  children,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.summaryPanel}>
      <View style={styles.summaryHeader}>
        <Text style={styles.summaryTitle}>{title}</Text>
        {subtitle ? <Text style={styles.summarySubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.summaryRows}>{children}</View>
    </View>
  );
}

export function WizardActions({
  activeStep,
  backLabel,
  nextLabel,
  onBack,
  onNext,
  onSave,
  saveLabel,
  saving,
  totalSteps,
}: {
  activeStep: number;
  backLabel: string;
  nextLabel: string;
  onBack: () => void;
  onNext: () => void;
  onSave: () => void;
  saveLabel: string;
  saving: boolean;
  totalSteps: number;
}) {
  const styles = useStyles();
  const isLastStep = activeStep >= totalSteps - 1;

  return (
    <View style={styles.wizardActions}>
      {activeStep > 0 ? (
        <PrimaryButton label={backLabel} tone="muted" onPress={onBack} />
      ) : null}
      <View style={styles.wizardPrimaryAction}>
        {isLastStep ? (
          <PrimaryButton disabled={saving} label={saveLabel} onPress={onSave} />
        ) : (
          <PrimaryButton label={nextLabel} onPress={onNext} />
        )}
      </View>
    </View>
  );
}

export function ModuleScroll({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <FadeSlideIn>{children}</FadeSlideIn>
    </ScrollView>
  );
}

/**
 * One row. Memoised so scrolling a long list re-renders only the cells that
 * actually changed, instead of every mounted row on every parent render.
 * `render` is a compared prop rather than a ref, so a row still updates when
 * the closure behind it changes (theme, locale, pending state).
 */
const ModuleListRow = memo(function ModuleListRow<T>({
  highlighted,
  item,
  render,
  rowStyle,
}: {
  highlighted: boolean;
  item: T;
  render: (item: T) => React.ReactElement;
  rowStyle: StyleProp<ViewStyle>;
}) {
  const content = render(item);
  return highlighted ? <View style={rowStyle}>{content}</View> : content;
}) as <T>(props: {
  highlighted: boolean;
  item: T;
  render: (item: T) => React.ReactElement;
  rowStyle: StyleProp<ViewStyle>;
}) => React.ReactElement;

export function ModuleList<T>({
  data,
  emptyLabel,
  header,
  highlightId,
  keyExtractor,
  loadMore,
  renderItem,
  status,
}: {
  data: readonly T[];
  emptyLabel: string;
  header?: React.ReactNode;
  highlightId?: string;
  keyExtractor: (item: T) => string;
  loadMore?: (numItems: number) => void;
  renderItem: (item: T) => React.ReactElement;
  status?: string;
}) {
  const styles = useStyles();
  const handleEndReached =
    loadMore && status && canLoadMore(status) ? () => loadMore(PAGE_SIZE) : undefined;
  // Hoisted out of the JSX: an inline arrow here is a new prop on every render,
  // which makes FlatList discard its cell cache and re-render every row.
  const renderRow = useCallback(
    ({ item }: { item: T }) => (
      <ModuleListRow
        highlighted={Boolean(highlightId) && keyExtractor(item) === highlightId}
        item={item}
        render={renderItem}
        rowStyle={styles.highlightedRow}
      />
    ),
    [highlightId, keyExtractor, renderItem, styles.highlightedRow],
  );
  // `data` is empty during the first page load as well as when there genuinely
  // is nothing, so keying the empty state off length alone made every list in
  // the app flash "No results" before its rows arrived — which reads as an
  // error, not as loading. Skeleton rows hold the space instead.
  const loadingFirstPage = status === "LoadingFirstPage";
  let listEmptyComponent: React.ReactElement | null = null;
  if (loadingFirstPage) {
    listEmptyComponent = <SkeletonRow count={4} />;
  } else if (emptyLabel) {
    listEmptyComponent = <EmptyList label={emptyLabel} />;
  }

  return (
    <FadeSlideIn style={styles.scroll}>
      <FlatList
        data={data as T[]}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        ListHeaderComponent={header ? <View style={styles.listHeader}>{header}</View> : null}
        ListEmptyComponent={listEmptyComponent}
        ListFooterComponent={
          loadMore && status ? <LoadMoreFooter loadMore={loadMore} status={status} /> : null
        }
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
      />
    </FadeSlideIn>
  );
}


export function LockedFeature({
  feature,
}: {
  feature: string;
}) {
  const { locale } = useLocale();
  return (
    <ModuleScroll>
      <EmptyList label={locale === "ar" ? `${feature} غير متاح في خطتك الحالية.` : `${feature} is not available on your current plan.`} />
    </ModuleScroll>
  );
}

