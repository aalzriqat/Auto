import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { RouteLoadingState } from "../../components/RouteState";
import { LocaleToggle } from "../../components/LocaleToggle";
import { GuidedStepFlow, type GuidedStep } from "../../components/GuidedStepFlow";
import { Screen } from "../../components/Screen";
import {
  SearchableSelectField,
  type SearchableSelectOption,
} from "../../components/SearchableSelectField";
import {
  api,
  type MobileApprovalRequest,
  type MobileBranch,
  type MobileCustomField,
  type MobileCustomFieldEntityType,
  type MobileCustomFieldType,
  type MobileCustomer,
  type MobileDirectConversation,
  type MobileDirectMember,
  type MobileDirectMessage,
  type MobileExpense,
  type MobileExpenseCategory,
  type MobileFacebookConnectionStatus,
  type MobileFeedback,
  type MobileFeedbackStatus,
  type MobileFeedbackType,
  type MobileFinanceCompany,
  type MobileFinanceApplication,
  type MobileFinancingType,
  type MobileInstagramConnectionStatus,
  type MobileLead,
  type MobileLeadStage,
  type MobileLeadSource,
  type MobileLedgerCategory,
  type MobileLedgerTransaction,
  type MobileLedgerType,
  type MobileMarketplaceDealerProfile,
  type MobileMembership,
  type MobileNotification,
  type MobileMyMembership,
  type MobileOrgSummary,
  type MobileOrgSettings,
  type MobilePipelineStage,
  type MobilePlanId,
  type MobileQuote,
  type MobileQuoteMode,
  type MobileQuoteStatus,
  type MobileRole,
  type MobileSale,
  type MobileSaleStatus,
  type MobileSocialConversation,
  type MobileSocialConversationEvent,
  type MobileSocialConversationKind,
  type MobileSocialPlatform,
  type MobileSupplierPayable,
  type MobileSupplierPayableStatus,
  type MobileTask,
  type MobileTaskPriority,
  type MobileValuationCompany,
  type MobileVehicle,
  type MobileVehicleStatus,
  type MobileWebsiteLanguage,
} from "../../convexApi";
import {
  getFuelTypeOptions,
  getTransmissionOptions,
  getVehicleColorOptions,
  getVehicleMakeOptions,
} from "../../data/mobileOptions";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  getFirstNhtsaResult,
  getFirstNhtsaWmiName,
  getMobileVinReadiness,
  mapNhtsaVinPayload,
  normalizeVinInput,
  type MobileVinDecodedFields,
  type MobileVinReadiness,
} from "./mobileVinDecode";
import {
  canAccessNativeModule,
  compactInitials,
  getNativeModule,
  getVisibleNativeModulesByCategory,
  labelFor,
  nativeModulePath,
  type NativeModuleId,
} from "./nativeModules";

const PAGE_SIZE = 25;
const SELECTOR_PAGE_SIZE = 100;

type Option<T extends string> = {
  label: string;
  value: T;
};

type SelectableOption = SearchableSelectOption;
type AppLocale = "en" | "ar";
type MobileSaleStatusFilter = MobileSaleStatus | "ALL";

type FormFieldProps = {
  keyboardType?: "default" | "email-address" | "numeric" | "phone-pad";
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
};

function vinNotReadyMessage(readiness: MobileVinReadiness, locale: AppLocale): string | null {
  if (readiness === "invalid-characters") {
    return locale === "ar" ? "رقم الشاصي لا يمكن أن يحتوي I أو O أو Q." : "VIN cannot contain I, O, or Q.";
  }

  if (readiness === "empty" || readiness === "incomplete") {
    return locale === "ar" ? "أدخل رقم شاصي كامل من 17 خانة." : "Enter a complete 17-character VIN.";
  }

  return null;
}

function vinChecksumWarningMessage(locale: AppLocale): string {
  return locale === "ar"
    ? "تحذير: رقم الشاصي لا يطابق رقم التحقق، سنحاول فكّه كمعلومة إرشادية."
    : "Warning: VIN checksum did not match, decoding as advisory data.";
}

function vinDecodeResultMessage(decoded: MobileVinDecodedFields, locale: AppLocale): string {
  if (decoded.make || decoded.model || decoded.year) {
    return locale === "ar" ? "تمت تعبئة بيانات السيارة من رقم الشاصي." : "Vehicle details filled from VIN.";
  }

  return locale === "ar"
    ? "لم نجد بيانات كافية لهذا الرقم، أكمل الحقول يدوياً."
    : "No usable VIN data found, complete the fields manually.";
}

async function fetchDecodedMobileVin(vin: string): Promise<MobileVinDecodedFields> {
  const vinResponse = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
  );
  const wmiResponse = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeWMI/${encodeURIComponent(vin.slice(0, 3))}?format=json`,
  );
  const vinPayload: unknown = await vinResponse.json();
  const wmiPayload: unknown = await wmiResponse.json();

  return mapNhtsaVinPayload({
    vin,
    vinValues: getFirstNhtsaResult(vinPayload),
    wmiName: getFirstNhtsaWmiName(wmiPayload),
  });
}

function firstAvailableOrg(orgs: Array<MobileOrgSummary | null> | undefined): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

function compactNumber(value: number, locale: "en" | "ar"): string {
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

function money(value: number | undefined | null, locale: "en" | "ar"): string {
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

function dateLabel(value: number | undefined, locale: "en" | "ar"): string {
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

function relativeTimeLabel(value: number, locale: "en" | "ar"): string {
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

function directConversationTitle(
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

function maybeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRequiredNumber(value: string): number | null {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? null : parsed;
}

function parseRequiredPositiveNumber(value: string): number | null {
  const parsed = parseRequiredNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function splitLinesOrCommas(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

let idempotencyFallbackCounter = 0;

function idempotencyKey(operation: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${operation}-${globalThis.crypto.randomUUID()}`;
  }

  idempotencyFallbackCounter += 1;
  return `${operation}-${Date.now().toString(36)}-${idempotencyFallbackCounter.toString(36)}`;
}

function isPaginationLoading(status: string): boolean {
  return status === "LoadingFirstPage" || status === "LoadingMore";
}

function canLoadMore(status: string): boolean {
  return status === "CanLoadMore";
}

function useGenericError() {
  const { locale } = useLocale();
  return (context: string, error: unknown) => {
    console.error(context, error);
    Alert.alert(
      locale === "ar" ? "تعذر الحفظ" : "Could not save",
      locale === "ar" ? "حدث خطأ غير متوقع. حاول مرة أخرى." : "An unexpected error occurred. Please try again.",
    );
  };
}

