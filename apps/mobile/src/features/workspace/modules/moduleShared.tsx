import { useRouter } from "expo-router";
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { FadeSlideIn } from "../../../components/Motion";
import { Icon } from "../../../components/Icon";
import { LocaleToggle } from "../../../components/LocaleToggle";
import { SearchableSelectField, type SearchableSelectOption } from "../../../components/SearchableSelectField";
import { api, type MobileDirectConversation, type MobileFinanceCompany, type MobileOrgSummary, type MobileSale, type MobileSaleStatus, type MobileVehicle } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { theme } from "../../../theme";
import { getFirstNhtsaResult, getFirstNhtsaWmiName, mapNhtsaVinPayload, type MobileVinDecodedFields, type MobileVinReadiness } from "../mobileVinDecode";
import { getNativeModule, getVisibleNativeModulesByCategory, labelFor, nativeModulePath, type NativeModuleId } from "../nativeModules";
import { styles } from "./moduleStyles";

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

export type FormFieldProps = {
  keyboardType?: "default" | "email-address" | "numeric" | "phone-pad";
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
};

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

export function money(value: number | undefined | null, locale: "en" | "ar"): string {
  const safeValue = Number.isFinite(value ?? 0) ? Number(value ?? 0) : 0;
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
      style: "currency",
      currency: "JOD",
    }).format(safeValue);
  } catch {
    return `${Math.round(safeValue)} JOD`;
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

export function FormField({
  keyboardType = "default",
  label,
  multiline,
  onChangeText,
  placeholder,
  value,
}: FormFieldProps) {
  return (
    <View style={styles.formField}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        keyboardType={keyboardType}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.mutedText}
        style={[styles.formInput, multiline && styles.formInputMultiline]}
        textAlignVertical={multiline ? "top" : "center"}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
}

export function SelectField({
  allowCustomValue,
  customValueLabel,
  label,
  onChange,
  options,
  value,
}: {
  allowCustomValue?: boolean;
  customValueLabel?: string;
  label: string;
  onChange: (value: string) => void;
  options: SelectableOption[];
  value: string;
}) {
  const { locale } = useLocale();

  return (
    <SearchableSelectField
      allowCustomValue={allowCustomValue}
      closeLabel={locale === "ar" ? "إغلاق" : "Close"}
      customValueLabel={customValueLabel}
      emptyLabel={locale === "ar" ? "لا توجد نتائج." : "No results found."}
      label={label}
      options={options}
      placeholder={locale === "ar" ? "اختر" : "Select"}
      searchPlaceholder={locale === "ar" ? "بحث" : "Search"}
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

export function EmptyList({ label }: { label: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>{label}</Text>
    </View>
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
    return <Text style={styles.mutedText}>{locale === "ar" ? "جاري التحميل..." : "Loading..."}</Text>;
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

export function calculateFinancePreview(input: FinancePreviewInput) {
  if (input.vehiclePrice <= 0 || input.termMonths <= 0) {
    return {
      financedAmount: 0,
      monthlyInstallment: 0,
      totalContractValue: 0,
      totalProfit: 0,
    };
  }

  const years = input.termMonths / 12;
  const baseAmount = input.includesCommissionInDebt
    ? input.vehiclePrice - input.downPayment + input.adminFees
    : input.vehiclePrice - input.downPayment + input.adminFees + input.commission;
  const financedAmount = Math.max(0, baseAmount);
  const totalProfit = financedAmount * (input.profitRate / 100) * years;
  const debtBeforeInsurance = financedAmount + totalProfit;
  const insuranceAmount = debtBeforeInsurance * (input.insuranceRate / 100) * years;
  const totalContractValue = Math.max(
    0,
    debtBeforeInsurance + insuranceAmount + (input.includesCommissionInDebt ? input.commission : 0),
  );
  const paymentMonths = Math.max(0, input.termMonths - input.gracePeriodMonths);

  return {
    financedAmount,
    monthlyInstallment: paymentMonths > 0 ? totalContractValue / paymentMonths : 0,
    totalContractValue,
    totalProfit,
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
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <FadeSlideIn>{children}</FadeSlideIn>
    </ScrollView>
  );
}

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
  const handleEndReached =
    loadMore && status && canLoadMore(status) ? () => loadMore(PAGE_SIZE) : undefined;

  return (
    <FadeSlideIn style={styles.scroll}>
      <FlatList
        data={data as T[]}
        keyExtractor={keyExtractor}
        renderItem={({ item }) =>
          highlightId && keyExtractor(item) === highlightId ? (
            <View style={styles.highlightedRow}>{renderItem(item)}</View>
          ) : (
            renderItem(item)
          )
        }
        ListHeaderComponent={header ? <View style={styles.listHeader}>{header}</View> : null}
        ListEmptyComponent={emptyLabel ? <EmptyList label={emptyLabel} /> : null}
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