function ModuleHeader({
  subtitle,
  title,
}: {
  subtitle: string;
  title: string;
}) {
  const router = useRouter();
  const { isRtl, t, textDirection } = useLocale();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityLabel={t("back")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() => router.back()}
      >
        <Text style={styles.backButtonText}>{isRtl ? ">" : "<"}</Text>
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

function ModuleSwitcherBar({
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
              <Text
                numberOfLines={1}
                style={[styles.moduleSwitchText, selected && styles.moduleSwitchTextSelected]}
              >
                {labelFor(module.title, locale)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function SearchInput({
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

function PrimaryButton({
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
      <Text style={tone === "muted" ? styles.mutedButtonText : styles.primaryButtonText}>
        {label}
      </Text>
    </Pressable>
  );
}

function Chip<T extends string>({
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

function SegmentedControl<T extends string>({
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

function FormField({
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

function SelectField({
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

function FormModal({
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

function RecordCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.recordCard}>{children}</View>;
}

function MetricCard({
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

function EmptyList({ label }: { label: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>{label}</Text>
    </View>
  );
}

function LoadMoreFooter({
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

function getOptionLabel(
  options: readonly SelectableOption[],
  value: string,
  fallback: string,
): string {
  return options.find((option) => option.value === value)?.label ?? fallback;
}

function saleMatchesView(
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

function averageSalePrice(sales: readonly MobileSale[]): number {
  if (sales.length === 0) return 0;
  return sales.reduce((total, sale) => total + sale.salePrice, 0) / sales.length;
}

function saleRemainingBalance(sale: MobileSale): number {
  return Math.max(0, sale.salePrice - (sale.downPayment ?? 0));
}

function vehicleListPriceLabel(
  sellingPrice: number | undefined,
  locale: AppLocale,
): string {
  return sellingPrice != null
    ? money(sellingPrice, locale)
    : locale === "ar" ? "بدون سعر" : "No list price";
}

function firstVehicleImageUrl(vehicle: MobileVehicle): string | undefined {
  return vehicle.imageUrls?.find((url): url is string => Boolean(url));
}

function DetailPill({
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

function SummaryRow({
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

function SummaryPanel({
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

function WizardActions({
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

function ModuleScroll({ children }: { children: React.ReactNode }) {
  return <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>{children}</ScrollView>;
}

function DedicatedMarketplaceModule({ orgId }: { orgId: string }) {
  const router = useRouter();
  const { locale } = useLocale();

  return (
    <ModuleScroll>
      <View style={styles.emptyState}>
        <Text style={styles.sectionTitle}>
          {locale === "ar" ? "طلبات السوق لها شاشة مخصصة." : "Marketplace requests use a dedicated screen."}
        </Text>
        <Text style={styles.emptyText}>
          {locale === "ar"
            ? "افتح شاشة السوق الأصلية للرد على طلبات المشترين وسيارات البدل."
            : "Open the native marketplace screen to respond to buyer requests and trade-ins."}
        </Text>
        <PrimaryButton
          label={locale === "ar" ? "فتح السوق" : "Open marketplace"}
          onPress={() =>
            router.replace({
              pathname: "/org/[orgId]/marketplace",
              params: { orgId },
            })
          }
        />
      </View>
    </ModuleScroll>
  );
}

function CustomersModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createCustomer = useMutation(api.customers.create);
  const updateCustomer = useMutation(api.customers.update);
  const deleteCustomer = useMutation(api.customers.softDelete);
  const { loadMore, results, status } = usePaginatedQuery(
    api.customers.list,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileCustomer | null>(null);
  const [detailCustomer, setDetailCustomer] = useState<MobileCustomer | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    whatsapp: "",
    email: "",
    nationalId: "",
    address: "",
  });
  const [saving, setSaving] = useState(false);
  const filtered = results.filter((customer) => {
    const haystack = `${customer.firstName} ${customer.lastName} ${customer.phone ?? ""} ${customer.email ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const customersWithPhone = filtered.filter((customer) => Boolean(customer.phone || customer.whatsapp)).length;
  const customersWithEmail = filtered.filter((customer) => Boolean(customer.email)).length;

  function openCreate() {
    setEditing(null);
    setDetailCustomer(null);
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    setOpen(true);
  }

  function openEdit(customer: MobileCustomer) {
    setEditing(customer);
    setDetailCustomer(null);
    setForm({
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? "",
      whatsapp: customer.whatsapp ?? "",
      email: customer.email ?? "",
      nationalId: customer.nationalId ?? "",
      address: customer.address ?? "",
    });
    setOpen(true);
  }

  function closeCustomerForm() {
    setEditing(null);
    setOpen(false);
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
  }

  async function save() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateCustomer({
          orgId,
          customerId: editing._id,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: maybeText(form.phone),
          whatsapp: maybeText(form.whatsapp),
          email: maybeText(form.email),
          nationalId: maybeText(form.nationalId),
          address: maybeText(form.address),
        });
      } else {
        await createCustomer({
          orgId,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: maybeText(form.phone),
          whatsapp: maybeText(form.whatsapp),
          email: maybeText(form.email),
          nationalId: maybeText(form.nationalId),
          address: maybeText(form.address),
        });
      }
      setEditing(null);
      setOpen(false);
      setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    } catch (error) {
      reportError("Mobile customer save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(customer: MobileCustomer) {
    Alert.alert(
      locale === "ar" ? "أرشفة العميل؟" : "Archive customer?",
      `${customer.firstName} ${customer.lastName}`,
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: locale === "ar" ? "أرشفة" : "Archive",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCustomer({ orgId, customerId: customer._id });
            } catch (error) {
              reportError("Mobile customer archive failed", error);
            }
          },
        },
      ],
    );
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SearchInput
          placeholder={locale === "ar" ? "بحث العملاء" : "Search customers"}
          value={search}
          onChangeText={setSearch}
        />
        <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openCreate} />
      </View>
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "عملاء ظاهرون" : "visible customers"} />
        <MetricCard title={locale === "ar" ? "هاتف" : "Phone"} value={compactNumber(customersWithPhone, locale)} caption={locale === "ar" ? "جاهز للتواصل" : "call-ready"} />
        <MetricCard title={locale === "ar" ? "بريد" : "Email"} value={compactNumber(customersWithEmail, locale)} caption={locale === "ar" ? "للمتابعة" : "for follow-up"} />
        <MetricCard title={locale === "ar" ? "النقص" : "Gaps"} value={compactNumber(Math.max(0, filtered.length - customersWithPhone), locale)} caption={locale === "ar" ? "بدون هاتف" : "missing phone"} />
      </View>
      {filtered.length ? filtered.map((customer) => (
        <RecordCard key={customer._id}>
          <View style={styles.entityHeader}>
            <View style={styles.entityAvatar}>
              <Text style={styles.entityAvatarText}>
                {compactInitials(`${customer.firstName} ${customer.lastName}`)}
              </Text>
            </View>
            <View style={styles.entityText}>
              <Text style={styles.recordTitle}>{customer.firstName} {customer.lastName}</Text>
              <Text style={styles.recordMeta}>{customer.address || customer.source || (locale === "ar" ? "بدون عنوان" : "No address")}</Text>
            </View>
          </View>
          <View style={styles.detailPillRow}>
            <DetailPill label={customer.phone || (locale === "ar" ? "بدون هاتف" : "No phone")} tone={customer.phone ? "info" : "warning"} />
            <DetailPill label={customer.whatsapp || "WhatsApp"} tone={customer.whatsapp ? "success" : "neutral"} />
            <DetailPill label={customer.email || (locale === "ar" ? "بدون بريد" : "No email")} />
          </View>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailCustomer(customer)} />
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(customer)} />
            <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => remove(customer)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا يوجد عملاء." : "No customers found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal
        title={editing ? (locale === "ar" ? "تعديل العميل" : "Edit customer") : (locale === "ar" ? "عميل جديد" : "New customer")}
        visible={open}
        onClose={closeCustomerForm}
      >
        <FormField label={locale === "ar" ? "الاسم الأول" : "First name"} value={form.firstName} onChangeText={(firstName) => setForm((prev) => ({ ...prev, firstName }))} />
        <FormField label={locale === "ar" ? "اسم العائلة" : "Last name"} value={form.lastName} onChangeText={(lastName) => setForm((prev) => ({ ...prev, lastName }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.phone} onChangeText={(phone) => setForm((prev) => ({ ...prev, phone }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "واتساب" : "WhatsApp"} value={form.whatsapp} onChangeText={(whatsapp) => setForm((prev) => ({ ...prev, whatsapp }))} />
        <FormField keyboardType="email-address" label={locale === "ar" ? "البريد" : "Email"} value={form.email} onChangeText={(email) => setForm((prev) => ({ ...prev, email }))} />
        <FormField label={locale === "ar" ? "الرقم الوطني" : "National ID"} value={form.nationalId} onChangeText={(nationalId) => setForm((prev) => ({ ...prev, nationalId }))} />
        <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.address} onChangeText={(address) => setForm((prev) => ({ ...prev, address }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
      <FormModal
        title={detailCustomer ? `${detailCustomer.firstName} ${detailCustomer.lastName}` : ""}
        visible={Boolean(detailCustomer)}
        onClose={() => setDetailCustomer(null)}
      >
        {detailCustomer ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "ملف العميل" : "Customer profile"}
              subtitle={locale === "ar" ? "معلومات تواصل كاملة قبل إنشاء فرصة أو مهمة." : "Contact context before creating a lead or task."}
            >
              <SummaryRow label={locale === "ar" ? "الهاتف" : "Phone"} value={detailCustomer.phone || "-"} />
              <SummaryRow label="WhatsApp" value={detailCustomer.whatsapp || "-"} />
              <SummaryRow label={locale === "ar" ? "البريد" : "Email"} value={detailCustomer.email || "-"} />
              <SummaryRow label={locale === "ar" ? "الرقم الوطني" : "National ID"} value={detailCustomer.nationalId || "-"} />
              <SummaryRow label={locale === "ar" ? "العنوان" : "Address"} value={detailCustomer.address || "-"} />
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={detailCustomer.source || "-"} />
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => openEdit(detailCustomer)} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => remove(detailCustomer)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </ModuleScroll>
  );
}

function VehiclesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createVehicle = useMutation(api.vehicles.create);
  const updateVehicle = useMutation(api.vehicles.update);
  const archiveVehicle = useMutation(api.vehicles.softDelete);
  const [filter, setFilter] = useState<MobileVehicleStatus | "ALL">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.vehicles.list,
    filter === "ALL" ? { orgId } : { orgId, status: filter },
    { initialNumItems: PAGE_SIZE },
  );
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileVehicle | null>(null);
  const [detailVehicle, setDetailVehicle] = useState<MobileVehicle | null>(null);
  const [open, setOpen] = useState(false);
  const [vehicleStep, setVehicleStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [decodingVin, setDecodingVin] = useState(false);
  const [vinDecodeMessage, setVinDecodeMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    vin: "",
    make: "",
    model: "",
    trim: "",
    year: "",
    mileage: "",
    color: "",
    fuelType: "Gasoline",
    transmission: "Automatic",
    purchasePrice: "",
    sellingPrice: "",
    status: "AVAILABLE" as MobileVehicleStatus,
    notes: "",
  });
  const filtered = results.filter((vehicle) => {
    const haystack = `${vehicle.vin} ${vehicle.make} ${vehicle.model} ${vehicle.year}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const availableCount = filtered.filter((vehicle) => vehicle.status === "AVAILABLE").length;
  const inventoryValue = filtered.reduce((sum, vehicle) => sum + vehicle.sellingPrice, 0);
  const projectedMargin = filtered.reduce(
    (sum, vehicle) => sum + Math.max(0, vehicle.sellingPrice - (vehicle.purchasePrice ?? vehicle.sellingPrice)),
    0,
  );
  const statusOptions: Array<Option<MobileVehicleStatus | "ALL">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "AVAILABLE", label: locale === "ar" ? "متاح" : "Available" },
    { value: "RESERVED", label: locale === "ar" ? "محجوز" : "Reserved" },
    { value: "SOLD", label: locale === "ar" ? "مباع" : "Sold" },
    { value: "IN_REPAIR", label: locale === "ar" ? "صيانة" : "Repair" },
    { value: "ARCHIVED", label: locale === "ar" ? "مؤرشف" : "Archived" },
  ];
  const vehicleMakeOptions = getVehicleMakeOptions();
  const vehicleColorOptions = getVehicleColorOptions(locale);
  const fuelTypeOptions = getFuelTypeOptions(locale);
  const transmissionOptions = getTransmissionOptions(locale);
  const customValueLabel = locale === "ar" ? 'استخدام "{value}"' : 'Use "{value}"';
  const vehicleSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "تعريف السيارة" : "Identify vehicle",
      subtitle: locale === "ar" ? "افحص رقم الشاصي واملأ بيانات السيارة تلقائياً." : "Decode the VIN and auto-fill core vehicle details.",
    },
    {
      title: locale === "ar" ? "المواصفات والسعر" : "Specs and pricing",
      subtitle: locale === "ar" ? "أكمل اللون، القير، السعر، والحالة." : "Complete color, transmission, pricing, and status.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع البطاقة قبل إضافتها للمخزون." : "Check the inventory card before saving.",
    },
  ];
  const vehicleVinReadiness = getMobileVinReadiness(form.vin);
  const selectedVehicleStatusLabel = getOptionLabel(
    statusOptions.filter((option) => option.value !== "ALL").map((option) => ({
      label: option.label,
      value: option.value,
    })),
    form.status,
    form.status,
  );

  function openCreate() {
    setEditing(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
    setForm({
      vin: "",
      make: "",
      model: "",
      trim: "",
      year: "",
      mileage: "",
      color: "",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: "",
      sellingPrice: "",
      status: "AVAILABLE",
      notes: "",
    });
    setOpen(true);
  }

  function openEdit(vehicle: MobileVehicle) {
    setEditing(vehicle);
    setDetailVehicle(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
    setForm({
      vin: vehicle.vin,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim ?? "",
      year: String(vehicle.year),
      mileage: String(vehicle.mileage),
      color: vehicle.color,
      fuelType: vehicle.fuelType,
      transmission: vehicle.transmission,
      purchasePrice: vehicle.purchasePrice !== undefined ? String(vehicle.purchasePrice) : "",
      sellingPrice: String(vehicle.sellingPrice),
      status: vehicle.status,
      notes: vehicle.notes ?? "",
    });
    setOpen(true);
  }

  function closeVehicleForm() {
    setOpen(false);
    setEditing(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
  }

  async function decodeVehicleVin() {
    const vin = normalizeVinInput(form.vin);
    const readiness = getMobileVinReadiness(vin);
    const readinessMessage = vinNotReadyMessage(readiness, locale);
    setForm((prev) => ({ ...prev, vin }));

    if (readinessMessage) {
      setVinDecodeMessage(readinessMessage);
      Alert.alert(locale === "ar" ? "رقم الشاصي غير جاهز" : "VIN is not ready", readinessMessage);
      return;
    }

    setDecodingVin(true);
    setVinDecodeMessage(
      readiness === "checksum-warning"
        ? vinChecksumWarningMessage(locale)
        : null,
    );

    try {
      const decoded = await fetchDecodedMobileVin(vin);
      setForm((prev) => ({
        ...prev,
        vin: decoded.vin,
        make: decoded.make ?? prev.make,
        model: decoded.model ?? prev.model,
        trim: decoded.trim ?? prev.trim,
        year: decoded.year ? String(decoded.year) : prev.year,
        fuelType: decoded.fuelType ?? prev.fuelType,
      }));
      setVinDecodeMessage(vinDecodeResultMessage(decoded, locale));
    } catch (error) {
      reportError("Mobile VIN decode failed", error);
      setVinDecodeMessage(locale === "ar" ? "تعذر فك رقم الشاصي الآن." : "Could not decode VIN right now.");
    } finally {
      setDecodingVin(false);
    }
  }

  async function save() {
    const year = parseRequiredNumber(form.year);
    const mileage = parseRequiredNumber(form.mileage);
    const sellingPrice = parseRequiredNumber(form.sellingPrice);
    if (!form.make.trim() || !form.model.trim() || year === null || mileage === null || sellingPrice === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    if (!editing && !form.vin.trim()) {
      Alert.alert(locale === "ar" ? "رقم الشاصي مطلوب" : "VIN is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        orgId,
        vin: maybeText(form.vin),
        make: form.make,
        model: form.model,
        trim: maybeText(form.trim),
        year,
        mileage,
        color: form.color || "-",
        fuelType: form.fuelType || "-",
        transmission: form.transmission || "-",
        purchasePrice: parseOptionalNumber(form.purchasePrice),
        sellingPrice,
        status: form.status,
        notes: maybeText(form.notes),
      };
      if (editing) {
        await updateVehicle({ ...payload, vehicleId: editing._id });
      } else {
        await createVehicle({ ...payload, sourceType: "STOCK" as const });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile vehicle save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function archive(vehicle: MobileVehicle) {
    Alert.alert(
      locale === "ar" ? "أرشفة السيارة؟" : "Archive vehicle?",
      `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: locale === "ar" ? "أرشفة" : "Archive",
          style: "destructive",
          onPress: async () => {
            try {
              await archiveVehicle({ orgId, vehicleId: vehicle._id });
            } catch (error) {
              reportError("Mobile vehicle archive failed", error);
            }
          },
        },
      ],
    );
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SearchInput placeholder={locale === "ar" ? "بحث المخزون" : "Search inventory"} value={search} onChangeText={setSearch} />
        <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openCreate} />
      </View>
      <SegmentedControl options={statusOptions} value={filter} onChange={setFilter} />
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "مطابقة للبحث" : "matching search"} />
        <MetricCard title={locale === "ar" ? "المتاح" : "Available"} value={compactNumber(availableCount, locale)} caption={locale === "ar" ? "جاهز للبيع" : "ready to sell"} />
        <MetricCard title={locale === "ar" ? "القيمة" : "Value"} value={money(inventoryValue, locale)} caption={locale === "ar" ? "سعر البيع" : "list value"} />
        <MetricCard title={locale === "ar" ? "الهامش" : "Margin"} value={money(projectedMargin, locale)} caption={locale === "ar" ? "تقديري" : "projected"} />
      </View>
      {filtered.length ? filtered.map((vehicle) => {
        const imageUrl = firstVehicleImageUrl(vehicle);
        return (
          <View key={vehicle._id} style={styles.vehicleRecordCard}>
            <View style={styles.vehicleMediaRow}>
              <View style={styles.vehicleThumb}>
                {imageUrl ? (
                  <Image
                    source={{ uri: imageUrl }}
                    style={styles.vehicleThumbImage}
                    resizeMode="cover"
                  />
                ) : (
                  <Text style={styles.vehicleThumbText}>{vehicle.make.slice(0, 2).toUpperCase()}</Text>
                )}
              </View>
              <View style={styles.vehicleCardText}>
                <View style={styles.recordHeader}>
                  <Text style={styles.recordTitle}>{vehicle.year} {vehicle.make} {vehicle.model}</Text>
                  <Text style={styles.statusPill}>{vehicle.status}</Text>
                </View>
                <Text style={styles.recordMeta}>{vehicle.trim || vehicle.vin}</Text>
                <View style={styles.detailPillRow}>
                  <DetailPill label={money(vehicle.sellingPrice, locale)} tone="success" />
                  <DetailPill label={`${vehicle.mileage.toLocaleString()} km`} tone="info" />
                  <DetailPill label={vehicle.transmission || "-"} />
                </View>
              </View>
            </View>
            <View style={styles.vehicleFactRow}>
              <Text style={styles.recordMeta}>{vehicle.vin}</Text>
              <Text style={styles.recordMeta}>{vehicle.color || "-"} · {vehicle.fuelType || "-"}</Text>
            </View>
            {vehicle.pendingStatusRequest ? <Text style={styles.warningText}>{vehicle.pendingStatusRequest}</Text> : null}
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailVehicle(vehicle)} />
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(vehicle)} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(vehicle)} />
            </View>
          </View>
        );
      }) : <EmptyList label={locale === "ar" ? "لا توجد سيارات." : "No vehicles found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={editing ? (locale === "ar" ? "تعديل سيارة" : "Edit vehicle") : (locale === "ar" ? "سيارة جديدة" : "New vehicle")} visible={open} onClose={closeVehicleForm}>
        <GuidedStepFlow activeIndex={vehicleStep} steps={vehicleSteps}>
          {vehicleStep === 0 ? (
            <>
              <View style={styles.inlineActionGroup}>
                <View style={styles.inlineActionField}>
                  <FormField
                    label="VIN"
                    value={form.vin}
                    onChangeText={(vin) => {
                      setVinDecodeMessage(null);
                      setForm((prev) => ({ ...prev, vin: normalizeVinInput(vin) }));
                    }}
                  />
                </View>
                <PrimaryButton
                  disabled={decodingVin}
                  label={decodingVin ? (locale === "ar" ? "جاري الفحص..." : "Decoding...") : (locale === "ar" ? "فك الرقم" : "Decode VIN")}
                  tone="muted"
                  onPress={decodeVehicleVin}
                />
              </View>
              {vehicleVinReadiness === "checksum-warning" ? (
                <Text style={styles.warningText}>
                  {locale === "ar"
                    ? "رقم التحقق لا يطابق هذا الشاصي، لكنه قد يكون صحيحاً لبعض الأسواق."
                    : "Checksum does not match; this can still be valid for some markets."}
                </Text>
              ) : null}
              {vinDecodeMessage ? <Text style={styles.recordMeta}>{vinDecodeMessage}</Text> : null}
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "الماركة" : "Make"} value={form.make} options={vehicleMakeOptions} onChange={(make) => setForm((prev) => ({ ...prev, make }))} />
              <FormField label={locale === "ar" ? "الموديل" : "Model"} value={form.model} onChangeText={(model) => setForm((prev) => ({ ...prev, model }))} />
              <FormField label={locale === "ar" ? "الفئة" : "Trim"} value={form.trim} onChangeText={(trim) => setForm((prev) => ({ ...prev, trim }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "السنة" : "Year"} value={form.year} onChangeText={(year) => setForm((prev) => ({ ...prev, year }))} />
            </>
          ) : null}
          {vehicleStep === 1 ? (
            <>
              <FormField keyboardType="numeric" label={locale === "ar" ? "الممشى" : "Mileage"} value={form.mileage} onChangeText={(mileage) => setForm((prev) => ({ ...prev, mileage }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "اللون" : "Color"} value={form.color} options={vehicleColorOptions} onChange={(color) => setForm((prev) => ({ ...prev, color }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "الوقود" : "Fuel"} value={form.fuelType} options={fuelTypeOptions} onChange={(fuelType) => setForm((prev) => ({ ...prev, fuelType }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "القير" : "Transmission"} value={form.transmission} options={transmissionOptions} onChange={(transmission) => setForm((prev) => ({ ...prev, transmission }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر الشراء" : "Purchase price"} value={form.purchasePrice} onChangeText={(purchasePrice) => setForm((prev) => ({ ...prev, purchasePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر البيع" : "Selling price"} value={form.sellingPrice} onChangeText={(sellingPrice) => setForm((prev) => ({ ...prev, sellingPrice }))} />
              <SelectField
                label={locale === "ar" ? "الحالة" : "Status"}
                value={form.status}
                onChange={(value) => setForm((prev) => ({ ...prev, status: value as MobileVehicleStatus }))}
                options={statusOptions.filter((option) => option.value !== "ALL").map((option) => ({ label: option.label, value: option.value }))}
              />
            </>
          ) : null}
          {vehicleStep === 2 ? (
            <>
              <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
              <SummaryPanel
                title={locale === "ar" ? "بطاقة المخزون" : "Inventory card"}
                subtitle={locale === "ar" ? "هذه هي البيانات التي ستظهر في المخزون." : "These details will be saved into inventory."}
              >
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={`${form.year || "-"} ${form.make || "-"} ${form.model || "-"}`} />
                <SummaryRow label={locale === "ar" ? "الفئة" : "Trim"} value={form.trim || "-"} />
                <SummaryRow label="VIN" value={form.vin || "-"} />
                <SummaryRow label={locale === "ar" ? "المواصفات" : "Specs"} value={`${form.color || "-"} · ${form.fuelType || "-"} · ${form.transmission || "-"}`} />
                <SummaryRow label={locale === "ar" ? "الممشى" : "Mileage"} value={form.mileage ? `${form.mileage} km` : "-"} />
                <SummaryRow label={locale === "ar" ? "سعر البيع" : "Selling price"} value={money(parseOptionalNumber(form.sellingPrice), locale)} />
                <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={selectedVehicleStatusLabel} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={vehicleStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ السيارة" : "Save vehicle")}
            saving={saving}
            totalSteps={vehicleSteps.length}
            onBack={() => setVehicleStep((step) => Math.max(0, step - 1))}
            onNext={() => setVehicleStep((step) => Math.min(vehicleSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailVehicle ? `${detailVehicle.year} ${detailVehicle.make} ${detailVehicle.model}` : ""}
        visible={Boolean(detailVehicle)}
        onClose={() => setDetailVehicle(null)}
      >
        {detailVehicle ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "بطاقة السيارة" : "Vehicle card"}
              subtitle={locale === "ar" ? "ملخص سريع قبل التعديل أو التواصل مع العميل." : "A fast read before editing or talking to a buyer."}
            >
              <SummaryRow label="VIN" value={detailVehicle.vin || "-"} />
              <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={detailVehicle.status} />
              <SummaryRow label={locale === "ar" ? "سعر البيع" : "Selling price"} value={money(detailVehicle.sellingPrice, locale)} />
              <SummaryRow label={locale === "ar" ? "سعر الشراء" : "Purchase price"} value={money(detailVehicle.purchasePrice, locale)} />
              <SummaryRow label={locale === "ar" ? "الممشى" : "Mileage"} value={`${detailVehicle.mileage.toLocaleString()} km`} />
              <SummaryRow label={locale === "ar" ? "المواصفات" : "Specs"} value={`${detailVehicle.color || "-"} · ${detailVehicle.fuelType || "-"} · ${detailVehicle.transmission || "-"}`} />
              {detailVehicle.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={detailVehicle.notes} /> : null}
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => openEdit(detailVehicle)} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(detailVehicle)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </ModuleScroll>
  );
}

function LeadsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createLead = useMutation(api.leads.create);
  const updateLead = useMutation(api.leads.update);
  const deleteLead = useMutation(api.leads.softDelete);
  const [stageFilter, setStageFilter] = useState<MobileLeadStage | "ALL">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.leads.list,
    stageFilter === "ALL" ? { orgId } : { orgId, stage: stageFilter },
    { initialNumItems: PAGE_SIZE },
  );
  const customers = useQuery(api.customers.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const members = useQuery(api.memberships.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [leadStep, setLeadStep] = useState(0);
  const [detailLead, setDetailLead] = useState<MobileLead | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    assignedUserId: "",
    source: "Manual",
    stage: "NEW" as MobileLeadStage,
    notes: "",
  });
  const stageOptions: Array<Option<MobileLeadStage | "ALL">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "NEW", label: locale === "ar" ? "جديد" : "New" },
    { value: "CONTACTED", label: locale === "ar" ? "تم التواصل" : "Contacted" },
    { value: "INTERESTED", label: locale === "ar" ? "مهتم" : "Interested" },
    { value: "TEST_DRIVE", label: locale === "ar" ? "تجربة" : "Test drive" },
    { value: "NEGOTIATION", label: locale === "ar" ? "تفاوض" : "Negotiation" },
    { value: "RESERVED", label: locale === "ar" ? "محجوز" : "Reserved" },
    { value: "WON", label: locale === "ar" ? "ناجح" : "Won" },
    { value: "LOST", label: locale === "ar" ? "خاسر" : "Lost" },
  ];
  const filtered = results.filter((lead) => {
    const haystack = `${lead.customerName} ${lead.phone ?? ""} ${lead.vehicleSummary ?? ""} ${lead.source}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const activeLeadCount = filtered.filter((lead) => lead.stage !== "WON" && lead.stage !== "LOST").length;
  const assignedLeadCount = filtered.filter((lead) => Boolean(lead.assignedUserName)).length;
  const vehicleLeadCount = filtered.filter((lead) => Boolean(lead.vehicleSummary)).length;

  const customerOptions = (customers?.page ?? []).map((customer) => ({
    label: `${customer.firstName} ${customer.lastName}`,
    value: customer._id,
  }));
  const vehicleOptions = [
    { label: locale === "ar" ? "بدون سيارة" : "No vehicle", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      value: vehicle._id,
    })),
  ];
  const memberOptions = [
    { label: locale === "ar" ? "بدون تعيين" : "Unassigned", value: "" },
    ...(members?.page ?? []).map((member) => ({ label: member.userName, value: member.userId })),
  ];
  const stageSelectOptions = stageOptions
    .filter((option) => option.value !== "ALL")
    .map((option) => ({ label: option.label, value: option.value }));
  const selectedLeadCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedLeadVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "بدون سيارة" : "No vehicle");
  const selectedLeadOwnerLabel = getOptionLabel(memberOptions, form.assignedUserId, locale === "ar" ? "بدون تعيين" : "Unassigned");
  const leadSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "اربط الفرصة بعميل وسيارة اختيارية." : "Attach the opportunity to a customer and optional vehicle.",
    },
    {
      title: locale === "ar" ? "التأهيل" : "Qualification",
      subtitle: locale === "ar" ? "حدد المالك والمصدر والمرحلة الأولى." : "Set owner, source, and first pipeline stage.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع السياق قبل الحفظ." : "Confirm the lead context before saving.",
    },
  ];

  function openLeadForm() {
    setLeadStep(0);
    setForm({ customerId: "", vehicleId: "", assignedUserId: "", source: "Manual", stage: "NEW", notes: "" });
    setOpen(true);
  }

  function closeLeadForm() {
    setLeadStep(0);
    setOpen(false);
  }

  async function save() {
    if (!form.customerId) {
      Alert.alert(locale === "ar" ? "اختر عميلاً" : "Choose a customer");
      return;
    }
    setSaving(true);
    try {
      await createLead({
        orgId,
        customerId: form.customerId,
        assignedUserId: maybeText(form.assignedUserId),
        vehicleId: maybeText(form.vehicleId),
        source: form.source || "Manual",
        stage: form.stage,
        notes: maybeText(form.notes),
      });
      closeLeadForm();
      setForm({ customerId: "", vehicleId: "", assignedUserId: "", source: "Manual", stage: "NEW", notes: "" });
    } catch (error) {
      reportError("Mobile lead save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(lead: MobileLead, nextStage: MobileLeadStage) {
    try {
      await updateLead({ orgId, leadId: lead._id, stage: nextStage });
    } catch (error) {
      reportError("Mobile lead stage update failed", error);
    }
  }

  async function archive(lead: MobileLead) {
    try {
      await deleteLead({ orgId, leadId: lead._id });
    } catch (error) {
      reportError("Mobile lead archive failed", error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SearchInput placeholder={locale === "ar" ? "بحث العملاء المحتملين" : "Search leads"} value={search} onChangeText={setSearch} />
        <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openLeadForm} />
      </View>
      <SegmentedControl options={stageOptions} value={stageFilter} onChange={setStageFilter} />
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "فرص ظاهرة" : "visible leads"} />
        <MetricCard title={locale === "ar" ? "نشطة" : "Active"} value={compactNumber(activeLeadCount, locale)} caption={locale === "ar" ? "قبل الفوز/الخسارة" : "before won/lost"} />
        <MetricCard title={locale === "ar" ? "مع مسؤول" : "Assigned"} value={compactNumber(assignedLeadCount, locale)} caption={locale === "ar" ? "للمتابعة" : "owned follow-up"} />
        <MetricCard title={locale === "ar" ? "مع سيارة" : "Vehicle"} value={compactNumber(vehicleLeadCount, locale)} caption={locale === "ar" ? "محدد" : "specified"} />
      </View>
      {filtered.length ? filtered.map((lead) => (
        <RecordCard key={lead._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{lead.customerName}</Text>
            <Text style={styles.statusPill}>{lead.stage}</Text>
          </View>
          <View style={styles.detailPillRow}>
            <DetailPill label={lead.source || "Manual"} tone="info" />
            <DetailPill label={lead.assignedUserName || (locale === "ar" ? "بدون مسؤول" : "Unassigned")} tone={lead.assignedUserName ? "success" : "warning"} />
            <DetailPill label={lead.vehicleSummary || (locale === "ar" ? "بدون سيارة" : "No vehicle")} />
          </View>
          <Text style={styles.recordMeta}>{lead.phone || lead.email || "-"}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailLead(lead)} />
            <PrimaryButton label={locale === "ar" ? "التالي" : "Advance"} tone="muted" onPress={() => changeStage(lead, nextLeadStage(lead.stage))} />
            <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(lead)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد فرص." : "No leads found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={locale === "ar" ? "فرصة جديدة" : "New lead"} visible={open} onClose={closeLeadForm}>
        <GuidedStepFlow activeIndex={leadStep} steps={leadSteps}>
          {leadStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerId) => setForm((prev) => ({ ...prev, customerId }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={(vehicleId) => setForm((prev) => ({ ...prev, vehicleId }))} />
              <SummaryPanel title={locale === "ar" ? "ربط الفرصة" : "Lead link"}>
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedLeadCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedLeadVehicleLabel} />
              </SummaryPanel>
            </>
          ) : null}
          {leadStep === 1 ? (
            <>
              <SelectField label={locale === "ar" ? "المسؤول" : "Assigned to"} value={form.assignedUserId} options={memberOptions} onChange={(assignedUserId) => setForm((prev) => ({ ...prev, assignedUserId }))} />
              <FormField label={locale === "ar" ? "المصدر" : "Source"} value={form.source} onChangeText={(source) => setForm((prev) => ({ ...prev, source }))} />
              <SelectField label={locale === "ar" ? "المرحلة" : "Stage"} value={form.stage} options={stageSelectOptions} onChange={(stage) => setForm((prev) => ({ ...prev, stage: stage as MobileLeadStage }))} />
              <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
            </>
          ) : null}
          {leadStep === 2 ? (
            <SummaryPanel
              title={locale === "ar" ? "مراجعة الفرصة" : "Lead review"}
              subtitle={locale === "ar" ? "ستظهر في خط المبيعات بعد الحفظ." : "This will appear in the sales pipeline after saving."}
            >
              <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedLeadCustomerLabel} />
              <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedLeadVehicleLabel} />
              <SummaryRow label={locale === "ar" ? "المسؤول" : "Owner"} value={selectedLeadOwnerLabel} />
              <SummaryRow label={locale === "ar" ? "المرحلة" : "Stage"} value={form.stage} />
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={form.source || "Manual"} />
            </SummaryPanel>
          ) : null}
          <WizardActions
            activeStep={leadStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ الفرصة" : "Save lead")}
            saving={saving}
            totalSteps={leadSteps.length}
            onBack={() => setLeadStep((step) => Math.max(0, step - 1))}
            onNext={() => setLeadStep((step) => Math.min(leadSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailLead ? detailLead.customerName : ""}
        visible={Boolean(detailLead)}
        onClose={() => setDetailLead(null)}
      >
        {detailLead ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "ملف الفرصة" : "Lead profile"}
              subtitle={locale === "ar" ? "سياق سريع للمتابعة قبل تغيير المرحلة." : "Fast follow-up context before changing stage."}
            >
              <SummaryRow label={locale === "ar" ? "المرحلة" : "Stage"} value={detailLead.stage} />
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={detailLead.source || "Manual"} />
              <SummaryRow label={locale === "ar" ? "التواصل" : "Contact"} value={detailLead.phone || detailLead.email || "-"} />
              <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={detailLead.vehicleSummary || "-"} />
              <SummaryRow label={locale === "ar" ? "السعر" : "Price"} value={money(detailLead.vehiclePrice, locale)} />
              <SummaryRow label={locale === "ar" ? "المسؤول" : "Owner"} value={detailLead.assignedUserName || "-"} />
              {detailLead.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={detailLead.notes} /> : null}
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "التالي" : "Advance"} onPress={() => changeStage(detailLead, nextLeadStage(detailLead.stage))} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(detailLead)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </ModuleScroll>
  );
}

function nextLeadStage(stage: MobileLeadStage): MobileLeadStage {
  const order: MobileLeadStage[] = ["NEW", "CONTACTED", "INTERESTED", "TEST_DRIVE", "NEGOTIATION", "RESERVED", "WON"];
  const index = order.indexOf(stage);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : stage;
}

function TasksModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "COMPLETED">("PENDING");
  const { loadMore, results, status } = usePaginatedQuery(
    api.tasks.list,
    filter === "ALL" ? { orgId } : { orgId, status: filter },
    { initialNumItems: PAGE_SIZE },
  );
  const members = useQuery(api.memberships.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    assignedTo: "",
    title: "",
    description: "",
    dueDays: "1",
    priority: "MEDIUM" as MobileTaskPriority,
  });
  const statusOptions: Array<Option<"ALL" | "PENDING" | "COMPLETED">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "PENDING", label: locale === "ar" ? "معلقة" : "Pending" },
    { value: "COMPLETED", label: locale === "ar" ? "مكتملة" : "Completed" },
  ];
  const memberOptions = (members?.page ?? []).map((member) => ({ label: member.userName, value: member.userId }));

  async function save() {
    const dueDays = parseRequiredNumber(form.dueDays);
    const assignedTo = form.assignedTo || memberOptions[0]?.value;
    if (!assignedTo || !form.title.trim() || dueDays === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createTask({
        orgId,
        assignedTo,
        title: form.title,
        description: maybeText(form.description),
        dueDate: Date.now() + dueDays * 24 * 60 * 60 * 1000,
        priority: form.priority,
        status: "PENDING",
      });
      setOpen(false);
      setForm({ assignedTo: "", title: "", description: "", dueDays: "1", priority: "MEDIUM" });
    } catch (error) {
      reportError("Mobile task save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function setTaskStatus(task: MobileTask, nextStatus: "PENDING" | "COMPLETED" | "CANCELLED") {
    try {
      await updateTask({ orgId, taskId: task._id, status: nextStatus });
    } catch (error) {
      reportError("Mobile task update failed", error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SegmentedControl options={statusOptions} value={filter} onChange={setFilter} />
        <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={() => setOpen(true)} />
      </View>
      {results.length ? results.map((task) => (
        <RecordCard key={task._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{task.title}</Text>
            <Text style={styles.statusPill}>{task.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{locale === "ar" ? "المسؤول" : "Assignee"}: {task.assigneeName}</Text>
          <Text style={styles.recordMeta}>{locale === "ar" ? "الاستحقاق" : "Due"}: {dateLabel(task.dueDate, locale)}</Text>
          {task.customerName ? <Text style={styles.recordMeta}>{task.customerName}</Text> : null}
          <View style={styles.cardActions}>
            {task.status !== "COMPLETED" ? <PrimaryButton label={locale === "ar" ? "إنهاء" : "Complete"} tone="muted" onPress={() => setTaskStatus(task, "COMPLETED")} /> : null}
            {task.status !== "CANCELLED" ? <PrimaryButton label={locale === "ar" ? "إلغاء" : "Cancel"} tone="danger" onPress={() => setTaskStatus(task, "CANCELLED")} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مهام." : "No tasks found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={locale === "ar" ? "مهمة جديدة" : "New task"} visible={open} onClose={() => setOpen(false)}>
        <SelectField label={locale === "ar" ? "المسؤول" : "Assigned to"} value={form.assignedTo} options={memberOptions} onChange={(assignedTo) => setForm((prev) => ({ ...prev, assignedTo }))} />
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField multiline label={locale === "ar" ? "الوصف" : "Description"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "بعد كم يوم" : "Due in days"} value={form.dueDays} onChangeText={(dueDays) => setForm((prev) => ({ ...prev, dueDays }))} />
        <SelectField label={locale === "ar" ? "الأولوية" : "Priority"} value={form.priority} options={[
          { label: locale === "ar" ? "عالية" : "High", value: "HIGH" },
          { label: locale === "ar" ? "متوسطة" : "Medium", value: "MEDIUM" },
          { label: locale === "ar" ? "منخفضة" : "Low", value: "LOW" },
        ]} onChange={(priority) => setForm((prev) => ({ ...prev, priority: priority as MobileTaskPriority }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function SalesModule({ myMembership, orgId }: { myMembership: MobileMyMembership; orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createDraft = useMutation(api.sales.createDraft);
  const completeDraft = useMutation(api.sales.completeDraft);
  const updateSale = useMutation(api.sales.update);
  const { loadMore, results, status } = usePaginatedQuery(api.sales.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const customers = useQuery(api.customers.list, { orgId, paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE } });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const members = useQuery(api.memberships.list, { orgId, paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE } });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MobileSaleStatusFilter>("ALL");
  const [open, setOpen] = useState(false);
  const [draftStep, setDraftStep] = useState(0);
  const [detailSale, setDetailSale] = useState<MobileSale | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    salespersonId: myMembership.userId,
    salePrice: "",
    downPayment: "",
    financingType: "CASH" as MobileFinancingType,
  });
  const statusOptions: Array<Option<MobileSaleStatusFilter>> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "PENDING", label: locale === "ar" ? "معلقة" : "Pending" },
    { value: "COMPLETED", label: locale === "ar" ? "مكتملة" : "Completed" },
    { value: "CANCELLED", label: locale === "ar" ? "ملغاة" : "Cancelled" },
  ];
  const customerOptions = (customers?.page ?? []).map((customer) => ({
    label: `${customer.firstName} ${customer.lastName}`,
    subLabel: customer.phone || customer.whatsapp || customer.email || customer.address,
    value: customer._id,
  }));
  const vehicleOptions = (vehicles ?? []).map((vehicle) => ({
    label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    subLabel: `${vehicleListPriceLabel(vehicle.sellingPrice, locale)} · ${vehicle.trim || vehicle.status}`,
    value: vehicle._id,
  }));
  const memberOptions = (members?.page ?? []).map((member) => ({
    label: member.userName,
    subLabel: member.roleName,
    value: member.userId,
  }));
  const selectedVehicle = (vehicles ?? []).find((vehicle) => vehicle._id === form.vehicleId) ?? null;
  const selectedCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedSalespersonLabel = getOptionLabel(memberOptions, form.salespersonId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const salePricePreview = parseOptionalNumber(form.salePrice) ?? 0;
  const downPaymentPreview = parseOptionalNumber(form.downPayment) ?? 0;
  const remainingBalancePreview = Math.max(0, salePricePreview - downPaymentPreview);
  const filteredSales = results.filter((sale) => saleMatchesView(sale, statusFilter, search));
  const pendingSalesCount = results.filter((sale) => sale.status === "PENDING").length;
  const completedSalesCount = results.filter((sale) => sale.status === "COMPLETED").length;
  const averageVisibleDeal = averageSalePrice(filteredSales);
  const salesSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "اختر من القوائم القابلة للبحث." : "Search and pick the exact deal participants.",
    },
    {
      title: locale === "ar" ? "السعر والتمويل" : "Price and financing",
      subtitle: locale === "ar" ? "حدد السعر، الدفعة، وطريقة التمويل." : "Set price, deposit, and finance mode.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع الملخص قبل إنشاء المسودة." : "Confirm the draft before it enters the pipeline.",
    },
  ];

  function openDraft() {
    setDraftStep(0);
    setForm({
      customerId: "",
      vehicleId: "",
      salespersonId: myMembership.userId,
      salePrice: "",
      downPayment: "",
      financingType: "CASH",
    });
    setOpen(true);
  }

  function closeDraft() {
    setDraftStep(0);
    setOpen(false);
  }

  function selectVehicle(vehicleId: string) {
    const vehicle = (vehicles ?? []).find((candidate) => candidate._id === vehicleId);
    setForm((prev) => ({
      ...prev,
      vehicleId,
      salePrice: vehicle?.sellingPrice != null ? String(vehicle.sellingPrice) : prev.salePrice,
    }));
  }

  function applyVehiclePrice() {
    if (selectedVehicle?.sellingPrice == null) return;
    setForm((prev) => ({ ...prev, salePrice: String(selectedVehicle.sellingPrice) }));
  }

  function applySuggestedDeposit(percent: number) {
    const deposit = Math.round((salePricePreview * percent) / 100);
    setForm((prev) => ({ ...prev, downPayment: String(deposit) }));
  }

  async function saveDraft() {
    const salePrice = parseRequiredNumber(form.salePrice);
    if (!form.customerId || !form.vehicleId || !form.salespersonId || salePrice === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createDraft({
        orgId,
        customerId: form.customerId,
        vehicleId: form.vehicleId,
        salespersonId: form.salespersonId,
        salePrice,
        saleDate: Date.now(),
        status: "PENDING",
        financingType: form.financingType,
        downPayment: parseOptionalNumber(form.downPayment),
        idempotencyKey: idempotencyKey("sales.createDraft"),
      });
      closeDraft();
      setForm({ customerId: "", vehicleId: "", salespersonId: myMembership.userId, salePrice: "", downPayment: "", financingType: "CASH" });
    } catch (error) {
      reportError("Mobile sale draft save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function complete(sale: MobileSale) {
    try {
      await completeDraft({ orgId, saleId: sale._id, idempotencyKey: idempotencyKey("sales.completeDraft") });
    } catch (error) {
      reportError("Mobile sale complete failed", error);
    }
  }

  async function cancel(sale: MobileSale) {
    try {
      await updateSale({ orgId, saleId: sale._id, status: "CANCELLED" });
    } catch (error) {
      reportError("Mobile sale cancel failed", error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SearchInput
          placeholder={locale === "ar" ? "بحث المبيعات" : "Search sales"}
          value={search}
          onChangeText={setSearch}
        />
        <PrimaryButton label={locale === "ar" ? "مسودة" : "Draft"} onPress={openDraft} />
      </View>
      <SegmentedControl options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "ظاهرة" : "Visible"} value={compactNumber(filteredSales.length, locale)} caption={locale === "ar" ? "حسب الفلتر" : "after filters"} />
        <MetricCard title={locale === "ar" ? "معلقة" : "Pending"} value={compactNumber(pendingSalesCount, locale)} caption={locale === "ar" ? "تحتاج إجراء" : "need action"} />
        <MetricCard title={locale === "ar" ? "مكتملة" : "Closed"} value={compactNumber(completedSalesCount, locale)} caption={locale === "ar" ? "صفقات منتهية" : "completed deals"} />
        <MetricCard title={locale === "ar" ? "متوسط" : "Avg deal"} value={money(averageVisibleDeal, locale)} caption={locale === "ar" ? "للقائمة الحالية" : "visible list"} />
      </View>
      {filteredSales.length ? filteredSales.map((sale) => (
        <RecordCard key={sale._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{sale.vehicleSummary}</Text>
            <Text style={styles.statusPill}>{sale.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{sale.customerName} · {sale.salespersonName}</Text>
          <View style={styles.detailPillRow}>
            <DetailPill label={money(sale.salePrice, locale)} tone="success" />
            <DetailPill label={sale.financingType ?? "CASH"} tone="info" />
            <DetailPill label={dateLabel(sale.saleDate, locale)} />
          </View>
          {sale.downPayment != null ? (
            <Text style={styles.recordMeta}>{locale === "ar" ? "الدفعة" : "Down payment"}: {money(sale.downPayment, locale)}</Text>
          ) : null}
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailSale(sale)} />
            {sale.status === "PENDING" ? <PrimaryButton label={locale === "ar" ? "إتمام" : "Complete"} tone="muted" onPress={() => complete(sale)} /> : null}
            {sale.status !== "CANCELLED" ? <PrimaryButton label={locale === "ar" ? "إلغاء" : "Cancel"} tone="danger" onPress={() => cancel(sale)} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مبيعات لهذا الفلتر." : "No sales match this view."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={locale === "ar" ? "مسودة بيع" : "Sale draft"} visible={open} onClose={closeDraft}>
        <GuidedStepFlow activeIndex={draftStep} steps={salesSteps}>
          {draftStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerId) => setForm((prev) => ({ ...prev, customerId }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={selectVehicle} />
              <SummaryPanel
                title={locale === "ar" ? "اختيار الصفقة" : "Deal selection"}
                subtitle={locale === "ar" ? "اختيار السيارة يعبئ سعر القائمة تلقائياً." : "Picking a vehicle auto-fills its current list price."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedVehicleLabel} />
                {selectedVehicle ? (
                  <>
                    <SummaryRow label={locale === "ar" ? "السعر الحالي" : "List price"} value={vehicleListPriceLabel(selectedVehicle.sellingPrice, locale)} />
                    <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={selectedVehicle.status} />
                  </>
                ) : null}
              </SummaryPanel>
            </>
          ) : null}
          {draftStep === 1 ? (
            <>
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر البيع" : "Sale price"} value={form.salePrice} onChangeText={(salePrice) => setForm((prev) => ({ ...prev, salePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "الدفعة" : "Down payment"} value={form.downPayment} onChangeText={(downPayment) => setForm((prev) => ({ ...prev, downPayment }))} />
              <SummaryPanel
                title={locale === "ar" ? "مساعد التسعير" : "Pricing assist"}
                subtitle={locale === "ar" ? "اختصارات سريعة بدلاً من إدخال كل شيء يدوياً." : "Fast pricing actions instead of manual entry for every deal."}
              >
                <SummaryRow label={locale === "ar" ? "المركبة" : "Vehicle"} value={selectedVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "الرصيد بعد الدفعة" : "Balance after deposit"} value={money(remainingBalancePreview, locale)} />
                <View style={styles.cardActions}>
                  <PrimaryButton
                    disabled={!selectedVehicle}
                    label={locale === "ar" ? "سعر القائمة" : "Use list price"}
                    tone="muted"
                    onPress={applyVehiclePrice}
                  />
                  <PrimaryButton
                    disabled={salePricePreview <= 0}
                    label={locale === "ar" ? "دفعة 10%" : "10% down"}
                    tone="muted"
                    onPress={() => applySuggestedDeposit(10)}
                  />
                  <PrimaryButton
                    disabled={salePricePreview <= 0}
                    label={locale === "ar" ? "دفعة 20%" : "20% down"}
                    tone="muted"
                    onPress={() => applySuggestedDeposit(20)}
                  />
                </View>
              </SummaryPanel>
              <SelectField label={locale === "ar" ? "طريقة التمويل" : "Financing"} value={form.financingType} options={[
                { label: locale === "ar" ? "نقدا" : "Cash", value: "CASH" },
                { label: locale === "ar" ? "تمويل" : "Financed", value: "FINANCED" },
                { label: locale === "ar" ? "تأجير" : "Lease", value: "LEASE" },
              ]} onChange={(financingType) => setForm((prev) => ({ ...prev, financingType: financingType as MobileFinancingType }))} />
              <View style={styles.metricGrid}>
                <MetricCard title={locale === "ar" ? "السعر" : "Price"} value={money(salePricePreview, locale)} caption={locale === "ar" ? "سعر البيع" : "sale price"} />
                <MetricCard title={locale === "ar" ? "المتبقي" : "Balance"} value={money(remainingBalancePreview, locale)} caption={locale === "ar" ? "بعد الدفعة" : "after deposit"} />
              </View>
            </>
          ) : null}
          {draftStep === 2 ? (
            <>
              <SelectField label={locale === "ar" ? "البائع" : "Salesperson"} value={form.salespersonId} options={memberOptions} onChange={(salespersonId) => setForm((prev) => ({ ...prev, salespersonId }))} />
              <SummaryPanel
                title={locale === "ar" ? "مراجعة المسودة" : "Draft review"}
                subtitle={locale === "ar" ? "ستظهر كصفقة معلقة بعد الحفظ." : "This will enter sales as a pending deal."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "البائع" : "Salesperson"} value={selectedSalespersonLabel} />
                <SummaryRow label={locale === "ar" ? "السعر" : "Price"} value={money(salePricePreview, locale)} />
                <SummaryRow label={locale === "ar" ? "طريقة التمويل" : "Financing"} value={form.financingType} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={draftStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ المسودة" : "Save draft")}
            saving={saving}
            totalSteps={salesSteps.length}
            onBack={() => setDraftStep((step) => Math.max(0, step - 1))}
            onNext={() => setDraftStep((step) => Math.min(salesSteps.length - 1, step + 1))}
            onSave={saveDraft}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailSale ? detailSale.vehicleSummary : ""}
        visible={Boolean(detailSale)}
        onClose={() => setDetailSale(null)}
      >
        {detailSale ? (
          <>
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "السعر" : "Sale price"} value={money(detailSale.salePrice, locale)} caption={detailSale.financingType ?? "CASH"} />
              <MetricCard title={locale === "ar" ? "الدفعة" : "Deposit"} value={money(detailSale.downPayment, locale)} caption={locale === "ar" ? "مدفوعة مقدماً" : "up front"} />
              <MetricCard title={locale === "ar" ? "الرصيد" : "Balance"} value={money(saleRemainingBalance(detailSale), locale)} caption={locale === "ar" ? "بعد الدفعة" : "after deposit"} />
              <MetricCard title={locale === "ar" ? "العمولة" : "Commission"} value={money(detailSale.commissionAmount, locale)} caption={detailSale.commissionPaidAt ? dateLabel(detailSale.commissionPaidAt, locale) : (locale === "ar" ? "غير مدفوعة" : "unpaid")} />
            </View>
            <SummaryPanel
              title={locale === "ar" ? "ملخص الصفقة" : "Deal summary"}
              subtitle={locale === "ar" ? "تفاصيل سريعة قبل تغيير الحالة." : "Fast context before changing the status."}
            >
              <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={detailSale.status} />
              <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={detailSale.customerName} />
              <SummaryRow label={locale === "ar" ? "البائع" : "Salesperson"} value={detailSale.salespersonName} />
              <SummaryRow label="VIN" value={detailSale.vehicleVin} />
              <SummaryRow label={locale === "ar" ? "التاريخ" : "Date"} value={dateLabel(detailSale.saleDate, locale)} />
            </SummaryPanel>
            <View style={styles.cardActions}>
              {detailSale.status === "PENDING" ? (
                <PrimaryButton
                  label={locale === "ar" ? "إتمام البيع" : "Complete sale"}
                  onPress={() => {
                    complete(detailSale);
                    setDetailSale(null);
                  }}
                />
              ) : null}
              {detailSale.status !== "CANCELLED" ? (
                <PrimaryButton
                  label={locale === "ar" ? "إلغاء البيع" : "Cancel sale"}
                  tone="danger"
                  onPress={() => {
                    cancel(detailSale);
                    setDetailSale(null);
                  }}
                />
              ) : null}
            </View>
          </>
        ) : null}
      </FormModal>
    </ModuleScroll>
  );
}

function ExpensesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createExpense = useMutation(api.expenses.create);
  const removeExpense = useMutation(api.expenses.remove);
  const { loadMore, results, status } = usePaginatedQuery(api.expenses.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, includeReserved: true });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    amount: "",
    taxAmount: "",
    category: "OTHER" as MobileExpenseCategory,
    vendor: "",
    vehicleId: "",
    notes: "",
  });
  const vehicleOptions = [
    { label: locale === "ar" ? "عام" : "General", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id })),
  ];

  async function save() {
    const amount = parseRequiredNumber(form.amount);
    if (!form.title.trim() || amount === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createExpense({
        orgId,
        title: form.title,
        amount,
        taxAmount: parseOptionalNumber(form.taxAmount),
        date: Date.now(),
        category: form.category,
        status: "PAID",
        vendor: maybeText(form.vendor),
        vehicleId: maybeText(form.vehicleId),
        notes: maybeText(form.notes),
        idempotencyKey: idempotencyKey("expenses.create"),
      });
      setOpen(false);
      setForm({ title: "", amount: "", taxAmount: "", category: "OTHER", vendor: "", vehicleId: "", notes: "" });
    } catch (error) {
      reportError("Mobile expense save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(expense: MobileExpense) {
    try {
      await removeExpense({ orgId, expenseId: expense._id });
    } catch (error) {
      reportError("Mobile expense remove failed", error);
    }
  }

  return (
    <ModuleScroll>
      <PrimaryButton label={locale === "ar" ? "إضافة مصروف" : "Add expense"} onPress={() => setOpen(true)} />
      {results.length ? results.map((expense) => (
        <RecordCard key={expense._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{expense.title}</Text>
            <Text style={styles.statusPill}>{expense.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{money(expense.amount, locale)} · {expense.category}</Text>
          <Text style={styles.recordMeta}>{expense.vehicleSummary || expense.vendor || dateLabel(expense.date, locale)}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "حذف" : "Remove"} tone="danger" onPress={() => remove(expense)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مصاريف." : "No expenses found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={locale === "ar" ? "مصروف جديد" : "New expense"} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "المبلغ" : "Amount"} value={form.amount} onChangeText={(amount) => setForm((prev) => ({ ...prev, amount }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "الضريبة" : "Tax"} value={form.taxAmount} onChangeText={(taxAmount) => setForm((prev) => ({ ...prev, taxAmount }))} />
        <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={(vehicleId) => setForm((prev) => ({ ...prev, vehicleId }))} />
        <SelectField label={locale === "ar" ? "الفئة" : "Category"} value={form.category} options={["REPAIR", "MAINTENANCE", "INSPECTION", "REGISTRATION", "CLEANING", "MARKETING", "OFFICE", "RENT", "SALARIES", "UTILITIES", "INSURANCE", "OTHER"].map((value) => ({ label: value, value }))} onChange={(category) => setForm((prev) => ({ ...prev, category: category as MobileExpenseCategory }))} />
        <FormField label={locale === "ar" ? "المورد" : "Vendor"} value={form.vendor} onChangeText={(vendor) => setForm((prev) => ({ ...prev, vendor }))} />
        <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function ReportsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const [period, setPeriod] = useState<"MONTH" | "YEAR">("MONTH");
  const range = useMemo(() => {
    const now = new Date();
    const start = period === "MONTH"
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getFullYear(), 0, 1);
    const end = period === "MONTH"
      ? new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
      : new Date(now.getFullYear(), 11, 31, 23, 59, 59);
    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [period]);
  const sales = useQuery(api.reports.getSalesAndProfitReport, { orgId, ...range });
  const inventory = useQuery(api.reports.getInventoryReport, { orgId });
  const expenses = useQuery(api.reports.getExpensesReport, { orgId, ...range });
  const performance = useQuery(api.reports.getSalespersonPerformance, { orgId, ...range });
  const leads = useQuery(api.reports.getLeadConversionReport, { orgId, ...range });

  return (
    <ModuleScroll>
      <SegmentedControl
        options={[
          { label: locale === "ar" ? "الشهر" : "Month", value: "MONTH" },
          { label: locale === "ar" ? "السنة" : "Year", value: "YEAR" },
        ]}
        value={period}
        onChange={setPeriod}
      />
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "الإيراد" : "Revenue"} value={money(sales?.totalRevenue, locale)} caption={locale === "ar" ? "المبيعات" : "Sales"} />
        <MetricCard title={locale === "ar" ? "الربح" : "Profit"} value={money(sales?.totalProfit, locale)} caption={locale === "ar" ? "صافي" : "Net"} />
        <MetricCard title={locale === "ar" ? "المخزون" : "Inventory"} value={compactNumber(inventory?.availableCount ?? 0, locale)} caption={money(inventory?.totalValue, locale)} />
        <MetricCard title={locale === "ar" ? "المصاريف" : "Expenses"} value={money(expenses?.totalExpenses, locale)} caption={locale === "ar" ? "للفترة" : "Period"} />
        <MetricCard title={locale === "ar" ? "الفرص" : "Leads"} value={compactNumber(leads?.totalLeads ?? 0, locale)} caption={`${(leads?.overallConversionRate ?? 0).toFixed(1)}%`} />
        <MetricCard title={locale === "ar" ? "مبيعات الفريق" : "Team sales"} value={compactNumber(performance?.reduce((sum, row) => sum + row.vehiclesSold, 0) ?? 0, locale)} caption={locale === "ar" ? "سيارات" : "Vehicles"} />
      </View>
      <Text style={styles.sectionTitle}>{locale === "ar" ? "أفضل الأداء" : "Top performance"}</Text>
      {(performance ?? []).slice(0, 5).map((row) => (
        <RecordCard key={row.userId}>
          <Text style={styles.recordTitle}>{row.userName}</Text>
          <Text style={styles.recordMeta}>{row.vehiclesSold} · {money(row.totalRevenue, locale)} · {money(row.totalProfit, locale)}</Text>
        </RecordCard>
      ))}
    </ModuleScroll>
  );
}

function TeamModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const addMember = useMutation(api.memberships.add);
  const createAccount = useAction(api.memberships.createAccount);
  const updateRole = useMutation(api.memberships.updateRole);
  const updateCommissionRate = useMutation(api.memberships.updateCommissionRate);
  const { loadMore, results, status } = usePaginatedQuery(api.memberships.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const roles = useQuery(api.roles.list, { orgId });
  const roleOptions = (roles ?? []).map((role) => ({ label: role.name, value: role._id }));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<MobileMembership | null>(null);
  const [saving, setSaving] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    email: "",
    firstName: "",
    lastName: "",
    roleId: "",
    createDirectAccount: "false",
  });
  const [memberForm, setMemberForm] = useState({
    roleId: "",
    commissionRate: "0",
  });

  function openInvite() {
    setInviteForm({
      email: "",
      firstName: "",
      lastName: "",
      roleId: roleOptions[0]?.value ?? "",
      createDirectAccount: "false",
    });
    setInviteOpen(true);
  }

  function openMember(member: MobileMembership) {
    setEditing(member);
    setMemberForm({
      roleId: member.roleId,
      commissionRate: String(member.commissionRate ?? 0),
    });
  }

  async function saveInvite() {
    if (!inviteForm.email.trim() || !inviteForm.roleId) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (inviteForm.createDirectAccount === "true") {
        if (!inviteForm.firstName.trim() || !inviteForm.lastName.trim()) {
          Alert.alert(locale === "ar" ? "الاسم مطلوب" : "Name required");
          return;
        }
        await createAccount({
          orgId,
          email: inviteForm.email,
          firstName: inviteForm.firstName,
          lastName: inviteForm.lastName,
          roleId: inviteForm.roleId,
        });
      } else {
        await addMember({ orgId, userEmail: inviteForm.email, roleId: inviteForm.roleId });
      }
      setInviteOpen(false);
    } catch (error) {
      reportError("Mobile team invite failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveMember() {
    if (!editing || !memberForm.roleId) return;
    const commissionRate = parseRequiredNumber(memberForm.commissionRate);
    if (commissionRate === null || commissionRate < 0 || commissionRate > 100) {
      Alert.alert(locale === "ar" ? "نسبة غير صالحة" : "Invalid commission");
      return;
    }
    setSaving(true);
    try {
      if (memberForm.roleId !== editing.roleId) {
        await updateRole({ orgId, membershipId: editing._id, newRoleId: memberForm.roleId });
      }
      if (commissionRate !== (editing.commissionRate ?? 0)) {
        await updateCommissionRate({ orgId, membershipId: editing._id, commissionRate });
      }
      setEditing(null);
    } catch (error) {
      reportError("Mobile team member update failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة عضو" : "Add member"} onPress={openInvite} />
      </View>
      {results.length ? results.map((member: MobileMembership) => (
        <RecordCard key={member._id}>
          <Text style={styles.recordTitle}>{member.userName}</Text>
          <Text style={styles.recordMeta}>{member.userEmail}</Text>
          <Text style={styles.recordMeta}>{member.roleName} · {member.commissionRate}%</Text>
          <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openMember(member)} />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا يوجد أعضاء." : "No team members found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal
        title={locale === "ar" ? "إضافة عضو" : "Add member"}
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
      >
        <FormField keyboardType="email-address" label={locale === "ar" ? "البريد" : "Email"} value={inviteForm.email} onChangeText={(email) => setInviteForm((prev) => ({ ...prev, email }))} />
        <SelectField label={locale === "ar" ? "الدور" : "Role"} value={inviteForm.roleId} options={roleOptions} onChange={(roleId) => setInviteForm((prev) => ({ ...prev, roleId }))} />
        <SelectField
          label={locale === "ar" ? "الطريقة" : "Mode"}
          value={inviteForm.createDirectAccount}
          options={[
            { label: locale === "ar" ? "دعوة بالبريد" : "Email invite", value: "false" },
            { label: locale === "ar" ? "إنشاء حساب" : "Create account", value: "true" },
          ]}
          onChange={(createDirectAccount) => setInviteForm((prev) => ({ ...prev, createDirectAccount }))}
        />
        {inviteForm.createDirectAccount === "true" ? (
          <>
            <FormField label={locale === "ar" ? "الاسم الأول" : "First name"} value={inviteForm.firstName} onChangeText={(firstName) => setInviteForm((prev) => ({ ...prev, firstName }))} />
            <FormField label={locale === "ar" ? "اسم العائلة" : "Last name"} value={inviteForm.lastName} onChangeText={(lastName) => setInviteForm((prev) => ({ ...prev, lastName }))} />
          </>
        ) : null}
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={saveInvite} />
      </FormModal>
      <FormModal
        title={locale === "ar" ? "تعديل عضو" : "Edit member"}
        visible={Boolean(editing)}
        onClose={() => setEditing(null)}
      >
        <SelectField label={locale === "ar" ? "الدور" : "Role"} value={memberForm.roleId} options={roleOptions} onChange={(roleId) => setMemberForm((prev) => ({ ...prev, roleId }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "نسبة العمولة" : "Commission rate"} value={memberForm.commissionRate} onChangeText={(commissionRate) => setMemberForm((prev) => ({ ...prev, commissionRate }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={saveMember} />
      </FormModal>
    </ModuleScroll>
  );
}

function ApplicationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const { loadMore, results, status } = usePaginatedQuery(api.applications.list, { orgId }, { initialNumItems: PAGE_SIZE });
  return (
    <ModuleScroll>
      {results.length ? results.map((application: MobileFinanceApplication) => (
        <RecordCard key={application._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{application.customerName}</Text>
            <Text style={styles.statusPill}>{application.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{application.vehicleDesc}</Text>
          <Text style={styles.recordMeta}>{application.companyName} · {money(application.financedAmount, locale)} · {money(application.monthlyInstallment, locale)}</Text>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد طلبات تمويل." : "No finance applications found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
    </ModuleScroll>
  );
}

function ApprovalsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const approvals = useQuery(api.approvals.listPendingApprovals, { orgId });
  const respond = useMutation(api.approvals.respondToApproval);

  async function answer(request: MobileApprovalRequest, status: "APPROVED" | "REJECTED") {
    try {
      await respond({ orgId, requestId: request._id, status });
    } catch (error) {
      reportError("Mobile approval response failed", error);
    }
  }

  if (approvals === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      {approvals.length ? approvals.map((request) => (
        <RecordCard key={request._id}>
          <Text style={styles.recordTitle}>{request.vehicleMakeModel}</Text>
          <Text style={styles.recordMeta}>{request.vehicleVin} · {request.salespersonName}</Text>
          <Text style={styles.recordMeta}>{dateLabel(request.createdAt, locale)}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "قبول" : "Approve"} tone="muted" onPress={() => answer(request, "APPROVED")} />
            <PrimaryButton label={locale === "ar" ? "رفض" : "Reject"} tone="danger" onPress={() => answer(request, "REJECTED")} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد موافقات معلقة." : "No pending approvals."} />}
    </ModuleScroll>
  );
}

function CommissionsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const commissions = useQuery(api.sales.listCommissions, { orgId });
  const markPaid = useMutation(api.sales.markCommissionPaid);

  async function pay(sale: MobileSale) {
    try {
      await markPaid({ orgId, saleId: sale._id, paymentMethod: "CASH", idempotencyKey: idempotencyKey("sales.markCommissionPaid") });
    } catch (error) {
      reportError("Mobile commission pay failed", error);
    }
  }

  if (commissions === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      {commissions.length ? commissions.map((sale) => (
        <RecordCard key={sale._id}>
          <Text style={styles.recordTitle}>{sale.salespersonName}</Text>
          <Text style={styles.recordMeta}>{sale.vehicleSummary} · {sale.customerName}</Text>
          <Text style={styles.recordMeta}>{money(sale.commissionAmount, locale)} · {sale.commissionPaidAt ? dateLabel(sale.commissionPaidAt, locale) : (locale === "ar" ? "غير مدفوعة" : "Unpaid")}</Text>
          {!sale.commissionPaidAt ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل كمدفوعة" : "Mark paid"} tone="muted" onPress={() => pay(sale)} />
          ) : null}
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد عمولات." : "No commissions found."} />}
    </ModuleScroll>
  );
}

function NotificationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const unreadCount = useQuery(api.notifications.unreadCount, { orgId });
  const markRead = useMutation(api.notifications.markAsRead);
  const markAllRead = useMutation(api.notifications.markAllAsRead);
  const archive = useMutation(api.notifications.archive);
  const { loadMore, results, status } = usePaginatedQuery(
    api.notifications.listPage,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );

  async function act(context: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      reportError(context, error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <Text style={styles.sectionTitle}>
          {locale === "ar" ? "غير المقروء" : "Unread"}: {compactNumber(unreadCount ?? 0, locale)}
        </Text>
        <PrimaryButton
          label={locale === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}
          tone="muted"
          onPress={() => act("Mobile notifications mark all failed", () => markAllRead({ orgId }))}
        />
      </View>
      {results.length ? results.map((notification: MobileNotification) => (
        <RecordCard key={notification._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>
              {notification.title || notification.type || (locale === "ar" ? "إشعار" : "Notification")}
            </Text>
            <Text style={styles.statusPill}>{notification.isRead ? (locale === "ar" ? "مقروء" : "Read") : (locale === "ar" ? "جديد" : "New")}</Text>
          </View>
          <Text style={styles.recordMeta}>{notification.message || notification.category || "-"}</Text>
          <Text style={styles.recordMeta}>{notification.priority || "normal"}</Text>
          <View style={styles.cardActions}>
            {!notification.isRead ? (
              <PrimaryButton
                label={locale === "ar" ? "مقروء" : "Mark read"}
                tone="muted"
                onPress={() => act("Mobile notification mark read failed", () => markRead({ orgId, notificationId: notification._id }))}
              />
            ) : null}
            <PrimaryButton
              label={locale === "ar" ? "أرشفة" : "Archive"}
              tone="danger"
              onPress={() => act("Mobile notification archive failed", () => archive({ orgId, notificationId: notification._id }))}
            />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد إشعارات." : "No notifications found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
    </ModuleScroll>
  );
}

function MessagesModule({ orgId }: { orgId: string }) {
  const { locale, textDirection } = useLocale();
  const reportError = useGenericError();
  const me = useQuery(api.users.getMe, {});
  const conversations = useQuery(api.directMessages.listConversations, { orgId });
  const members = useQuery(api.directMessages.getOrgMembers, { orgId });
  const getOrCreateDm = useMutation(api.directMessages.getOrCreateDm);
  const createGroup = useMutation(api.directMessages.createGroup);
  const sendDirectMessage = useMutation(api.directMessages.sendMessage);
  const markDelivered = useMutation(api.directMessages.markDelivered);
  const markRead = useMutation(api.directMessages.markRead);
  const setTyping = useMutation(api.directMessages.setTyping);
  const setMuted = useMutation(api.directMessages.setMuted);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<"dm" | "group" | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedConversation = useQuery(
    api.directMessages.getConversation,
    selectedId ? { conversationId: selectedId } : "skip",
  );
  const {
    loadMore: loadMoreMessages,
    results: messages,
    status: messageStatus,
  } = usePaginatedQuery(
    api.directMessages.listMessages,
    selectedId ? { conversationId: selectedId } : "skip",
    { initialNumItems: 40 },
  );
  const safeConversations = conversations ?? [];
  const filteredConversations = safeConversations.filter((conversation) => {
    const title = directConversationTitle(conversation, me?._id, locale === "ar" ? "محادثة" : "Conversation");
    const preview = conversation.lastMessageBody ?? "";
    const query = search.trim().toLowerCase();
    return !query || `${title} ${preview}`.toLowerCase().includes(query);
  });
  const availableMembers = (members ?? []).filter((member) => {
    const query = memberSearch.trim().toLowerCase();
    return !query || `${member.name} ${member.email ?? ""} ${member.roleName ?? ""}`.toLowerCase().includes(query);
  });
  const activeConversation =
    selectedConversation ?? safeConversations.find((conversation) => conversation._id === selectedId) ?? null;
  const chronologicalMessages = [...messages].reverse();
  const typingNames = (activeConversation?.typingUsers ?? [])
    .filter((typingUser): typingUser is NonNullable<typeof typingUser> => Boolean(typingUser))
    .map((typingUser) => typingUser.name);

  useEffect(() => {
    if (!selectedId && safeConversations[0]) {
      setSelectedId(safeConversations[0]._id);
    }
  }, [safeConversations, selectedId]);

  useEffect(() => {
    if (!me || !conversations) return;
    for (const conversation of conversations) {
      if (
        conversation.lastMessageSenderId &&
        conversation.lastMessageSenderId !== me._id &&
        (conversation.lastDeliveredAt ?? 0) < conversation.lastMessageAt
      ) {
        markDelivered({ conversationId: conversation._id }).catch((error: unknown) => {
          console.error("Mobile message delivered update failed", error);
        });
      }
    }
  }, [conversations, markDelivered, me]);

  useEffect(() => {
    if (!selectedId) return;
    markRead({ conversationId: selectedId }).catch((error: unknown) => {
      console.error("Mobile message read update failed", error);
    });
  }, [markRead, selectedId, messages.length]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
      }
    };
  }, []);

  function resetComposer() {
    setComposerMode(null);
    setMemberSearch("");
    setGroupName("");
    setSelectedMemberIds([]);
  }

  function updateDraft(nextDraft: string) {
    setDraft(nextDraft);
    if (!selectedId) return;

    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }

    if (!nextDraft.trim()) {
      setTyping({ conversationId: selectedId, isTyping: false }).catch(() => null);
      return;
    }

    setTyping({ conversationId: selectedId, isTyping: true }).catch(() => null);
    typingTimerRef.current = setTimeout(() => {
      setTyping({ conversationId: selectedId, isTyping: false }).catch(() => null);
    }, 2500);
  }

  async function startDm(member: MobileDirectMember) {
    setSaving(true);
    try {
      const conversationId = await getOrCreateDm({ orgId, otherUserId: member._id });
      setSelectedId(conversationId);
      resetComposer();
    } catch (error) {
      reportError("Mobile message DM creation failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function startGroup() {
    if (!groupName.trim() || selectedMemberIds.length < 2) {
      Alert.alert(
        locale === "ar" ? "حقول مطلوبة" : "Required fields",
        locale === "ar" ? "أدخل اسم المجموعة واختر عضوين على الأقل." : "Enter a group name and choose at least two members.",
      );
      return;
    }

    setSaving(true);
    try {
      const conversationId = await createGroup({
        orgId,
        name: groupName.trim(),
        memberIds: selectedMemberIds,
      });
      setSelectedId(conversationId);
      resetComposer();
    } catch (error) {
      reportError("Mobile message group creation failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function sendMessage() {
    if (!selectedId || !draft.trim()) return;
    const body = draft.trim();
    setDraft("");
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }

    try {
      setTyping({ conversationId: selectedId, isTyping: false }).catch((error) => {
        console.error("Mobile typing status clear failed", error);
      });
      await sendDirectMessage({ conversationId: selectedId, body });
    } catch (error) {
      setDraft(body);
      reportError("Mobile direct message send failed", error);
    }
  }

  async function toggleMute(conversation: MobileDirectConversation) {
    try {
      await setMuted({ conversationId: conversation._id, isMuted: !conversation.isMuted });
    } catch (error) {
      reportError("Mobile message mute update failed", error);
    }
  }

  function toggleGroupMember(memberId: string) {
    setSelectedMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId],
    );
  }

  if (me === undefined || conversations === undefined || members === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <View style={[styles.messagesRoot, { direction: textDirection }]}>
      <View style={styles.messagesToolbar}>
        <SearchInput
          placeholder={locale === "ar" ? "بحث المحادثات" : "Search conversations"}
          value={search}
          onChangeText={setSearch}
        />
        <PrimaryButton label={locale === "ar" ? "رسالة" : "DM"} onPress={() => setComposerMode("dm")} />
        <PrimaryButton label={locale === "ar" ? "مجموعة" : "Group"} tone="muted" onPress={() => setComposerMode("group")} />
      </View>

      <View style={styles.messagesLayout}>
        <ScrollView style={styles.conversationList} contentContainerStyle={styles.conversationListContent}>
          {filteredConversations.length ? filteredConversations.map((conversation) => {
            const title = directConversationTitle(conversation, me?._id, locale === "ar" ? "محادثة" : "Conversation");
            const isActive = conversation._id === selectedId;
            return (
              <Pressable
                key={conversation._id}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                style={({ pressed }) => [
                  styles.conversationCard,
                  isActive && styles.conversationCardActive,
                  pressed && styles.pressed,
                ]}
                onPress={() => setSelectedId(conversation._id)}
              >
                <View style={styles.conversationAvatar}>
                  <Text style={styles.conversationAvatarText}>{compactInitials(title)}</Text>
                  {conversation.hasUnread ? <View style={styles.unreadDot} /> : null}
                </View>
                <View style={styles.conversationText}>
                  <View style={styles.recordHeader}>
                    <Text numberOfLines={1} style={styles.conversationTitle}>{title}</Text>
                    <Text style={styles.conversationTime}>{relativeTimeLabel(conversation.lastMessageAt, locale)}</Text>
                  </View>
                  <Text numberOfLines={2} style={[styles.conversationPreview, conversation.hasUnread && styles.conversationUnread]}>
                    {conversation.lastMessageBody || (locale === "ar" ? "لا توجد رسائل بعد" : "No messages yet")}
                  </Text>
                </View>
              </Pressable>
            );
          }) : (
            <EmptyList label={locale === "ar" ? "لا توجد محادثات بعد." : "No conversations yet."} />
          )}
        </ScrollView>

        <View style={styles.threadPanel}>
          {activeConversation ? (
            <>
              <View style={styles.threadHeader}>
                <View style={styles.conversationAvatar}>
                  <Text style={styles.conversationAvatarText}>
                    {compactInitials(directConversationTitle(activeConversation, me?._id, locale === "ar" ? "محادثة" : "Conversation"))}
                  </Text>
                </View>
                <View style={styles.headerText}>
                  <Text numberOfLines={1} style={styles.threadTitle}>
                    {directConversationTitle(activeConversation, me?._id, locale === "ar" ? "محادثة" : "Conversation")}
                  </Text>
                  <Text numberOfLines={1} style={styles.recordMeta}>
                    {activeConversation.type === "GROUP"
                      ? `${activeConversation.members.length} ${locale === "ar" ? "أعضاء" : "members"}`
                      : activeConversation.isMuted
                        ? (locale === "ar" ? "الإشعارات مكتومة" : "Notifications muted")
                        : (locale === "ar" ? "محادثة مباشرة" : "Direct message")}
                  </Text>
                </View>
                <PrimaryButton
                  label={activeConversation.isMuted ? (locale === "ar" ? "تفعيل" : "Unmute") : (locale === "ar" ? "كتم" : "Mute")}
                  tone="muted"
                  onPress={() => toggleMute(activeConversation)}
                />
              </View>

              <ScrollView style={styles.threadScroll} contentContainerStyle={styles.threadContent}>
                {canLoadMore(messageStatus) ? (
                  <PrimaryButton
                    label={locale === "ar" ? "رسائل أقدم" : "Older messages"}
                    tone="muted"
                    onPress={() => loadMoreMessages(40)}
                  />
                ) : null}
                {isPaginationLoading(messageStatus) ? (
                  <Text style={styles.mutedText}>{locale === "ar" ? "جاري التحميل..." : "Loading..."}</Text>
                ) : null}
                {chronologicalMessages.length ? chronologicalMessages.map((message: MobileDirectMessage) => {
                  const isMine = message.senderId === me?._id;
                  const statusLabel =
                    message.status === "seen"
                      ? locale === "ar" ? "مقروء" : "Seen"
                      : message.status === "delivered"
                        ? locale === "ar" ? "مستلم" : "Delivered"
                        : message.status === "sent"
                          ? locale === "ar" ? "مرسل" : "Sent"
                          : "";
                  return (
                    <View key={message._id} style={[styles.messageRow, isMine && styles.messageRowMine]}>
                      <View style={[styles.messageBubble, isMine ? styles.messageBubbleMine : styles.messageBubbleOther]}>
                        {!isMine && activeConversation.type === "GROUP" ? (
                          <Text style={styles.messageSender}>{message.senderName}</Text>
                        ) : null}
                        <Text style={[styles.messageBody, isMine && styles.messageBodyMine]}>{message.body}</Text>
                        <Text style={[styles.messageMeta, isMine && styles.messageMetaMine]}>
                          {relativeTimeLabel(message._creationTime, locale)}{statusLabel ? ` · ${statusLabel}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                }) : (
                  <EmptyList label={locale === "ar" ? "ابدأ المحادثة برسالة." : "Start the conversation with a message."} />
                )}
                {typingNames.length ? (
                  <Text style={styles.typingText}>
                    {typingNames.length === 1
                      ? `${typingNames[0]} ${locale === "ar" ? "يكتب..." : "is typing..."}`
                      : locale === "ar" ? "عدة أشخاص يكتبون..." : "Several people are typing..."}
                  </Text>
                ) : null}
              </ScrollView>

              <View style={styles.composerRow}>
                <TextInput
                  multiline
                  placeholder={locale === "ar" ? "اكتب رسالة..." : "Type a message..."}
                  placeholderTextColor={theme.colors.mutedText}
                  style={styles.composerInput}
                  value={draft}
                  onChangeText={updateDraft}
                />
                <PrimaryButton
                  disabled={!draft.trim()}
                  label={locale === "ar" ? "إرسال" : "Send"}
                  onPress={sendMessage}
                />
              </View>
            </>
          ) : (
            <EmptyList label={locale === "ar" ? "اختر محادثة أو ابدأ رسالة جديدة." : "Choose a conversation or start a new message."} />
          )}
        </View>
      </View>

      <FormModal
        title={
          composerMode === "group"
            ? (locale === "ar" ? "مجموعة جديدة" : "New group")
            : (locale === "ar" ? "رسالة جديدة" : "New message")
        }
        visible={Boolean(composerMode)}
        onClose={resetComposer}
      >
        {composerMode === "group" ? (
          <FormField
            label={locale === "ar" ? "اسم المجموعة" : "Group name"}
            value={groupName}
            onChangeText={setGroupName}
          />
        ) : null}
        <SearchInput
          placeholder={locale === "ar" ? "بحث أعضاء الفريق" : "Search team members"}
          value={memberSearch}
          onChangeText={setMemberSearch}
        />
        {availableMembers.length ? availableMembers.map((member) => {
          const selected = selectedMemberIds.includes(member._id);
          return (
            <Pressable
              key={member._id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.memberRow,
                selected && styles.memberRowSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => {
                if (composerMode === "dm") {
                  startDm(member);
                } else {
                  toggleGroupMember(member._id);
                }
              }}
            >
              <View style={styles.memberAvatar}>
                <Text style={styles.memberAvatarText}>{compactInitials(member.name)}</Text>
              </View>
              <View style={styles.headerText}>
                <Text numberOfLines={1} style={styles.recordTitle}>{member.name}</Text>
                <Text numberOfLines={1} style={styles.recordMeta}>{member.email ?? member.roleName ?? "-"}</Text>
              </View>
              <Text style={styles.statusPill}>
                {composerMode === "dm"
                  ? (locale === "ar" ? "فتح" : "Open")
                  : selected
                    ? (locale === "ar" ? "مختار" : "Selected")
                    : (locale === "ar" ? "اختيار" : "Select")}
              </Text>
            </Pressable>
          );
        }) : (
          <EmptyList label={locale === "ar" ? "لا يوجد أعضاء مطابقون." : "No matching team members."} />
        )}
        {composerMode === "group" ? (
          <PrimaryButton
            disabled={saving}
            label={saving ? (locale === "ar" ? "جاري الإنشاء..." : "Creating...") : (locale === "ar" ? "إنشاء المجموعة" : "Create group")}
            onPress={startGroup}
          />
        ) : null}
      </FormModal>
    </View>
  );
}

function AccountingModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const addTransaction = useMutation(api.transactions.add);
  const updateTransaction = useMutation(api.transactions.update);
  const removeTransaction = useMutation(api.transactions.remove);
  const { loadMore, results, status } = usePaginatedQuery(api.transactions.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileLedgerTransaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    type: "IN" as MobileLedgerType,
    amount: "",
    category: "OTHER" as MobileLedgerCategory,
    description: "",
  });
  const typeOptions: Array<Option<MobileLedgerType>> = [
    { label: locale === "ar" ? "داخل" : "In", value: "IN" },
    { label: locale === "ar" ? "خارج" : "Out", value: "OUT" },
  ];
  const categoryOptions: Array<Option<MobileLedgerCategory>> = [
    "VEHICLE_SALE",
    "VEHICLE_PURCHASE",
    "EXPENSE",
    "DEPOSIT",
    "COLLECTION_PAYMENT",
    "REFUND",
    "PARTNER_DRAW",
    "CAPITAL_INJECTION",
    "CLAIM_PAYMENT",
    "OTHER",
  ].map((value) => ({ label: value, value: value as MobileLedgerCategory }));

  function openCreate() {
    setEditing(null);
    setForm({ type: "IN", amount: "", category: "OTHER", description: "" });
    setOpen(true);
  }

  function openEdit(transaction: MobileLedgerTransaction) {
    setEditing(transaction);
    setForm({
      type: transaction.type,
      amount: String(transaction.amount),
      category: transaction.category,
      description: transaction.description,
    });
    setOpen(true);
  }

  async function save() {
    const amount = parseRequiredPositiveNumber(form.amount);
    if (amount === null || !form.description.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateTransaction({
          orgId,
          transactionId: editing._id,
          type: form.type,
          amount,
          category: form.category,
          description: form.description,
          date: editing.date,
        });
      } else {
        await addTransaction({
          orgId,
          type: form.type,
          amount,
          category: form.category,
          description: form.description,
          date: Date.now(),
          idempotencyKey: idempotencyKey("transactions.add"),
        });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile accounting save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: MobileLedgerTransaction) {
    try {
      await removeTransaction({ orgId, transactionId: row._id });
    } catch (error) {
      reportError("Mobile accounting delete failed", error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة قيد" : "Add entry"} onPress={openCreate} />
      </View>
      {results.length ? results.map((transaction: MobileLedgerTransaction) => (
        <RecordCard key={transaction._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{transaction.description}</Text>
            <Text style={styles.statusPill}>{transaction.type}</Text>
          </View>
          <Text style={styles.recordMeta}>{transaction.category} · {dateLabel(transaction.date, locale)}</Text>
          <Text style={styles.recordMeta}>{money(transaction.amount, locale)} · {transaction.vehicleLabel || transaction.customerName || "-"}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(transaction)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => remove(transaction)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد قيود." : "No ledger entries found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal
        title={editing ? (locale === "ar" ? "تعديل قيد" : "Edit entry") : (locale === "ar" ? "قيد جديد" : "New entry")}
        visible={open}
        onClose={() => {
          setEditing(null);
          setOpen(false);
        }}
      >
        <SegmentedControl options={typeOptions} value={form.type} onChange={(type) => setForm((prev) => ({ ...prev, type }))} />
        <SelectField label={locale === "ar" ? "التصنيف" : "Category"} value={form.category} options={categoryOptions} onChange={(category) => setForm((prev) => ({ ...prev, category: category as MobileLedgerCategory }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "المبلغ" : "Amount"} value={form.amount} onChangeText={(amount) => setForm((prev) => ({ ...prev, amount }))} />
        <FormField multiline label={locale === "ar" ? "البيان" : "Description"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function SourcingModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const markPaid = useMutation(api.sourcingPayables.markPaid);
  const [statusFilter, setStatusFilter] = useState<MobileSupplierPayableStatus | "ALL">("PENDING");
  const payables = useQuery(
    api.sourcingPayables.list,
    statusFilter === "ALL" ? { orgId } : { orgId, status: statusFilter },
  );
  const [selected, setSelected] = useState<MobileSupplierPayable | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ notes: "", taxAmount: "" });
  const statusOptions: Array<Option<MobileSupplierPayableStatus | "ALL">> = [
    { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
    { label: "PENDING", value: "PENDING" },
    { label: "PAID", value: "PAID" },
    { label: "CANCELLED", value: "CANCELLED" },
  ];

  function openPay(payable: MobileSupplierPayable) {
    setSelected(payable);
    setForm({
      notes: payable.paymentNotes ?? "",
      taxAmount: payable.taxAmount != null ? String(payable.taxAmount) : "",
    });
  }

  async function savePaid() {
    if (!selected) return;
    setSaving(true);
    try {
      await markPaid({
        orgId,
        payableId: selected._id,
        paymentMethod: "CASH",
        paymentNotes: maybeText(form.notes),
        taxAmount: parseOptionalNumber(form.taxAmount),
        idempotencyKey: idempotencyKey("sourcingPayables.markPaid"),
      });
      setSelected(null);
    } catch (error) {
      reportError("Mobile sourcing payable mark paid failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (payables === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SegmentedControl options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
      {payables.length ? payables.map((payable) => (
        <RecordCard key={payable._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{payable.sourcedFromName}</Text>
            <Text style={styles.statusPill}>{payable.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{payable.vehicleDesc} · {payable.vehicleVin || "-"}</Text>
          <Text style={styles.recordMeta}>{money(payable.amountDue, locale)} · {payable.customerName || "-"}</Text>
          {payable.status === "PENDING" ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل الدفع" : "Mark paid"} tone="muted" onPress={() => openPay(payable)} />
          ) : null}
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مستحقات." : "No sourcing payables found."} />}
      <FormModal
        title={locale === "ar" ? "تسجيل دفع المورد" : "Mark supplier paid"}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        <FormField keyboardType="numeric" label={locale === "ar" ? "ضريبة" : "Tax amount"} value={form.taxAmount} onChangeText={(taxAmount) => setForm((prev) => ({ ...prev, taxAmount }))} />
        <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={savePaid} />
      </FormModal>
    </ModuleScroll>
  );
}

function FinanceCompaniesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const companies = useQuery(api.finance.listCompanies, { orgId });
  const createCompany = useMutation(api.finance.createCompany);
  const updateCompany = useMutation(api.finance.updateCompany);
  const deleteCompany = useMutation(api.finance.deleteCompany);
  const [editing, setEditing] = useState<MobileFinanceCompany | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    profitRate: "",
    maxTermMonths: "60",
    gracePeriodMonths: "0",
    insuranceRate: "",
    adminFees: "",
    commission: "",
    maxFinancingLTV: "",
    isActive: "true",
    includesCommissionInDebt: "false",
  });

  function fill(company: MobileFinanceCompany | null) {
    setEditing(company);
    setForm({
      name: company?.name ?? "",
      profitRate: company ? String(company.profitRate) : "",
      maxTermMonths: company ? String(company.maxTermMonths) : "60",
      gracePeriodMonths: company ? String(company.gracePeriodMonths) : "0",
      insuranceRate: company?.insuranceRate != null ? String(company.insuranceRate) : "",
      adminFees: company?.adminFees != null ? String(company.adminFees) : "",
      commission: company?.commission != null ? String(company.commission) : "",
      maxFinancingLTV: company?.maxFinancingLTV != null ? String(company.maxFinancingLTV) : "",
      isActive: company?.isActive === false ? "false" : "true",
      includesCommissionInDebt: company?.includesCommissionInDebt ? "true" : "false",
    });
    setOpen(true);
  }

  async function save() {
    const profitRate = parseRequiredNumber(form.profitRate);
    const maxTermMonths = parseRequiredPositiveNumber(form.maxTermMonths);
    const gracePeriodMonths = parseRequiredNumber(form.gracePeriodMonths);
    if (!form.name.trim() || profitRate === null || maxTermMonths === null || gracePeriodMonths === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    const payload = {
      orgId,
      name: form.name,
      profitRate,
      maxTermMonths,
      gracePeriodMonths,
      insuranceRate: parseOptionalNumber(form.insuranceRate),
      adminFees: parseOptionalNumber(form.adminFees),
      commission: parseOptionalNumber(form.commission),
      maxFinancingLTV: parseOptionalNumber(form.maxFinancingLTV),
      includesCommissionInDebt: form.includesCommissionInDebt === "true",
      isActive: form.isActive === "true",
    };
    try {
      if (editing) {
        await updateCompany({ ...payload, id: editing._id });
      } else {
        await createCompany(payload);
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile finance company save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(company: MobileFinanceCompany) {
    try {
      await deleteCompany({ orgId, id: company._id });
    } catch (error) {
      reportError("Mobile finance company deactivate failed", error);
    }
  }

  if (companies === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة شركة" : "Add company"} onPress={() => fill(null)} />
      </View>
      {companies.length ? companies.map((company) => (
        <RecordCard key={company._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{company.name}</Text>
            <Text style={styles.statusPill}>{company.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{company.profitRate}% · {company.maxTermMonths}m · LTV {company.maxFinancingLTV ?? "-"}</Text>
          <Text style={styles.recordMeta}>{locale === "ar" ? "رسوم" : "Fees"} {money(company.adminFees, locale)} · {locale === "ar" ? "عمولة" : "Commission"} {money(company.commission, locale)}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => fill(company)} />
            {company.isActive ? <PrimaryButton label={locale === "ar" ? "تعطيل" : "Deactivate"} tone="danger" onPress={() => deactivate(company)} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد شركات تمويل." : "No finance companies found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل شركة" : "Edit company") : (locale === "ar" ? "شركة جديدة" : "New company")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "نسبة الربح" : "Profit rate"} value={form.profitRate} onChangeText={(profitRate) => setForm((prev) => ({ ...prev, profitRate }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "أقصى مدة" : "Max term months"} value={form.maxTermMonths} onChangeText={(maxTermMonths) => setForm((prev) => ({ ...prev, maxTermMonths }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "فترة السماح" : "Grace months"} value={form.gracePeriodMonths} onChangeText={(gracePeriodMonths) => setForm((prev) => ({ ...prev, gracePeriodMonths }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "تأمين %" : "Insurance rate"} value={form.insuranceRate} onChangeText={(insuranceRate) => setForm((prev) => ({ ...prev, insuranceRate }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "رسوم إدارية" : "Admin fees"} value={form.adminFees} onChangeText={(adminFees) => setForm((prev) => ({ ...prev, adminFees }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "عمولة" : "Commission"} value={form.commission} onChangeText={(commission) => setForm((prev) => ({ ...prev, commission }))} />
        <FormField keyboardType="numeric" label="LTV" value={form.maxFinancingLTV} onChangeText={(maxFinancingLTV) => setForm((prev) => ({ ...prev, maxFinancingLTV }))} />
        <SelectField label={locale === "ar" ? "فعال" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function BranchesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const branches = useQuery(api.branches.list, { orgId });
  const members = usePaginatedQuery(api.memberships.list, { orgId }, { initialNumItems: SELECTOR_PAGE_SIZE });
  const addBranch = useMutation(api.branches.add);
  const updateBranch = useMutation(api.branches.update);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileBranch | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", phone: "", additionalPhones: "", managerId: "", isActive: "true" });
  const managerOptions = [
    { label: locale === "ar" ? "بدون مدير" : "Unassigned", value: "" },
    ...members.results.map((member) => ({ label: member.userName, value: member.userId })),
  ];

  function openForm(branch: MobileBranch | null) {
    setEditing(branch);
    setForm({
      name: branch?.name ?? "",
      address: branch?.address ?? "",
      phone: branch?.phone ?? "",
      additionalPhones: joinList(branch?.additionalPhones),
      managerId: branch?.managerId ?? "",
      isActive: branch?.isActive === false ? "false" : "true",
    });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      Alert.alert(locale === "ar" ? "الاسم مطلوب" : "Name required");
      return;
    }
    const payload = {
      orgId,
      name: form.name,
      address: maybeText(form.address),
      phone: maybeText(form.phone),
      additionalPhones: splitLinesOrCommas(form.additionalPhones),
      managerId: maybeText(form.managerId),
      isActive: form.isActive === "true",
    };
    setSaving(true);
    try {
      if (editing) {
        await updateBranch({ ...payload, id: editing._id });
      } else {
        await addBranch(payload);
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile branch save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (branches === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة فرع" : "Add branch"} onPress={() => openForm(null)} />
      </View>
      {branches.length ? branches.map((branch) => (
        <RecordCard key={branch._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{branch.name}</Text>
            <Text style={styles.statusPill}>{branch.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{branch.address || "-"}</Text>
          <Text style={styles.recordMeta}>{branch.phone || "-"} · {branch.managerName}</Text>
          <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openForm(branch)} />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد فروع." : "No branches found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل فرع" : "Edit branch") : (locale === "ar" ? "فرع جديد" : "New branch")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.address} onChangeText={(address) => setForm((prev) => ({ ...prev, address }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.phone} onChangeText={(phone) => setForm((prev) => ({ ...prev, phone }))} />
        <FormField multiline label={locale === "ar" ? "هواتف إضافية" : "Additional phones"} value={form.additionalPhones} onChangeText={(additionalPhones) => setForm((prev) => ({ ...prev, additionalPhones }))} />
        <SelectField label={locale === "ar" ? "المدير" : "Manager"} value={form.managerId} options={managerOptions} onChange={(managerId) => setForm((prev) => ({ ...prev, managerId }))} />
        <SelectField label={locale === "ar" ? "فعال" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function RolesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const roles = useQuery(api.roles.list, { orgId });
  const createRole = useMutation(api.roles.create);
  const updateRole = useMutation(api.roles.update);
  const removeRole = useMutation(api.roles.remove);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", permissions: "" });

  function openForm(role: MobileRole | null) {
    setEditing(role);
    setForm({ name: role?.name ?? "", permissions: joinList(role?.permissions) });
    setOpen(true);
  }

  async function save() {
    const permissions = splitLinesOrCommas(form.permissions);
    if (!form.name.trim() || permissions.length === 0) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateRole({ orgId, roleId: editing._id, name: form.name, permissions });
      } else {
        await createRole({ orgId, name: form.name, permissions });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile role save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(role: MobileRole) {
    try {
      await removeRole({ orgId, roleId: role._id });
    } catch (error) {
      reportError("Mobile role delete failed", error);
    }
  }

  if (roles === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة دور" : "Add role"} onPress={() => openForm(null)} />
      </View>
      {roles.length ? roles.map((role) => (
        <RecordCard key={role._id}>
          <Text style={styles.recordTitle}>{role.name}</Text>
          <Text style={styles.recordMeta}>{role.permissions.length} {locale === "ar" ? "صلاحية" : "permissions"}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openForm(role)} />
            {role.name !== "OWNER" ? <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => remove(role)} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد أدوار." : "No roles found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل دور" : "Edit role") : (locale === "ar" ? "دور جديد" : "New role")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <FormField multiline label={locale === "ar" ? "الصلاحيات، كل سطر صلاحية" : "Permissions, one per line"} value={form.permissions} onChangeText={(permissions) => setForm((prev) => ({ ...prev, permissions }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function QuotesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const saveQuote = useMutation(api.quotes.saveQuote);
  const updateQuoteStatus = useMutation(api.quotes.updateQuoteStatus);
  const customers = usePaginatedQuery(api.customers.list, { orgId }, { initialNumItems: SELECTOR_PAGE_SIZE });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const companies = useQuery(api.finance.listCompanies, { orgId });
  const customerOptions = customers.results.map((customer) => ({ label: `${customer.firstName} ${customer.lastName}`, value: customer._id }));
  const vehicleOptions = (vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id }));
  const companyOptions = [
    { label: locale === "ar" ? "بدون شركة" : "No company", value: "" },
    ...(companies ?? []).filter((company) => company.isActive).map((company) => ({ label: company.name, value: company._id })),
  ];
  const [customerId, setCustomerId] = useState("");
  const quotes = useQuery(api.quotes.listQuotesByCustomer, customerId ? { orgId, customerId } : "skip");
  const [open, setOpen] = useState(false);
  const [quoteStep, setQuoteStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    companyId: "",
    mode: "CASH" as MobileQuoteMode,
    vehiclePrice: "",
    downPayment: "0",
    termMonths: "60",
    monthlyInstallment: "",
    recipientName: "",
  });
  const quoteStatusOptions: MobileQuoteStatus[] = ["DRAFT", "SHARED", "ACCEPTED", "EXPIRED"];
  const quoteModeOptions: Array<Option<MobileQuoteMode>> = [
    { label: "CASH", value: "CASH" },
    { label: "CONFIGURED", value: "CONFIGURED_FINANCE_COMPANY" },
    { label: "MANUAL", value: "MANUAL_FINANCE_COMPANY" },
    { label: "INSTALLMENT", value: "INTERNAL_INSTALLMENT" },
    { label: "LEASE", value: "LEASE" },
  ];
  const selectedQuoteCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedQuoteVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedCompanyLabel = getOptionLabel(companyOptions, form.companyId, locale === "ar" ? "بدون شركة" : "No company");
  const vehiclePricePreview = parseOptionalNumber(form.vehiclePrice) ?? 0;
  const quoteDownPaymentPreview = parseOptionalNumber(form.downPayment) ?? 0;
  const termMonthsPreview = parseOptionalNumber(form.termMonths) ?? 0;
  const monthlyPreview = parseOptionalNumber(form.monthlyInstallment)
    ?? (termMonthsPreview > 0 ? Math.max(0, vehiclePricePreview - quoteDownPaymentPreview) / termMonthsPreview : 0);
  const quoteSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "ابدأ باختيار العميل والسيارة." : "Start with the buyer and inventory item.",
    },
    {
      title: locale === "ar" ? "خطة العرض" : "Quote plan",
      subtitle: locale === "ar" ? "حدد النقد أو التمويل والأرقام الأساسية." : "Choose cash or finance and the core numbers.",
    },
    {
      title: locale === "ar" ? "المراجعة والإرسال" : "Review and save",
      subtitle: locale === "ar" ? "راجع العرض قبل حفظه." : "Check the quote before saving it.",
    },
  ];

  function openCreate() {
    setQuoteStep(0);
    setForm({
      customerId: customerId || customerOptions[0]?.value || "",
      vehicleId: vehicleOptions[0]?.value || "",
      companyId: "",
      mode: "CASH",
      vehiclePrice: "",
      downPayment: "0",
      termMonths: "60",
      monthlyInstallment: "",
      recipientName: "",
    });
    setOpen(true);
  }

  function closeQuoteForm() {
    setQuoteStep(0);
    setOpen(false);
  }

  function chooseQuoteVehicle(vehicleId: string) {
    const selectedVehicle = (vehicles ?? []).find((vehicle) => vehicle._id === vehicleId);
    setForm((prev) => ({
      ...prev,
      vehicleId,
      vehiclePrice: prev.vehiclePrice || (selectedVehicle ? String(selectedVehicle.sellingPrice) : prev.vehiclePrice),
    }));
  }

  async function save() {
    const vehiclePrice = parseRequiredPositiveNumber(form.vehiclePrice);
    const downPayment = parseRequiredNumber(form.downPayment);
    const termMonths = parseRequiredPositiveNumber(form.termMonths);
    if (!form.customerId || !form.vehicleId || vehiclePrice === null || downPayment === null || termMonths === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await saveQuote({
        orgId,
        customerId: form.customerId,
        vehicleId: form.vehicleId,
        companyId: form.mode === "CONFIGURED_FINANCE_COMPANY" ? maybeText(form.companyId) : undefined,
        mode: form.mode,
        vehiclePrice,
        downPayment,
        termMonths,
        monthlyInstallment: parseOptionalNumber(form.monthlyInstallment),
        recipientName: maybeText(form.recipientName),
      });
      setCustomerId(form.customerId);
      closeQuoteForm();
    } catch (error) {
      reportError("Mobile quote save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(quote: MobileQuote, status: MobileQuoteStatus) {
    try {
      await updateQuoteStatus({ orgId, quoteId: quote._id, status });
    } catch (error) {
      reportError("Mobile quote status failed", error);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={customerId} options={customerOptions} onChange={setCustomerId} />
        <PrimaryButton label={locale === "ar" ? "عرض جديد" : "New quote"} onPress={openCreate} />
      </View>
      {!customerId ? <EmptyList label={locale === "ar" ? "اختر عميل لعرض العروض." : "Choose a customer to view quotes."} /> : null}
      {quotes === undefined && customerId ? <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} /> : null}
      {quotes?.length ? quotes.map((quote) => (
        <RecordCard key={quote._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{money(quote.vehiclePrice, locale)}</Text>
            <Text style={styles.statusPill}>{quote.status}</Text>
          </View>
          <View style={styles.detailPillRow}>
            <DetailPill label={quote.mode || "CASH"} tone="info" />
            <DetailPill label={`${quote.termMonths}m`} />
            <DetailPill label={money(quote.monthlyInstallment, locale)} tone="success" />
          </View>
          <Text style={styles.recordMeta}>{dateLabel(quote.createdAt, locale)}</Text>
          <View style={styles.cardActions}>
            {quoteStatusOptions.map((statusOption) => (
              <PrimaryButton key={statusOption} label={statusOption} tone="muted" onPress={() => setStatus(quote, statusOption)} />
            ))}
          </View>
        </RecordCard>
      )) : customerId && quotes ? <EmptyList label={locale === "ar" ? "لا توجد عروض لهذا العميل." : "No quotes for this customer."} /> : null}
      <FormModal title={locale === "ar" ? "عرض جديد" : "New quote"} visible={open} onClose={closeQuoteForm}>
        <GuidedStepFlow activeIndex={quoteStep} steps={quoteSteps}>
          {quoteStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerIdValue) => setForm((prev) => ({ ...prev, customerId: customerIdValue }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={chooseQuoteVehicle} />
              <SummaryPanel title={locale === "ar" ? "نطاق العرض" : "Quote scope"}>
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedQuoteCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedQuoteVehicleLabel} />
              </SummaryPanel>
            </>
          ) : null}
          {quoteStep === 1 ? (
            <>
              <SegmentedControl options={quoteModeOptions} value={form.mode} onChange={(mode) => setForm((prev) => ({ ...prev, mode }))} />
              {form.mode === "CONFIGURED_FINANCE_COMPANY" ? <SelectField label={locale === "ar" ? "شركة التمويل" : "Finance company"} value={form.companyId} options={companyOptions} onChange={(companyId) => setForm((prev) => ({ ...prev, companyId }))} /> : null}
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر السيارة" : "Vehicle price"} value={form.vehiclePrice} onChangeText={(vehiclePrice) => setForm((prev) => ({ ...prev, vehiclePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "دفعة أولى" : "Down payment"} value={form.downPayment} onChangeText={(downPayment) => setForm((prev) => ({ ...prev, downPayment }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "الأشهر" : "Term months"} value={form.termMonths} onChangeText={(termMonths) => setForm((prev) => ({ ...prev, termMonths }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "القسط الشهري" : "Monthly installment"} value={form.monthlyInstallment} onChangeText={(monthlyInstallment) => setForm((prev) => ({ ...prev, monthlyInstallment }))} />
              <View style={styles.metricGrid}>
                <MetricCard title={locale === "ar" ? "القيمة" : "Price"} value={money(vehiclePricePreview, locale)} caption={locale === "ar" ? "سعر السيارة" : "vehicle price"} />
                <MetricCard title={locale === "ar" ? "القسط" : "Monthly"} value={money(monthlyPreview, locale)} caption={locale === "ar" ? "تقديري" : "estimated"} />
              </View>
            </>
          ) : null}
          {quoteStep === 2 ? (
            <>
              <FormField label={locale === "ar" ? "اسم المستلم" : "Recipient"} value={form.recipientName} onChangeText={(recipientName) => setForm((prev) => ({ ...prev, recipientName }))} />
              <SummaryPanel
                title={locale === "ar" ? "مراجعة العرض" : "Quote review"}
                subtitle={locale === "ar" ? "ملخص قابل للمشاركة مع العميل." : "A customer-ready summary before saving."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedQuoteCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedQuoteVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "النمط" : "Mode"} value={form.mode} />
                <SummaryRow label={locale === "ar" ? "شركة التمويل" : "Finance company"} value={selectedCompanyLabel} />
                <SummaryRow label={locale === "ar" ? "القيمة" : "Price"} value={money(vehiclePricePreview, locale)} />
                <SummaryRow label={locale === "ar" ? "القسط" : "Monthly"} value={money(monthlyPreview, locale)} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={quoteStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ العرض" : "Save quote")}
            saving={saving}
            totalSteps={quoteSteps.length}
            onBack={() => setQuoteStep((step) => Math.max(0, step - 1))}
            onNext={() => setQuoteStep((step) => Math.min(quoteSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
    </ModuleScroll>
  );
}

function SocialInboxModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const replyInstagramComment = useAction(api.instagramEngagement.replyToInstagramComment);
  const sendInstagramDm = useAction(api.instagramEngagement.sendInstagramDirectMessage);
  const replyFacebookComment = useAction(api.facebookEngagement.replyToFacebookComment);
  const sendFacebookDm = useAction(api.facebookEngagement.sendFacebookDirectMessage);
  const linkVehicle = useMutation(api.socialInbox.setConversationVehicle);
  const stats = useQuery(api.socialInbox.platformStats, { orgId });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, includeReserved: true });
  const [platformFilter, setPlatformFilter] = useState<MobileSocialPlatform | "ALL">("ALL");
  const [needsReplyOnly, setNeedsReplyOnly] = useState<"ALL" | "NEEDS">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.socialInbox.listConversations,
    {
      orgId,
      platform: platformFilter === "ALL" ? undefined : platformFilter,
      needsReply: needsReplyOnly === "NEEDS" ? true : undefined,
    },
    { initialNumItems: PAGE_SIZE },
  );
  const [selected, setSelected] = useState<MobileSocialConversation | null>(null);
  const [replyText, setReplyText] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [saving, setSaving] = useState(false);
  const events = useQuery(
    api.socialInbox.listEventsForConversation,
    selected
      ? {
          orgId,
          customerId: selected.customerId,
          platform: selected.platform,
          conversationKind: selected.conversationKind,
          conversationPostId: selected.conversationPostId ?? undefined,
        }
      : "skip",
  );
  const vehicleOptions = [
    { label: locale === "ar" ? "اختر سيارة" : "Select vehicle", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id })),
  ];
  const platformOptions: Array<Option<MobileSocialPlatform | "ALL">> = [
    { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
    { label: "Instagram", value: "instagram" },
    { label: "Facebook", value: "facebook" },
  ];

  function openConversation(conversation: MobileSocialConversation) {
    setSelected(conversation);
    setReplyText("");
    setVehicleId("");
  }

  function eventNeedsReply(event: MobileSocialConversationEvent): boolean {
    return !event.autoRepliedAt && !event.manualRepliedAt;
  }

  async function sendReply() {
    if (!selected || !replyText.trim()) return;
    const event = [...(events ?? [])].reverse().find(eventNeedsReply) ?? events?.at(-1);
    setSaving(true);
    try {
      if (selected.platform === "instagram") {
        if (selected.conversationKind === "comment" && event?._id) {
          await replyInstagramComment({ orgId, instagramEventId: event._id, message: replyText });
        } else {
          await sendInstagramDm({ orgId, customerId: selected.customerId, message: replyText });
        }
      } else if (selected.conversationKind === "comment" && event?._id) {
        await replyFacebookComment({ orgId, facebookEventId: event._id, message: replyText });
      } else {
        await sendFacebookDm({ orgId, customerId: selected.customerId, message: replyText });
      }
      setReplyText("");
    } catch (error) {
      reportError("Mobile social reply failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveVehicleLink() {
    if (!selected || !vehicleId) return;
    setSaving(true);
    try {
      await linkVehicle({
        orgId,
        customerId: selected.customerId,
        vehicleId,
        platform: selected.platform,
        conversationKind: selected.conversationKind,
        conversationPostId: selected.conversationPostId ?? undefined,
      });
      setVehicleId("");
    } catch (error) {
      reportError("Mobile social vehicle link failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModuleScroll>
      <View style={styles.metricGrid}>
        <MetricCard title="Instagram" value={compactNumber(stats?.instagram.total ?? 0, locale)} caption={`${stats?.instagram.comments ?? 0} comments · ${stats?.instagram.dms ?? 0} DM`} />
        <MetricCard title="Facebook" value={compactNumber(stats?.facebook.total ?? 0, locale)} caption={`${stats?.facebook.comments ?? 0} comments · ${stats?.facebook.dms ?? 0} DM`} />
      </View>
      <SegmentedControl options={platformOptions} value={platformFilter} onChange={setPlatformFilter} />
      <SegmentedControl
        options={[
          { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
          { label: locale === "ar" ? "بحاجة رد" : "Needs reply", value: "NEEDS" },
        ]}
        value={needsReplyOnly}
        onChange={setNeedsReplyOnly}
      />
      {results.length ? results.map((conversation: MobileSocialConversation) => (
        <RecordCard key={`${conversation.platform}-${conversation.customerId}-${conversation.conversationKind}-${conversation.conversationPostId ?? "dm"}`}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{conversation.senderDisplayName}</Text>
            <Text style={styles.statusPill}>{conversation.needsReply ? (locale === "ar" ? "رد" : "Reply") : conversation.platform}</Text>
          </View>
          <Text style={styles.recordMeta}>{conversation.latestText || "-"}</Text>
          <Text style={styles.recordMeta}>{conversation.vehicleSummary || (locale === "ar" ? "بدون سيارة" : "No vehicle")} · {conversation.eventCount}</Text>
          <PrimaryButton label={locale === "ar" ? "فتح" : "Open"} tone="muted" onPress={() => openConversation(conversation)} />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد محادثات." : "No conversations found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal
        title={selected ? selected.senderDisplayName : (locale === "ar" ? "محادثة" : "Conversation")}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        {events === undefined ? <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} /> : null}
        {(events ?? []).map((event) => (
          <RecordCard key={event._id}>
            <Text style={styles.recordTitle}>{event.senderDisplayName}</Text>
            <Text style={styles.recordMeta}>{event.text || "-"}</Text>
            {event.autoReplyText ? <Text style={styles.warningText}>{locale === "ar" ? "رد تلقائي: " : "Auto: "}{event.autoReplyText}</Text> : null}
            {event.manualReplyText ? <Text style={styles.warningText}>{locale === "ar" ? "رد يدوي: " : "Manual: "}{event.manualReplyText}</Text> : null}
            <Text style={styles.recordMeta}>{dateLabel(event._creationTime, locale)} · {event.vehicleSummary || "-"}</Text>
          </RecordCard>
        ))}
        <SelectField label={locale === "ar" ? "ربط سيارة" : "Link vehicle"} value={vehicleId} options={vehicleOptions} onChange={setVehicleId} />
        <PrimaryButton disabled={saving || !vehicleId} label={locale === "ar" ? "ربط" : "Link"} tone="muted" onPress={saveVehicleLink} />
        <FormField multiline label={locale === "ar" ? "رد" : "Reply"} value={replyText} onChangeText={setReplyText} />
        <PrimaryButton disabled={saving || !replyText.trim()} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Sending...") : (locale === "ar" ? "إرسال" : "Send")} onPress={sendReply} />
      </FormModal>
    </ModuleScroll>
  );
}

function PipelineSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const stages = useQuery(api.orgPipelineStages.list, { orgId });
  const seedStages = useMutation(api.orgPipelineStages.seed);
  const updateStage = useMutation(api.orgPipelineStages.update);
  const reorderStages = useMutation(api.orgPipelineStages.reorder);
  const [editing, setEditing] = useState<MobilePipelineStage | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ label: "", color: "#0f766e", isActive: "true" });

  function openEdit(stage: MobilePipelineStage) {
    setEditing(stage);
    setForm({
      label: stage.label,
      color: stage.color,
      isActive: stage.isActive ? "true" : "false",
    });
  }

  async function save() {
    if (!editing || !form.label.trim()) return;
    setSaving(true);
    try {
      await updateStage({
        orgId,
        stageId: editing._id,
        label: form.label.trim(),
        color: form.color.trim() || editing.color,
        isActive: form.isActive === "true",
      });
      setEditing(null);
    } catch (error) {
      reportError("Mobile pipeline stage save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function seed() {
    try {
      await seedStages({ orgId });
    } catch (error) {
      reportError("Mobile pipeline seed failed", error);
    }
  }

  async function move(stage: MobilePipelineStage, direction: -1 | 1) {
    if (!stages) return;
    const currentIndex = stages.findIndex((item) => item._id === stage._id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= stages.length) return;
    const ordered = [...stages];
    const [removed] = ordered.splice(currentIndex, 1);
    ordered.splice(nextIndex, 0, removed);
    try {
      await reorderStages({ orgId, orderedIds: ordered.map((item) => item._id) });
    } catch (error) {
      reportError("Mobile pipeline reorder failed", error);
    }
  }

  if (stages === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <PrimaryButton label={locale === "ar" ? "تهيئة المراحل الافتراضية" : "Seed default stages"} onPress={seed} />
      {stages.length ? stages.map((stage) => (
        <RecordCard key={stage._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{stage.label}</Text>
            <Text style={[styles.statusPill, { backgroundColor: stage.color }]}>{stage.stageKey}</Text>
          </View>
          <Text style={styles.recordMeta}>
            {locale === "ar" ? "الترتيب" : "Order"} {stage.order + 1} · {stage.isActive ? (locale === "ar" ? "نشط" : "Active") : (locale === "ar" ? "متوقف" : "Inactive")}
          </Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(stage)} />
            <PrimaryButton label={locale === "ar" ? "أعلى" : "Up"} tone="muted" onPress={() => move(stage, -1)} />
            <PrimaryButton label={locale === "ar" ? "أسفل" : "Down"} tone="muted" onPress={() => move(stage, 1)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لم تتم تهيئة المراحل بعد." : "No stages configured yet."} />}
      <FormModal title={locale === "ar" ? "تعديل المرحلة" : "Edit stage"} visible={Boolean(editing)} onClose={() => setEditing(null)}>
        <FormField label={locale === "ar" ? "الاسم" : "Label"} value={form.label} onChangeText={(label) => setForm((prev) => ({ ...prev, label }))} />
        <FormField label={locale === "ar" ? "اللون" : "Color"} value={form.color} onChangeText={(color) => setForm((prev) => ({ ...prev, color }))} />
        <SelectField
          label={locale === "ar" ? "الحالة" : "Status"}
          value={form.isActive}
          options={[{ label: locale === "ar" ? "نشط" : "Active", value: "true" }, { label: locale === "ar" ? "متوقف" : "Inactive", value: "false" }]}
          onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))}
        />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function LeadSourcesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const sources = useQuery(api.orgLeadSources.list, { orgId });
  const seedSources = useMutation(api.orgLeadSources.seed);
  const createSource = useMutation(api.orgLeadSources.create);
  const updateSource = useMutation(api.orgLeadSources.update);
  const removeSource = useMutation(api.orgLeadSources.remove);
  const reorderSources = useMutation(api.orgLeadSources.reorder);
  const [editing, setEditing] = useState<MobileLeadSource | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ label: "", isActive: "true" });

  function openCreate() {
    setEditing(null);
    setForm({ label: "", isActive: "true" });
    setOpen(true);
  }

  function openEdit(source: MobileLeadSource) {
    setEditing(source);
    setForm({ label: source.label, isActive: source.isActive ? "true" : "false" });
    setOpen(true);
  }

  async function save() {
    if (!form.label.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateSource({
          orgId,
          sourceId: editing._id,
          label: form.label.trim(),
          isActive: form.isActive === "true",
        });
      } else {
        await createSource({ orgId, label: form.label.trim() });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile lead source save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function move(source: MobileLeadSource, direction: -1 | 1) {
    if (!sources) return;
    const currentIndex = sources.findIndex((item) => item._id === source._id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sources.length) return;
    const ordered = [...sources];
    const [removed] = ordered.splice(currentIndex, 1);
    ordered.splice(nextIndex, 0, removed);
    try {
      await reorderSources({ orgId, orderedIds: ordered.map((item) => item._id) });
    } catch (error) {
      reportError("Mobile lead source reorder failed", error);
    }
  }

  if (sources === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة مصدر" : "Add source"} onPress={openCreate} />
        <PrimaryButton label={locale === "ar" ? "تهيئة" : "Seed"} tone="muted" onPress={() => seedSources({ orgId }).catch((error: unknown) => reportError("Mobile lead source seed failed", error))} />
      </View>
      {sources.length ? sources.map((source) => (
        <RecordCard key={source._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{source.label}</Text>
            <Text style={styles.statusPill}>{source.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{locale === "ar" ? "الترتيب" : "Order"} {source.order + 1}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(source)} />
            <PrimaryButton label={locale === "ar" ? "أعلى" : "Up"} tone="muted" onPress={() => move(source, -1)} />
            <PrimaryButton label={locale === "ar" ? "أسفل" : "Down"} tone="muted" onPress={() => move(source, 1)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeSource({ orgId, sourceId: source._id }).catch((error: unknown) => reportError("Mobile lead source delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مصادر." : "No lead sources found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل مصدر" : "Edit source") : (locale === "ar" ? "مصدر جديد" : "New source")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "المصدر" : "Source"} value={form.label} onChangeText={(label) => setForm((prev) => ({ ...prev, label }))} />
        <SelectField
          label={locale === "ar" ? "الحالة" : "Status"}
          value={form.isActive}
          options={[{ label: locale === "ar" ? "نشط" : "Active", value: "true" }, { label: locale === "ar" ? "متوقف" : "Inactive", value: "false" }]}
          onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))}
        />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function ValuationCompaniesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const companies = useQuery(api.orgValuationCompanies.list, { orgId });
  const seedCompanies = useMutation(api.orgValuationCompanies.seed);
  const createCompany = useMutation(api.orgValuationCompanies.create);
  const updateCompany = useMutation(api.orgValuationCompanies.update);
  const removeCompany = useMutation(api.orgValuationCompanies.remove);
  const [editing, setEditing] = useState<MobileValuationCompany | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", isActive: "true" });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", isActive: "true" });
    setOpen(true);
  }

  function openEdit(company: MobileValuationCompany) {
    setEditing(company);
    setForm({ name: company.name, isActive: company.isActive ? "true" : "false" });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateCompany({
          orgId,
          companyId: editing._id,
          name: form.name.trim(),
          isActive: form.isActive === "true",
        });
      } else {
        await createCompany({ orgId, name: form.name.trim() });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile valuation company save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (companies === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة شركة" : "Add company"} onPress={openCreate} />
        <PrimaryButton label={locale === "ar" ? "تهيئة" : "Seed"} tone="muted" onPress={() => seedCompanies({ orgId }).catch((error: unknown) => reportError("Mobile valuation seed failed", error))} />
      </View>
      {companies.length ? companies.map((company) => (
        <RecordCard key={company._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{company.name}</Text>
            <Text style={styles.statusPill}>{company.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{locale === "ar" ? "الترتيب" : "Order"} {company.order + 1}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(company)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeCompany({ orgId, companyId: company._id }).catch((error: unknown) => reportError("Mobile valuation delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد شركات تقييم." : "No valuation companies found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل شركة" : "Edit company") : (locale === "ar" ? "شركة جديدة" : "New company")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <SelectField
          label={locale === "ar" ? "الحالة" : "Status"}
          value={form.isActive}
          options={[{ label: locale === "ar" ? "نشط" : "Active", value: "true" }, { label: locale === "ar" ? "متوقف" : "Inactive", value: "false" }]}
          onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))}
        />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function fieldKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function CustomFieldsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const [entityType, setEntityType] = useState<MobileCustomFieldEntityType>("vehicle");
  const fields = useQuery(api.orgCustomFields.list, { orgId, entityType });
  const createField = useMutation(api.orgCustomFields.create);
  const updateField = useMutation(api.orgCustomFields.update);
  const removeField = useMutation(api.orgCustomFields.remove);
  const [editing, setEditing] = useState<MobileCustomField | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    entityType: "vehicle" as MobileCustomFieldEntityType,
    fieldName: "",
    fieldKey: "",
    fieldType: "text" as MobileCustomFieldType,
    isRequired: "false",
    options: "",
    isActive: "true",
  });

  const entityOptions: Array<Option<MobileCustomFieldEntityType>> = [
    { label: locale === "ar" ? "السيارات" : "Vehicles", value: "vehicle" },
    { label: locale === "ar" ? "العملاء" : "Customers", value: "customer" },
    { label: locale === "ar" ? "العملاء المحتملون" : "Leads", value: "lead" },
  ];

  function openCreate() {
    setEditing(null);
    setForm({
      entityType,
      fieldName: "",
      fieldKey: "",
      fieldType: "text",
      isRequired: "false",
      options: "",
      isActive: "true",
    });
    setOpen(true);
  }

  function openEdit(field: MobileCustomField) {
    setEditing(field);
    setForm({
      entityType: field.entityType,
      fieldName: field.fieldName,
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      isRequired: field.isRequired ? "true" : "false",
      options: joinList(field.options),
      isActive: field.isActive ? "true" : "false",
    });
    setOpen(true);
  }

  async function save() {
    if (!form.fieldName.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateField({
          orgId,
          fieldId: editing._id,
          fieldName: form.fieldName.trim(),
          isRequired: form.isRequired === "true",
          options: form.fieldType === "select" ? splitLinesOrCommas(form.options) : undefined,
          isActive: form.isActive === "true",
        });
      } else {
        await createField({
          orgId,
          entityType: form.entityType,
          fieldName: form.fieldName.trim(),
          fieldKey: fieldKeyFromName(form.fieldKey || form.fieldName) || `field_${Date.now()}`,
          fieldType: form.fieldType,
          isRequired: form.isRequired === "true",
          options: form.fieldType === "select" ? splitLinesOrCommas(form.options) : undefined,
        });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile custom field save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (fields === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SegmentedControl options={entityOptions} value={entityType} onChange={setEntityType} />
      <PrimaryButton label={locale === "ar" ? "إضافة حقل" : "Add field"} onPress={openCreate} />
      {fields.length ? fields.map((field) => (
        <RecordCard key={field._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{field.fieldName}</Text>
            <Text style={styles.statusPill}>{field.fieldType}</Text>
          </View>
          <Text style={styles.recordMeta}>{field.fieldKey} · {field.entityType} · {field.isRequired ? (locale === "ar" ? "إجباري" : "Required") : (locale === "ar" ? "اختياري" : "Optional")}</Text>
          {field.options?.length ? <Text style={styles.recordMeta}>{field.options.join(", ")}</Text> : null}
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(field)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeField({ orgId, fieldId: field._id }).catch((error: unknown) => reportError("Mobile custom field delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد حقول مخصصة." : "No custom fields found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل حقل" : "Edit field") : (locale === "ar" ? "حقل جديد" : "New field")} visible={open} onClose={() => setOpen(false)}>
        {!editing ? (
          <SelectField label={locale === "ar" ? "النوع" : "Entity"} value={form.entityType} options={entityOptions} onChange={(nextEntityType) => setForm((prev) => ({ ...prev, entityType: nextEntityType as MobileCustomFieldEntityType }))} />
        ) : null}
        <FormField label={locale === "ar" ? "اسم الحقل" : "Field name"} value={form.fieldName} onChangeText={(fieldName) => setForm((prev) => ({ ...prev, fieldName, fieldKey: editing ? prev.fieldKey : fieldKeyFromName(fieldName) }))} />
        {!editing ? (
          <>
            <FormField label={locale === "ar" ? "مفتاح الحقل" : "Field key"} value={form.fieldKey} onChangeText={(fieldKey) => setForm((prev) => ({ ...prev, fieldKey }))} />
            <SelectField
              label={locale === "ar" ? "نوع القيمة" : "Value type"}
              value={form.fieldType}
              options={[
                { label: "Text", value: "text" },
                { label: "Number", value: "number" },
                { label: "Select", value: "select" },
                { label: "Date", value: "date" },
              ]}
              onChange={(fieldType) => setForm((prev) => ({ ...prev, fieldType: fieldType as MobileCustomFieldType }))}
            />
          </>
        ) : null}
        <SelectField label={locale === "ar" ? "إجباري" : "Required"} value={form.isRequired} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isRequired) => setForm((prev) => ({ ...prev, isRequired }))} />
        <SelectField label={locale === "ar" ? "نشط" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
        {form.fieldType === "select" ? (
          <FormField multiline label={locale === "ar" ? "الخيارات" : "Options"} value={form.options} onChangeText={(options) => setForm((prev) => ({ ...prev, options }))} />
        ) : null}
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

function CommissionSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const settings = useQuery(api.orgSettings.get, { orgId });
  const upsertSettings = useMutation(api.orgSettings.upsert);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<MobileOrgSettings["commissionMode"]>("AUTO_MEMBER");
  const [tiersText, setTiersText] = useState("");
  const [sampleProfit, setSampleProfit] = useState("1000");

  useEffect(() => {
    if (!settings) return;
    setMode(settings.commissionMode ?? "AUTO_MEMBER");
    setTiersText((settings.commissionTiers ?? [])
      .slice()
      .sort((a, b) => a.minProfitAmount - b.minProfitAmount)
      .map((tier) => `${tier.minProfitAmount},${tier.commissionPct}`)
      .join("\n"));
  }, [settings]);

  const parsedTiers = splitLinesOrCommas(tiersText.replace(/\n/g, ","))
    .reduce<Array<{ minProfitAmount: number; commissionPct: number }>>((acc, _part, index, parts) => {
      if (index % 2 !== 0) return acc;
      const minProfitAmount = Number(parts[index]);
      const commissionPct = Number(parts[index + 1]);
      if (Number.isFinite(minProfitAmount) && Number.isFinite(commissionPct)) {
        acc.push({ minProfitAmount, commissionPct });
      }
      return acc;
    }, [])
    .sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  const sample = parseOptionalNumber(sampleProfit) ?? 0;
  const samplePct = parsedTiers.reduce((pct, tier) => (sample >= tier.minProfitAmount ? tier.commissionPct : pct), 0);

  async function save() {
    setSaving(true);
    try {
      await upsertSettings({
        orgId,
        commissionMode: mode,
        commissionTiers: parsedTiers,
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile commission settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (settings === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SelectField
        label={locale === "ar" ? "نظام العمولة" : "Commission mode"}
        value={mode ?? "AUTO_MEMBER"}
        options={[
          { label: "AUTO_MEMBER", value: "AUTO_MEMBER" },
          { label: "AUTO_TIERS", value: "AUTO_TIERS" },
          { label: "MANUAL", value: "MANUAL" },
        ]}
        onChange={(nextMode) => setMode(nextMode as MobileOrgSettings["commissionMode"])}
      />
      <FormField
        multiline
        label={locale === "ar" ? "شرائح العمولة: ربح,نسبة لكل سطر" : "Commission tiers: profit,percent per line"}
        value={tiersText}
        onChangeText={setTiersText}
        placeholder={"0,5\n1000,7.5\n3000,10"}
      />
      <FormField keyboardType="numeric" label={locale === "ar" ? "مثال ربح" : "Sample profit"} value={sampleProfit} onChangeText={setSampleProfit} />
      <RecordCard>
        <Text style={styles.recordTitle}>{locale === "ar" ? "معاينة" : "Preview"}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "النسبة" : "Rate"}: {samplePct}%</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "العمولة" : "Commission"}: {money((sample * samplePct) / 100, locale)}</Text>
      </RecordCard>
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
    </ModuleScroll>
  );
}

function LockedFeature({
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

function IntegrationPlatformCard({
  facebook,
  instagram,
  orgId,
}: {
  facebook: MobileFacebookConnectionStatus;
  instagram: MobileInstagramConnectionStatus;
  orgId: string;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const saveInstagramReply = useMutation(api.socialIntegrations.setInstagramAutoReplyConfig);
  const saveInstagramLead = useMutation(api.socialIntegrations.setInstagramLeadCreationConfig);
  const saveFacebookReply = useMutation(api.facebookIntegrations.setFacebookAutoReplyConfig);
  const saveFacebookLead = useMutation(api.facebookIntegrations.setFacebookLeadCreationConfig);
  const setAutoPostEnabled = useMutation(api.socialIntegrations.setAutoPostEnabled);
  const [saving, setSaving] = useState(false);
  const [instagramForm, setInstagramForm] = useState({
    enabledForDms: instagram.instagramAutoReplyForDmsEnabled ? "true" : "false",
    enabledForComments: instagram.instagramAutoReplyForCommentsEnabled ? "true" : "false",
    messages: joinList(instagram.instagramAutoReplyMessages),
    mobileReceivedMessage: instagram.instagramAutoReplyMobileReceivedMessage ?? "",
    leadFromCommentsEnabled: instagram.instagramLeadFromCommentsEnabled ? "true" : "false",
    leadFromDmsEnabled: instagram.instagramLeadFromDmsEnabled ? "true" : "false",
    leadFromDmsRequiresMobile: instagram.instagramLeadFromDmsRequiresMobile ? "true" : "false",
    socialAutoPostEnabled: instagram.socialAutoPostEnabled ? "true" : "false",
  });
  const [facebookForm, setFacebookForm] = useState({
    enabledForDms: facebook.facebookAutoReplyForDmsEnabled ? "true" : "false",
    enabledForComments: facebook.facebookAutoReplyForCommentsEnabled ? "true" : "false",
    messages: joinList(facebook.facebookAutoReplyMessages),
    mobileReceivedMessage: facebook.facebookAutoReplyMobileReceivedMessage ?? "",
    leadFromCommentsEnabled: facebook.facebookLeadFromCommentsEnabled ? "true" : "false",
    leadFromDmsEnabled: facebook.facebookLeadFromDmsEnabled ? "true" : "false",
    leadFromDmsRequiresMobile: facebook.facebookLeadFromDmsRequiresMobile ? "true" : "false",
  });

  async function saveInstagram() {
    setSaving(true);
    try {
      await saveInstagramReply({
        orgId,
        enabledForDms: instagramForm.enabledForDms === "true",
        enabledForComments: instagramForm.enabledForComments === "true",
        messages: splitLinesOrCommas(instagramForm.messages),
        mobileReceivedMessage: maybeText(instagramForm.mobileReceivedMessage),
      });
      await saveInstagramLead({
        orgId,
        leadFromCommentsEnabled: instagramForm.leadFromCommentsEnabled === "true",
        leadFromDmsEnabled: instagramForm.leadFromDmsEnabled === "true",
        leadFromDmsRequiresMobile: instagramForm.leadFromDmsRequiresMobile === "true",
      });
      await setAutoPostEnabled({ orgId, enabled: instagramForm.socialAutoPostEnabled === "true" });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile Instagram integration save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveFacebook() {
    setSaving(true);
    try {
      await saveFacebookReply({
        orgId,
        enabledForDms: facebookForm.enabledForDms === "true",
        enabledForComments: facebookForm.enabledForComments === "true",
        messages: splitLinesOrCommas(facebookForm.messages),
        mobileReceivedMessage: maybeText(facebookForm.mobileReceivedMessage),
      });
      await saveFacebookLead({
        orgId,
        leadFromCommentsEnabled: facebookForm.leadFromCommentsEnabled === "true",
        leadFromDmsEnabled: facebookForm.leadFromDmsEnabled === "true",
        leadFromDmsRequiresMobile: facebookForm.leadFromDmsRequiresMobile === "true",
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile Facebook integration save failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>Instagram</Text>
          <Text style={styles.statusPill}>{instagram.instagramConnected ? "CONNECTED" : "NOT CONNECTED"}</Text>
        </View>
        <Text style={styles.recordMeta}>{instagram.instagramPageName || "-"}</Text>
        <SelectField label={locale === "ar" ? "الرد على الرسائل" : "Reply to DMs"} value={instagramForm.enabledForDms} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForDms) => setInstagramForm((prev) => ({ ...prev, enabledForDms }))} />
        <SelectField label={locale === "ar" ? "الرد على التعليقات" : "Reply to comments"} value={instagramForm.enabledForComments} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForComments) => setInstagramForm((prev) => ({ ...prev, enabledForComments }))} />
        <FormField multiline label={locale === "ar" ? "رسائل الرد" : "Reply messages"} value={instagramForm.messages} onChangeText={(messages) => setInstagramForm((prev) => ({ ...prev, messages }))} />
        <FormField label={locale === "ar" ? "رسالة طلب رقم الهاتف" : "Mobile request message"} value={instagramForm.mobileReceivedMessage} onChangeText={(mobileReceivedMessage) => setInstagramForm((prev) => ({ ...prev, mobileReceivedMessage }))} />
        <SelectField label={locale === "ar" ? "إنشاء عملاء من التعليقات" : "Create leads from comments"} value={instagramForm.leadFromCommentsEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(leadFromCommentsEnabled) => setInstagramForm((prev) => ({ ...prev, leadFromCommentsEnabled }))} />
        <SelectField label={locale === "ar" ? "النشر التلقائي" : "Auto-post inventory"} value={instagramForm.socialAutoPostEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(socialAutoPostEnabled) => setInstagramForm((prev) => ({ ...prev, socialAutoPostEnabled }))} />
        <PrimaryButton disabled={saving} label={locale === "ar" ? "حفظ إنستغرام" : "Save Instagram"} onPress={saveInstagram} />
      </RecordCard>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>Facebook</Text>
          <Text style={styles.statusPill}>{facebook.facebookConnected ? "CONNECTED" : "NOT CONNECTED"}</Text>
        </View>
        <Text style={styles.recordMeta}>{facebook.facebookPageName || "-"}</Text>
        <SelectField label={locale === "ar" ? "الرد على الرسائل" : "Reply to DMs"} value={facebookForm.enabledForDms} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForDms) => setFacebookForm((prev) => ({ ...prev, enabledForDms }))} />
        <SelectField label={locale === "ar" ? "الرد على التعليقات" : "Reply to comments"} value={facebookForm.enabledForComments} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForComments) => setFacebookForm((prev) => ({ ...prev, enabledForComments }))} />
        <FormField multiline label={locale === "ar" ? "رسائل الرد" : "Reply messages"} value={facebookForm.messages} onChangeText={(messages) => setFacebookForm((prev) => ({ ...prev, messages }))} />
        <SelectField label={locale === "ar" ? "إنشاء عملاء من الرسائل" : "Create leads from DMs"} value={facebookForm.leadFromDmsEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(leadFromDmsEnabled) => setFacebookForm((prev) => ({ ...prev, leadFromDmsEnabled }))} />
        <PrimaryButton disabled={saving} label={locale === "ar" ? "حفظ فيسبوك" : "Save Facebook"} onPress={saveFacebook} />
      </RecordCard>
    </>
  );
}

function IntegrationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const canUseSocial = subscription?.planDetails.gates.socialInbox === true;
  const instagram = useQuery(api.socialIntegrations.getConnectionStatus, canUseSocial ? { orgId } : "skip");
  const facebook = useQuery(api.facebookIntegrations.getConnectionStatus, canUseSocial ? { orgId } : "skip");

  if (subscription === undefined || (canUseSocial && (instagram === undefined || facebook === undefined))) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  if (!canUseSocial) {
    return <LockedFeature feature={locale === "ar" ? "الربط الاجتماعي" : "Social integrations"} />;
  }

  if (!instagram || !facebook) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <IntegrationPlatformCard facebook={facebook} instagram={instagram} orgId={orgId} />
    </ModuleScroll>
  );
}

function WebsiteModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const canUseWebsite = subscription?.planDetails.gates.websiteBuilder === true;
  const status = useQuery(api.websites.getStatus, canUseWebsite ? { orgId } : "skip");
  const startSetup = useMutation(api.websites.startSetup);
  const saveDraft = useMutation(api.websites.saveDraft);
  const publishWebsite = useMutation(api.websites.publish);
  const unpublishWebsite = useMutation(api.websites.unpublish);
  const [saving, setSaving] = useState(false);
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
  });
  const [sections, setSections] = useState<Array<{ sectionKey: string; enabled: boolean }>>([]);
  const [routing, setRouting] = useState<Array<{ formType: string; createTask: boolean; notifyByEmail: boolean; notifyByWhatsApp: boolean }>>([]);

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

  async function ensureSetup() {
    setSaving(true);
    try {
      await startSetup({ orgId });
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

  if (subscription === undefined || (canUseWebsite && status === undefined)) {
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
        <EmptyList label={locale === "ar" ? "لم يتم إعداد الموقع بعد." : "Website setup has not started yet."} />
        <PrimaryButton disabled={saving} label={locale === "ar" ? "بدء الإعداد" : "Start setup"} onPress={ensureSetup} />
      </ModuleScroll>
    );
  }

  return (
    <ModuleScroll>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>{websiteStatus.primaryDomain?.domain ?? websiteSettings.defaultSubdomain ?? "-"}</Text>
          <Text style={styles.statusPill}>{websiteSettings.status}</Text>
        </View>
        <Text style={styles.recordMeta}>{locale === "ar" ? "النطاقات" : "Domains"}: {websiteStatus.domains.length}</Text>
      </RecordCard>
      <FormField label={locale === "ar" ? "النطاق الفرعي" : "Subdomain slug"} value={form.subdomainSlug} onChangeText={(subdomainSlug) => setForm((prev) => ({ ...prev, subdomainSlug }))} />
      <FormField label={locale === "ar" ? "القالب" : "Template"} value={form.templateId} onChangeText={(templateId) => setForm((prev) => ({ ...prev, templateId }))} />
      <SelectField label={locale === "ar" ? "اللغة الأساسية" : "Default language"} value={form.defaultLanguage} options={[{ label: "English", value: "en" }, { label: "العربية", value: "ar" }]} onChange={(defaultLanguage) => setForm((prev) => ({ ...prev, defaultLanguage: defaultLanguage as MobileWebsiteLanguage }))} />
      <SelectField label={locale === "ar" ? "دعم العربية" : "Support Arabic"} value={form.supportArabic} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(supportArabic) => setForm((prev) => ({ ...prev, supportArabic }))} />
      <FormField label={locale === "ar" ? "اللون الأساسي" : "Primary color"} value={form.primaryColor} onChangeText={(primaryColor) => setForm((prev) => ({ ...prev, primaryColor }))} />
      <FormField label={locale === "ar" ? "اللون الثانوي" : "Secondary color"} value={form.secondaryColor} onChangeText={(secondaryColor) => setForm((prev) => ({ ...prev, secondaryColor }))} />
      <FormField label={locale === "ar" ? "عنوان البطل" : "Hero title"} value={form.heroTitle} onChangeText={(heroTitle) => setForm((prev) => ({ ...prev, heroTitle }))} />
      <FormField multiline label={locale === "ar" ? "وصف البطل" : "Hero subtitle"} value={form.heroSubtitle} onChangeText={(heroSubtitle) => setForm((prev) => ({ ...prev, heroSubtitle }))} />
      <FormField label={locale === "ar" ? "شارة البطل" : "Hero badge"} value={form.heroBadgeText} onChangeText={(heroBadgeText) => setForm((prev) => ({ ...prev, heroBadgeText }))} />
      <FormField label={locale === "ar" ? "الشعار النصي" : "Slogan"} value={form.slogan} onChangeText={(slogan) => setForm((prev) => ({ ...prev, slogan }))} />
      <Text style={styles.sectionTitle}>{locale === "ar" ? "الأقسام" : "Sections"}</Text>
      {sections.map((section) => (
        <RecordCard key={section.sectionKey}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{section.sectionKey}</Text>
            <PrimaryButton
              label={section.enabled ? (locale === "ar" ? "تعطيل" : "Disable") : (locale === "ar" ? "تفعيل" : "Enable")}
              tone="muted"
              onPress={() => setSections((prev) => prev.map((item) => item.sectionKey === section.sectionKey ? { ...item, enabled: !item.enabled } : item))}
            />
          </View>
        </RecordCard>
      ))}
      <Text style={styles.sectionTitle}>{locale === "ar" ? "توجيه النماذج" : "Form routing"}</Text>
      {routing.map((route) => (
        <RecordCard key={route.formType}>
          <Text style={styles.recordTitle}>{route.formType}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={route.createTask ? (locale === "ar" ? "مهمة: نعم" : "Task: yes") : (locale === "ar" ? "مهمة: لا" : "Task: no")} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, createTask: !item.createTask } : item))} />
            <PrimaryButton label={route.notifyByEmail ? "Email: yes" : "Email: no"} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, notifyByEmail: !item.notifyByEmail } : item))} />
            <PrimaryButton label={route.notifyByWhatsApp ? "WhatsApp: yes" : "WhatsApp: no"} tone="muted" onPress={() => setRouting((prev) => prev.map((item) => item.formType === route.formType ? { ...item, notifyByWhatsApp: !item.notifyByWhatsApp } : item))} />
          </View>
        </RecordCard>
      ))}
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ المسودة" : "Save draft")} onPress={save} />
      <PrimaryButton disabled={saving} label={websiteSettings.status === "active" ? (locale === "ar" ? "إلغاء النشر" : "Unpublish") : (locale === "ar" ? "نشر" : "Publish")} tone="muted" onPress={() => publish(websiteSettings.status !== "active")} />
    </ModuleScroll>
  );
}

function MarketplaceSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const profile = useQuery(api.marketplaceDealers.getMyProfile, { orgId });
  const updateProfile = useMutation(api.marketplaceDealers.updateProfile);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    isOptedIn: "false",
    areas: "",
    brandsCarried: "",
    whatsappNumber: "",
  });

  useEffect(() => {
    if (profile === undefined) return;
    const next: MobileMarketplaceDealerProfile | null = profile;
    setForm({
      isOptedIn: next?.isOptedIn ? "true" : "false",
      areas: (next?.areas ?? []).join(", "),
      brandsCarried: (next?.brandsCarried ?? []).join(", "),
      whatsappNumber: next?.whatsappNumber ?? "",
    });
  }, [profile]);

  async function save() {
    setSaving(true);
    try {
      await updateProfile({
        orgId,
        isOptedIn: form.isOptedIn === "true",
        areas: splitLinesOrCommas(form.areas),
        brandsCarried: splitLinesOrCommas(form.brandsCarried),
        whatsappNumber: maybeText(form.whatsappNumber),
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile marketplace settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (profile === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <RecordCard>
        <Text style={styles.recordTitle}>{locale === "ar" ? "باقة السوق" : "Marketplace tier"}</Text>
        <Text style={styles.recordMeta}>{profile?.tier ?? "FREE_FOUNDING"} · {(profile?.leadsUsedThisPeriod ?? 0)}/{profile?.leadQuota ?? "-"}</Text>
      </RecordCard>
      <SelectField label={locale === "ar" ? "الظهور في السوق" : "Opted in"} value={form.isOptedIn} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isOptedIn) => setForm((prev) => ({ ...prev, isOptedIn }))} />
      <FormField multiline label={locale === "ar" ? "المناطق" : "Areas"} value={form.areas} onChangeText={(areas) => setForm((prev) => ({ ...prev, areas }))} />
      <FormField multiline label={locale === "ar" ? "الماركات" : "Brands carried"} value={form.brandsCarried} onChangeText={(brandsCarried) => setForm((prev) => ({ ...prev, brandsCarried }))} />
      <FormField keyboardType="phone-pad" label={locale === "ar" ? "واتساب" : "WhatsApp"} value={form.whatsappNumber} onChangeText={(whatsappNumber) => setForm((prev) => ({ ...prev, whatsappNumber }))} />
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
    </ModuleScroll>
  );
}

function FeedbackModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const [statusFilter, setStatusFilter] = useState<MobileFeedbackStatus | "ALL">("OPEN");
  const queryArgs = statusFilter === "ALL" ? { orgId } : { orgId, status: statusFilter };
  const feedback = useQuery(api.feedback.list, queryArgs);
  const submitFeedback = useMutation(api.feedback.submit);
  const setFeedbackStatus = useMutation(api.feedback.setStatus);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ type: "FEATURE" as MobileFeedbackType, title: "", description: "" });

  async function submit() {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await submitFeedback({
        orgId,
        type: form.type,
        title: form.title.trim(),
        description: maybeText(form.description),
      });
      setOpen(false);
      setForm({ type: "FEATURE", title: "", description: "" });
    } catch (error) {
      reportError("Mobile feedback submit failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (feedback === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "ملاحظة جديدة" : "New feedback"} onPress={() => setOpen(true)} />
      </View>
      <SegmentedControl options={[{ label: locale === "ar" ? "مفتوح" : "Open", value: "OPEN" }, { label: locale === "ar" ? "مغلق" : "Closed", value: "CLOSED" }, { label: locale === "ar" ? "الكل" : "All", value: "ALL" }]} value={statusFilter} onChange={setStatusFilter} />
      {feedback.length ? feedback.map((item: MobileFeedback) => (
        <RecordCard key={item._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{item.title}</Text>
            <Text style={styles.statusPill}>{item.type}</Text>
          </View>
          <Text style={styles.recordMeta}>{item.userName ?? "-"} · {dateLabel(item.createdAt, locale)} · {item.status}</Text>
          {item.description ? <Text style={styles.recordMeta}>{item.description}</Text> : null}
          <PrimaryButton
            label={item.status === "OPEN" ? (locale === "ar" ? "إغلاق" : "Close") : (locale === "ar" ? "إعادة فتح" : "Reopen")}
            tone="muted"
            onPress={() => setFeedbackStatus({ orgId, feedbackId: item._id, status: item.status === "OPEN" ? "CLOSED" : "OPEN" }).catch((error: unknown) => reportError("Mobile feedback status failed", error))}
          />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد ملاحظات." : "No feedback found."} />}
      <FormModal title={locale === "ar" ? "ملاحظة جديدة" : "New feedback"} visible={open} onClose={() => setOpen(false)}>
        <SelectField label={locale === "ar" ? "النوع" : "Type"} value={form.type} options={[{ label: "Feature", value: "FEATURE" }, { label: "Bug", value: "BUG" }]} onChange={(type) => setForm((prev) => ({ ...prev, type: type as MobileFeedbackType }))} />
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField multiline label={locale === "ar" ? "التفاصيل" : "Details"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Submitting...") : (locale === "ar" ? "إرسال" : "Submit")} onPress={submit} />
      </FormModal>
    </ModuleScroll>
  );
}

function planRank(planId: MobilePlanId): number {
  const order: MobilePlanId[] = ["free", "starter", "professional", "enterprise"];
  return order.indexOf(planId);
}

function limitLabel(current: number, max: number, locale: "en" | "ar"): string {
  if (max === -1) return `${current} / ${locale === "ar" ? "غير محدود" : "Unlimited"}`;
  return `${current} / ${max}`;
}

function BillingModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const usage = useQuery(api.subscriptions.getUsageStats, { orgId });
  const plans = useQuery(api.subscriptions.getPlans, {});
  const showPricing = useQuery(api.subscriptions.getShowPricing, {});
  const requestUpgrade = useAction(api.subscriptions.requestUpgrade);
  const [targetPlan, setTargetPlan] = useState<MobilePlanId | null>(null);
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submitUpgrade() {
    if (!targetPlan || !phone.trim()) return;
    setSaving(true);
    try {
      await requestUpgrade({
        orgId,
        targetPlan,
        phone: phone.trim(),
        message: maybeText(message),
      });
      setTargetPlan(null);
      setPhone("");
      setMessage("");
      Alert.alert("AutoFlow", locale === "ar" ? "تم إرسال طلب الترقية" : "Upgrade request sent");
    } catch (error) {
      reportError("Mobile upgrade request failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (subscription === undefined || usage === undefined || plans === undefined || showPricing === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  const orderedPlans = plans.slice().sort((a, b) => planRank(a.id) - planRank(b.id));

  return (
    <ModuleScroll>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>{locale === "ar" ? subscription.planDetails.nameAr : subscription.planDetails.name}</Text>
          <Text style={styles.statusPill}>{subscription.status}</Text>
        </View>
        <Text style={styles.recordMeta}>{locale === "ar" ? "السيارات" : "Vehicles"}: {limitLabel(usage.vehicleCount, usage.maxVehicles, locale)}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "الأعضاء" : "Members"}: {limitLabel(usage.memberCount, usage.maxUsers, locale)}</Text>
        {subscription.currentPeriodEnd ? <Text style={styles.recordMeta}>{locale === "ar" ? "ينتهي في" : "Renews on"} {dateLabel(subscription.currentPeriodEnd, locale)}</Text> : null}
      </RecordCard>
      {orderedPlans.map((plan) => {
        const current = plan.id === subscription.plan;
        return (
          <RecordCard key={plan.id}>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{locale === "ar" ? plan.nameAr : plan.name}</Text>
              <Text style={styles.statusPill}>{current ? (locale === "ar" ? "الحالية" : "CURRENT") : plan.id.toUpperCase()}</Text>
            </View>
            {showPricing ? <Text style={styles.recordMeta}>{money(plan.priceJod, locale)} / {locale === "ar" ? "شهر" : "month"}</Text> : null}
            <Text style={styles.recordMeta}>{limitLabel(0, plan.maxVehicles, locale)} {locale === "ar" ? "سيارة" : "vehicles"} · {limitLabel(0, plan.maxUsers, locale)} {locale === "ar" ? "أعضاء" : "members"}</Text>
            {(locale === "ar" ? plan.featuresAr : plan.features).slice(0, 4).map((feature) => (
              <Text key={feature} style={styles.recordMeta}>- {feature}</Text>
            ))}
            {!current ? (
              <PrimaryButton label={locale === "ar" ? "طلب ترقية" : "Request upgrade"} tone="muted" onPress={() => setTargetPlan(plan.id)} />
            ) : null}
          </RecordCard>
        );
      })}
      <FormModal title={locale === "ar" ? "طلب ترقية" : "Request upgrade"} visible={Boolean(targetPlan)} onClose={() => setTargetPlan(null)}>
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "رقم الهاتف" : "Phone"} value={phone} onChangeText={setPhone} />
        <FormField multiline label={locale === "ar" ? "رسالة" : "Message"} value={message} onChangeText={setMessage} />
        <PrimaryButton disabled={saving || !phone.trim()} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Submitting...") : (locale === "ar" ? "إرسال" : "Submit")} onPress={submitUpgrade} />
      </FormModal>
    </ModuleScroll>
  );
}

function SettingsModule({
  myMembership,
  org,
}: {
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const settings = useQuery(api.orgSettings.get, { orgId: org._id });
  const upsertSettings = useMutation(api.orgSettings.upsert);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    dealershipName: "",
    legalCompanyName: "",
    dealershipAddress: "",
    dealershipPhone: "",
    dealershipPhones: "",
    currency: "JOD",
    currencySymbol: "د.أ",
    vatRate: "",
    country: "",
    timezone: "",
    approvalThresholdEnabled: "false",
    approvalMinProfitPercent: "",
    commissionMode: "AUTO_MEMBER",
    generatedLeadAutoAssignmentEnabled: "false",
    reservationHoldDays: "",
  });

  useEffect(() => {
    if (!settings) return;
    const next: MobileOrgSettings = settings;
    setForm({
      dealershipName: next.dealershipName ?? org.name,
      legalCompanyName: next.legalCompanyName ?? "",
      dealershipAddress: next.dealershipAddress ?? "",
      dealershipPhone: next.dealershipPhone ?? "",
      dealershipPhones: joinList(next.dealershipPhones),
      currency: next.currency ?? "JOD",
      currencySymbol: next.currencySymbol ?? "د.أ",
      vatRate: next.vatRate != null ? String(next.vatRate) : "",
      country: next.country ?? "",
      timezone: next.timezone ?? "",
      approvalThresholdEnabled: next.approvalThresholdEnabled ? "true" : "false",
      approvalMinProfitPercent: next.approvalMinProfitPercent != null ? String(next.approvalMinProfitPercent) : "",
      commissionMode: next.commissionMode ?? "AUTO_MEMBER",
      generatedLeadAutoAssignmentEnabled: next.generatedLeadAutoAssignmentEnabled ? "true" : "false",
      reservationHoldDays: next.reservationHoldDays != null ? String(next.reservationHoldDays) : "",
    });
  }, [org.name, settings]);

  async function save() {
    setSaving(true);
    try {
      await upsertSettings({
        orgId: org._id,
        dealershipName: maybeText(form.dealershipName),
        legalCompanyName: maybeText(form.legalCompanyName),
        dealershipAddress: maybeText(form.dealershipAddress),
        dealershipPhone: maybeText(form.dealershipPhone),
        dealershipPhones: splitLinesOrCommas(form.dealershipPhones),
        currency: maybeText(form.currency),
        currencySymbol: maybeText(form.currencySymbol),
        vatRate: parseOptionalNumber(form.vatRate),
        country: maybeText(form.country),
        timezone: maybeText(form.timezone),
        approvalThresholdEnabled: form.approvalThresholdEnabled === "true",
        approvalMinProfitPercent: parseOptionalNumber(form.approvalMinProfitPercent),
        commissionMode: form.commissionMode as "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL",
        generatedLeadAutoAssignmentEnabled: form.generatedLeadAutoAssignmentEnabled === "true",
        reservationHoldDays: parseOptionalNumber(form.reservationHoldDays),
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (settings === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <RecordCard>
        <Text style={styles.recordTitle}>{org.name}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "دورك" : "Your role"}: {myMembership.roleName}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "عدد الصلاحيات" : "Permissions"}: {myMembership.permissions.length}</Text>
      </RecordCard>
      <Text style={styles.sectionTitle}>{locale === "ar" ? "الإعدادات العامة" : "General settings"}</Text>
      <FormField label={locale === "ar" ? "اسم المعرض" : "Dealership name"} value={form.dealershipName} onChangeText={(dealershipName) => setForm((prev) => ({ ...prev, dealershipName }))} />
      <FormField label={locale === "ar" ? "الشركة القانونية" : "Legal company name"} value={form.legalCompanyName} onChangeText={(legalCompanyName) => setForm((prev) => ({ ...prev, legalCompanyName }))} />
      <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.dealershipAddress} onChangeText={(dealershipAddress) => setForm((prev) => ({ ...prev, dealershipAddress }))} />
      <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.dealershipPhone} onChangeText={(dealershipPhone) => setForm((prev) => ({ ...prev, dealershipPhone }))} />
      <FormField multiline label={locale === "ar" ? "هواتف إضافية" : "Additional phones"} value={form.dealershipPhones} onChangeText={(dealershipPhones) => setForm((prev) => ({ ...prev, dealershipPhones }))} />
      <FormField label={locale === "ar" ? "العملة" : "Currency"} value={form.currency} onChangeText={(currency) => setForm((prev) => ({ ...prev, currency }))} />
      <FormField label={locale === "ar" ? "رمز العملة" : "Currency symbol"} value={form.currencySymbol} onChangeText={(currencySymbol) => setForm((prev) => ({ ...prev, currencySymbol }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "ضريبة القيمة المضافة" : "VAT rate"} value={form.vatRate} onChangeText={(vatRate) => setForm((prev) => ({ ...prev, vatRate }))} />
      <FormField label={locale === "ar" ? "الدولة" : "Country"} value={form.country} onChangeText={(country) => setForm((prev) => ({ ...prev, country }))} />
      <FormField label={locale === "ar" ? "المنطقة الزمنية" : "Timezone"} value={form.timezone} onChangeText={(timezone) => setForm((prev) => ({ ...prev, timezone }))} />
      <SelectField label={locale === "ar" ? "تفعيل موافقات هامش الربح" : "Approval threshold"} value={form.approvalThresholdEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(approvalThresholdEnabled) => setForm((prev) => ({ ...prev, approvalThresholdEnabled }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "أقل ربح %" : "Min profit %"} value={form.approvalMinProfitPercent} onChangeText={(approvalMinProfitPercent) => setForm((prev) => ({ ...prev, approvalMinProfitPercent }))} />
      <SelectField
        label={locale === "ar" ? "نظام العمولة" : "Commission mode"}
        value={form.commissionMode}
        options={[
          { label: "AUTO_MEMBER", value: "AUTO_MEMBER" },
          { label: "AUTO_TIERS", value: "AUTO_TIERS" },
          { label: "MANUAL", value: "MANUAL" },
        ]}
        onChange={(commissionMode) => setForm((prev) => ({ ...prev, commissionMode }))}
      />
      <SelectField label={locale === "ar" ? "تعيين العملاء تلقائياً" : "Auto-assign generated leads"} value={form.generatedLeadAutoAssignmentEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(generatedLeadAutoAssignmentEnabled) => setForm((prev) => ({ ...prev, generatedLeadAutoAssignmentEnabled }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "أيام الحجز" : "Reservation hold days"} value={form.reservationHoldDays} onChangeText={(reservationHoldDays) => setForm((prev) => ({ ...prev, reservationHoldDays }))} />
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      <Text style={styles.sectionTitle}>{locale === "ar" ? "الصلاحيات" : "Permissions"}</Text>
      {myMembership.permissions.map((permission) => (
        <View key={permission} style={styles.permissionRow}>
          <Text style={styles.permissionText}>{permission}</Text>
        </View>
      ))}
    </ModuleScroll>
  );
}

function ModuleBody({
  moduleId,
  myMembership,
  org,
}: {
  moduleId: NativeModuleId;
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
}) {
  switch (moduleId) {
    case "marketplace":
      return <DedicatedMarketplaceModule orgId={org._id} />;
    case "vehicles":
      return <VehiclesModule orgId={org._id} />;
    case "customers":
      return <CustomersModule orgId={org._id} />;
    case "leads":
      return <LeadsModule orgId={org._id} />;
    case "messages":
      return <MessagesModule orgId={org._id} />;
    case "socialInbox":
      return <SocialInboxModule orgId={org._id} />;
    case "notifications":
      return <NotificationsModule orgId={org._id} />;
    case "tasks":
      return <TasksModule orgId={org._id} />;
    case "sales":
      return <SalesModule myMembership={myMembership} orgId={org._id} />;
    case "expenses":
      return <ExpensesModule orgId={org._id} />;
    case "accounting":
      return <AccountingModule orgId={org._id} />;
    case "sourcing":
      return <SourcingModule orgId={org._id} />;
    case "reports":
      return <ReportsModule orgId={org._id} />;
    case "team":
      return <TeamModule orgId={org._id} />;
    case "applications":
      return <ApplicationsModule orgId={org._id} />;
    case "approvals":
      return <ApprovalsModule orgId={org._id} />;
    case "commissions":
      return <CommissionsModule orgId={org._id} />;
    case "quotes":
      return <QuotesModule orgId={org._id} />;
    case "financeCompanies":
      return <FinanceCompaniesModule orgId={org._id} />;
    case "valuationCompanies":
      return <ValuationCompaniesModule orgId={org._id} />;
    case "branches":
      return <BranchesModule orgId={org._id} />;
    case "roles":
      return <RolesModule orgId={org._id} />;
    case "pipelineSettings":
      return <PipelineSettingsModule orgId={org._id} />;
    case "leadSources":
      return <LeadSourcesModule orgId={org._id} />;
    case "customFields":
      return <CustomFieldsModule orgId={org._id} />;
    case "commissionSettings":
      return <CommissionSettingsModule orgId={org._id} />;
    case "integrations":
      return <IntegrationsModule orgId={org._id} />;
    case "website":
      return <WebsiteModule orgId={org._id} />;
    case "marketplaceSettings":
      return <MarketplaceSettingsModule orgId={org._id} />;
    case "feedback":
      return <FeedbackModule orgId={org._id} />;
    case "billing":
      return <BillingModule orgId={org._id} />;
    case "settings":
      return <SettingsModule myMembership={myMembership} org={org} />;
  }
}

export function WorkspaceModuleScreen({
  moduleId,
  orgId,
}: {
  moduleId: string | null;
  orgId: string | null;
}) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const canQuery = isLoaded && isSignedIn && Boolean(orgId);
  const orgs = useQuery(api.organizations.listMine, canQuery ? {} : "skip");
  const myMembership = useQuery(api.memberships.getMyMembership, canQuery && orgId ? { orgId } : "skip");
  const moduleDefinition = useMemo(() => getNativeModule(moduleId), [moduleId]);
  const selectedOrg = firstAvailableOrg(orgs).find((org) => org._id === orgId) ?? null;

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

  if (!orgId || !isLoaded || !isSignedIn || orgs === undefined || myMembership === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingWorkspace")} />
      </Screen>
    );
  }

  if (
    !selectedOrg ||
    !moduleDefinition ||
    !canAccessNativeModule(moduleDefinition, myMembership.permissions, myMembership.roleName)
  ) {
    return (
      <Screen>
        <View style={styles.unavailable}>
          <Text style={styles.errorTitle}>{t("notFoundTitle")}</Text>
          <Text style={styles.errorBody}>{t("notFoundBody")}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ModuleHeader
        title={labelFor(moduleDefinition.title, locale)}
        subtitle={labelFor(moduleDefinition.subtitle, locale)}
      />
      <ModuleSwitcherBar
        activeModuleId={moduleDefinition.id}
        orgId={selectedOrg._id}
        permissions={myMembership.permissions}
        roleName={myMembership.roleName}
      />
      <ModuleBody moduleId={moduleDefinition.id} myMembership={myMembership} org={selectedOrg} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  backButtonText: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 26,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  brand: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
  },
  headerSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 18,
  },
  moduleSwitcher: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingVertical: theme.spacing.sm,
  },
  moduleSwitcherContent: {
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  moduleSwitchChip: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  moduleSwitchChipSelected: {
    borderColor: "#c7d2fe",
    backgroundColor: theme.colors.primarySoft,
  },
  moduleSwitchText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "900",
  },
  moduleSwitchTextSelected: {
    color: theme.colors.primary,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
  },
  primaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
  },
  dangerButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.danger,
    paddingHorizontal: theme.spacing.md,
  },
  mutedButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "900",
  },
  mutedButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "900",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  chipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  chipText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
  },
  chipTextSelected: {
    color: theme.colors.text,
  },
  recordCard: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  entityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  entityAvatar: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: theme.colors.primarySoft,
  },
  entityAvatarText: {
    color: theme.colors.primaryDark,
    fontSize: 14,
    fontWeight: "900",
  },
  entityText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  vehicleRecordCard: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  vehicleMediaRow: {
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  vehicleThumb: {
    width: 82,
    height: 82,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.hero,
  },
  vehicleThumbImage: {
    width: "100%",
    height: "100%",
  },
  vehicleThumbText: {
    color: theme.colors.onPrimary,
    fontSize: 22,
    fontWeight: "900",
  },
  vehicleCardText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.sm,
  },
  vehicleFactRow: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.sm,
  },
  recordHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  recordTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  recordMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  statusPill: {
    overflow: "hidden",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "900",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  detailPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  detailPill: {
    minHeight: 28,
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  detailPillSuccess: {
    backgroundColor: theme.colors.successSoft,
  },
  detailPillWarning: {
    backgroundColor: theme.colors.warningSoft,
  },
  detailPillInfo: {
    backgroundColor: theme.colors.infoSoft,
  },
  detailPillText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "900",
  },
  cardActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  warningText: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: "800",
  },
  inlineActionGroup: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.sm,
  },
  inlineActionField: {
    flex: 1,
    minWidth: 0,
  },
  formField: {
    gap: theme.spacing.xs,
  },
  formLabel: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  formInput: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
  },
  formInputMultiline: {
    minHeight: 96,
    paddingTop: theme.spacing.md,
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15,23,42,0.42)",
  },
  modalSheet: {
    maxHeight: "88%",
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  modalTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  modalContent: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xxl,
  },
  emptyState: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.lg,
  },
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    textAlign: "center",
  },
  summaryPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    padding: theme.spacing.md,
  },
  summaryHeader: {
    gap: theme.spacing.xs,
  },
  summaryTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "900",
  },
  summarySubtitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 18,
  },
  summaryRows: {
    gap: theme.spacing.sm,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.sm,
  },
  summaryLabel: {
    flex: 0.44,
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
  },
  summaryValue: {
    flex: 0.56,
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
    textAlign: "right",
  },
  wizardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  wizardPrimaryAction: {
    flex: 1,
  },
  mutedText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    textAlign: "center",
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  metricCard: {
    width: "47.8%",
    minHeight: 118,
    justifyContent: "space-between",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  metricTitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  metricValue: {
    color: theme.colors.text,
    fontSize: 27,
    fontWeight: "900",
  },
  metricCaption: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  permissionRow: {
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.sm,
  },
  permissionText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  messagesRoot: {
    flex: 1,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  messagesToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  messagesLayout: {
    flex: 1,
    gap: theme.spacing.md,
  },
  conversationList: {
    maxHeight: 208,
  },
  conversationListContent: {
    gap: theme.spacing.sm,
  },
  conversationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  conversationCardActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  conversationAvatar: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: theme.colors.surfaceAlt,
  },
  conversationAvatarText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "900",
  },
  unreadDot: {
    position: "absolute",
    top: 1,
    right: 1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.primary,
  },
  conversationText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  conversationTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  conversationTime: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "800",
  },
  conversationPreview: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  conversationUnread: {
    color: theme.colors.text,
    fontWeight: "900",
  },
  threadPanel: {
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  threadTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "900",
  },
  threadScroll: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  threadContent: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  messageRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  messageRowMine: {
    justifyContent: "flex-end",
  },
  messageBubble: {
    maxWidth: "84%",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  messageBubbleOther: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  messageBubbleMine: {
    backgroundColor: theme.colors.primary,
  },
  messageSender: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "900",
  },
  messageBody: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  messageBodyMine: {
    color: theme.colors.onPrimary,
  },
  messageMeta: {
    color: theme.colors.mutedText,
    fontSize: 10,
    fontWeight: "800",
  },
  messageMetaMine: {
    color: "#ccfbf1",
  },
  typingText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontStyle: "italic",
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  composerInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 112,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  memberRowSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  memberAvatar: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: theme.colors.surfaceAlt,
  },
  memberAvatarText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "900",
  },
  unavailable: {
    flex: 1,
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  errorTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
  },
  errorBody: {
    color: theme.colors.mutedText,
    fontSize: 15,
    textAlign: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.82,
  },
});
