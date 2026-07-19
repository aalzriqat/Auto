import { nativeRoutes, type MobileFoundationStringKey } from "@autoflow/shared";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import {
  api,
  type MobileMarketplaceDealer,
  type MobileMarketplacePaymentFilter,
  type MobileMarketplaceSearchResult,
  type MobileMarketplaceSortBy,
  type MobileMarketplaceVehicle,
} from "../../convexApi";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { SearchableSelectField } from "../../components/SearchableSelectField";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { type AppTheme } from "../../theme";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import {
  BuyerRequestPanel,
  TradeInRequestPanel,
  type TradeInDealerTarget,
} from "./BuyerIntakePanels";
import { OffersTab } from "./OffersTab";
import { RequestRoomScreen } from "./RequestRoomScreen";
import { saveBuyerRequest, type SavedBuyerRequest } from "./buyerRequestsStore";
import {
  isVehicleSaved,
  loadSavedVehicles,
  toggleSavedVehicle,
  type SavedVehicle,
} from "./savedVehiclesStore";
import {
  loadSavedSearches,
  removeSavedSearchById,
  saveSearch,
  type SavedSearch,
} from "./savedSearchesStore";
import {
  buildTelUrl,
  buildWhatsappUrl,
  formatMoney,
  formatNumber,
  getListingUrl,
  getVehicleTitle,
  isRecentlyListed,
  parseOptionalPositiveNumber,
  trimOrUndefined,
} from "./marketplaceUtils";
import { getMarketplaceSelectOptions } from "./marketplaceSelectOptions";

type BuyerTab = "cars" | "request" | "tradein" | "dealers" | "offers";

// The buyer shell surfaces the marketplace as two bottom tabs — Browse (find a
// car / see dealers) and Request (ask the market / trade in / my offers). "full"
// keeps all five in one screen for the dealer-side /marketplace browse route.
export type MarketplaceVariant = "full" | "browse" | "request";

const VARIANT_TABS: Record<MarketplaceVariant, readonly BuyerTab[]> = {
  full: ["cars", "request", "tradein", "dealers", "offers"],
  browse: ["cars", "dealers"],
  request: ["request", "tradein", "offers"],
};

export function getVariantTabs(variant: MarketplaceVariant): readonly BuyerTab[] {
  return VARIANT_TABS[variant];
}

export function getVariantInitialTab(variant: MarketplaceVariant): BuyerTab {
  return VARIANT_TABS[variant][0];
}

const DEFAULT_SORT: MobileMarketplaceSortBy = "price_asc";

type SearchFields = {
  make: string;
  city: string;
  priceMin: string;
  priceMax: string;
  maxMonthlyPayment: string;
  transmission: string;
  fuelType: string;
  financeOnly: boolean;
  sortBy: MobileMarketplaceSortBy;
};

type SearchFilters = {
  make?: string;
  city?: string;
  priceMin?: number;
  priceMax?: number;
  maxMonthlyPayment?: number;
  transmission?: string;
  fuelType?: string;
  paymentType?: MobileMarketplacePaymentFilter;
  sortBy: MobileMarketplaceSortBy;
  numItems: number;
};

const DEFAULT_FIELDS: SearchFields = {
  make: "",
  city: "",
  priceMin: "",
  priceMax: "",
  maxMonthlyPayment: "",
  transmission: "",
  fuelType: "",
  financeOnly: false,
  sortBy: DEFAULT_SORT,
};

function buildSearchFilters(fields: SearchFields): SearchFilters {
  return {
    make: trimOrUndefined(fields.make),
    city: trimOrUndefined(fields.city),
    priceMin: parseOptionalPositiveNumber(fields.priceMin),
    priceMax: parseOptionalPositiveNumber(fields.priceMax),
    maxMonthlyPayment: parseOptionalPositiveNumber(fields.maxMonthlyPayment),
    transmission: trimOrUndefined(fields.transmission),
    fuelType: trimOrUndefined(fields.fuelType),
    paymentType: fields.financeOnly ? "FINANCE" : undefined,
    sortBy: fields.sortBy,
    numItems: 12,
  };
}

const SORT_OPTIONS: ReadonlyArray<{ value: MobileMarketplaceSortBy; labelKey: MobileFoundationStringKey }> = [
  { value: "price_asc", labelKey: "marketplaceSortPriceAsc" },
  { value: "price_desc", labelKey: "marketplaceSortPriceDesc" },
  { value: "year_desc", labelKey: "marketplaceSortYearDesc" },
  { value: "mileage_asc", labelKey: "marketplaceSortMileageAsc" },
];

// Fixed spec values (chip groups). `value` is the English string stored on the
// vehicle and matched case-insensitively by the backend; the label is localized.
const TRANSMISSION_OPTIONS: ReadonlyArray<{ value: string; labelKey: MobileFoundationStringKey }> = [
  { value: "Automatic", labelKey: "marketplaceTransmissionAutomatic" },
  { value: "Manual", labelKey: "marketplaceTransmissionManual" },
];
const FUEL_OPTIONS: ReadonlyArray<{ value: string; labelKey: MobileFoundationStringKey }> = [
  { value: "Petrol", labelKey: "marketplaceFuelPetrol" },
  { value: "Diesel", labelKey: "marketplaceFuelDiesel" },
  { value: "Electric", labelKey: "marketplaceFuelElectric" },
  { value: "Hybrid", labelKey: "marketplaceFuelHybrid" },
];

type Translate = (key: MobileFoundationStringKey) => string;

/** Narrows a stored sort string back to the union, defaulting when unrecognized (e.g. an older saved search). */
function coerceSortBy(value: string): MobileMarketplaceSortBy {
  return SORT_OPTIONS.some((option) => option.value === value) ? (value as MobileMarketplaceSortBy) : DEFAULT_SORT;
}

function localizedSpecValue(
  value: string,
  options: ReadonlyArray<{ value: string; labelKey: MobileFoundationStringKey }>,
  t: Translate,
): string {
  const match = options.find((option) => option.value === value);
  return match ? t(match.labelKey) : value;
}

/** Human, localized one-line summary of a search's filters, stored with the saved search so the chip reads clearly. */
export function buildSearchLabel(fields: SearchFields, t: Translate): string {
  const parts: string[] = [];
  if (fields.make.trim()) parts.push(fields.make.trim());
  if (fields.city.trim()) parts.push(fields.city.trim());
  if (fields.transmission) parts.push(localizedSpecValue(fields.transmission, TRANSMISSION_OPTIONS, t));
  if (fields.fuelType) parts.push(localizedSpecValue(fields.fuelType, FUEL_OPTIONS, t));
  const min = fields.priceMin.trim();
  const max = fields.priceMax.trim();
  if (min && max) parts.push(`${min}–${max} JOD`);
  else if (min) parts.push(`≥ ${min} JOD`);
  else if (max) parts.push(`≤ ${max} JOD`);
  if (fields.maxMonthlyPayment.trim()) parts.push(`≤ ${fields.maxMonthlyPayment.trim()} JOD/${t("marketplaceMonth")}`);
  if (fields.financeOnly) parts.push(t("marketplaceFinanceOnly"));
  return parts.join(" · ");
}

export function countActiveFilters(fields: SearchFields): number {
  let count = 0;
  if (trimOrUndefined(fields.make)) count += 1;
  if (trimOrUndefined(fields.city)) count += 1;
  if (parseOptionalPositiveNumber(fields.priceMin) != null) count += 1;
  if (parseOptionalPositiveNumber(fields.priceMax) != null) count += 1;
  if (parseOptionalPositiveNumber(fields.maxMonthlyPayment) != null) count += 1;
  if (trimOrUndefined(fields.transmission)) count += 1;
  if (trimOrUndefined(fields.fuelType)) count += 1;
  if (fields.financeOnly) count += 1;
  return count;
}

function openExternalUrl(url: string | null) {
  if (!url) return;
  Linking.openURL(url).catch((error: unknown) => {
    console.error("Failed to open marketplace link", error);
    Alert.alert("AutoFlow", "Unable to open this link right now.");
  });
}

function Header({ showAccount }: Readonly<{ showAccount: boolean }>) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text style={styles.title}>{t("marketplaceTitle")}</Text>
        <Text style={styles.subtitle}>{t("marketplaceSubtitle")}</Text>
      </View>
      {showAccount ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("account")}
          style={({ pressed }) => [styles.secondaryIconButton, pressed && styles.pressed]}
          onPress={() => router.push(nativeRoutes.account)}
        >
          <Icon color="primary" name="team" size={18} />
          <Text style={styles.secondaryIconText}>{t("account")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TabBar({
  activeTab,
  onChange,
  visibleTabs,
}: {
  activeTab: BuyerTab;
  onChange: (tab: BuyerTab) => void;
  visibleTabs: readonly BuyerTab[];
}) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const { width } = useWindowDimensions();
  const allTabs: Array<{ value: BuyerTab; label: string }> = [
    { value: "cars", label: t("marketplaceCarsTab") },
    { value: "request", label: t("marketplaceRequestCarTab") },
    { value: "tradein", label: t("marketplaceTradeInBuyerTab") },
    { value: "dealers", label: t("marketplaceDealersTab") },
    { value: "offers", label: t("marketplaceOffersTab") },
  ];
  const tabs = allTabs.filter((tab) => visibleTabs.includes(tab.value));
  // A two-tab variant reads better as full-width segments than as scroll chips.
  if (tabs.length <= 1) {
    return null;
  }
  const tabWidth = Math.max(
    64,
    Math.floor(
      (width - theme.spacing.lg * 2 - theme.spacing.xs * 2 - theme.spacing.xs * (tabs.length - 1)) /
        tabs.length,
    ),
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabsScroll}
      contentContainerStyle={[styles.tabs, { direction: textDirection }]}
    >
      {tabs.map((tab) => {
        const selected = activeTab === tab.value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.tab,
              { width: tabWidth },
              selected && styles.tabSelected,
              pressed && styles.pressed,
            ]}
            onPress={() => onChange(tab.value)}
          >
            <Text
              adjustsFontSizeToFit
              minimumFontScale={0.82}
              numberOfLines={1}
              style={[styles.tabText, selected && styles.tabTextSelected]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// Grouped/visual filter — a labeled row of single-select chips (with an "Any"
// reset chip). The selected `value` is the English spec string sent to the
// backend; chips show localized labels.
function FilterChipGroup({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; labelKey: MobileFoundationStringKey }>;
  onChange: (value: string) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useLocale();
  const chips = [{ value: "", label: t("marketplaceAnyOption") }, ...options.map((o) => ({ value: o.value, label: t(o.labelKey) }))];

  return (
    <View style={styles.chipGroup}>
      <Text style={styles.chipGroupLabel}>{label}</Text>
      <View style={styles.chipGroupRow}>
        {chips.map((chip) => {
          const selected = value === chip.value;
          return (
            <Pressable
              key={chip.value || "any"}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [styles.chip, selected && styles.chipActive, pressed && styles.pressed]}
              onPress={() => onChange(chip.value)}
            >
              <Text style={[styles.chipText, selected && styles.chipTextActive]}>{chip.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SearchPanel({
  fields,
  setFields,
  onSearch,
  onReset,
}: Readonly<{
  fields: SearchFields;
  setFields: (fields: SearchFields) => void;
  onSearch: () => void;
  onReset: () => void;
}>) {
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const selectOptions = getMarketplaceSelectOptions(locale);

  return (
    <View style={[styles.searchPanel, { direction: textDirection }]}>
      <View style={styles.formGrid}>
        <SearchableSelectField
          allowCustomValue
          closeLabel={selectOptions.closeLabel}
          customValueLabel={selectOptions.customValueLabel}
          emptyLabel={selectOptions.emptyLabel}
          label={t("marketplaceMake")}
          options={selectOptions.makeOptions}
          placeholder={selectOptions.makeAnyPlaceholder}
          searchPlaceholder={selectOptions.makeSearchPlaceholder}
          value={fields.make}
          onChange={(make) => setFields({ ...fields, make })}
        />
        <SearchableSelectField
          allowCustomValue
          closeLabel={selectOptions.closeLabel}
          customValueLabel={selectOptions.customValueLabel}
          emptyLabel={selectOptions.emptyLabel}
          label={t("marketplaceCity")}
          options={selectOptions.cityOptions}
          placeholder={selectOptions.cityAnyPlaceholder}
          searchPlaceholder={selectOptions.citySearchPlaceholder}
          value={fields.city}
          onChange={(city) => setFields({ ...fields, city })}
        />
        <FormField
          label={t("marketplacePriceMin")}
          value={fields.priceMin}
          keyboardType="number-pad"
          onChangeText={(priceMin) => setFields({ ...fields, priceMin })}
        />
        <FormField
          label={t("marketplacePriceMax")}
          value={fields.priceMax}
          keyboardType="number-pad"
          onChangeText={(priceMax) => setFields({ ...fields, priceMax })}
        />
        <FormField
          label={t("marketplaceMonthlyMax")}
          value={fields.maxMonthlyPayment}
          keyboardType="number-pad"
          onChangeText={(maxMonthlyPayment) => setFields({ ...fields, maxMonthlyPayment })}
        />
      </View>

      <FilterChipGroup
        label={t("marketplaceTransmission")}
        value={fields.transmission}
        options={TRANSMISSION_OPTIONS}
        onChange={(transmission) => setFields({ ...fields, transmission })}
      />
      <FilterChipGroup
        label={t("marketplaceFuelType")}
        value={fields.fuelType}
        options={FUEL_OPTIONS}
        onChange={(fuelType) => setFields({ ...fields, fuelType })}
      />

      <View style={styles.switchRow}>
        <Switch
          value={fields.financeOnly}
          onValueChange={(financeOnly) => setFields({ ...fields, financeOnly })}
          trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primarySoft }}
          thumbColor={fields.financeOnly ? theme.colors.primary : theme.colors.surface}
        />
        <Text style={styles.switchText}>{t("marketplaceFinanceOnly")}</Text>
      </View>

      <View style={styles.actionRow}>
        <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={onSearch}>
          <Text style={styles.primaryButtonText}>{t("marketplaceSearch")}</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={onReset}>
          <Text style={styles.secondaryButtonText}>{t("marketplaceReset")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Badge({ label, tone = "green" }: Readonly<{ label: string; tone?: "green" | "amber" | "blue" }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.badge, tone === "amber" && styles.amberBadge, tone === "blue" && styles.blueBadge]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

// Full specs table on the detail sheet — grows the native detail toward the
// classifieds' depth (transmission/fuel/color join year+mileage). Each field is
// only present when the dealer enabled that section on their published site, so
// rows are filtered to whatever's actually disclosed.
function SpecsTable({ vehicle }: Readonly<{ vehicle: MobileMarketplaceVehicle }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t } = useLocale();
  const rows = [
    vehicle.year ? { label: t("marketplaceYear"), value: formatNumber(vehicle.year, locale) } : null,
    vehicle.mileage != null ? { label: t("marketplaceMileage"), value: formatNumber(vehicle.mileage, locale) } : null,
    vehicle.transmission ? { label: t("marketplaceTransmission"), value: vehicle.transmission } : null,
    vehicle.fuelType ? { label: t("marketplaceFuelType"), value: vehicle.fuelType } : null,
    vehicle.exteriorColor ? { label: t("marketplaceColor"), value: vehicle.exteriorColor } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  if (rows.length === 0) return null;

  return (
    <View style={styles.specSection}>
      <Text style={styles.specSectionTitle}>{t("marketplaceSpecsTitle")}</Text>
      <View style={styles.specGrid}>
        {rows.map((row) => (
          <View key={row.label} style={styles.specRow}>
            <Text style={styles.specLabel}>{row.label}</Text>
            <Text style={styles.specValue}>{row.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Native share sheet with the car title + its public listing link, so a buyer
// can send a car to a friend/family (a decision often made together here).
async function shareVehicle(vehicle: MobileMarketplaceVehicle, title: string, shareErrorLabel: string) {
  const message = [title, getListingUrl(vehicle)].filter((part): part is string => Boolean(part)).join(" ");
  try {
    await Share.share({ message, title });
  } catch (error) {
    console.error("Failed to share vehicle", error);
    Alert.alert("AutoFlow", shareErrorLabel);
  }
}

function TrustFacts({ vehicle }: Readonly<{ vehicle: MobileMarketplaceVehicle }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t } = useLocale();
  const facts = [
    vehicle.inspectionStatus === "SELF_REPORTED" ? t("marketplaceTrustSelfReported") : null,
    vehicle.inspectionStatus === "PARTNER_VERIFIED" ? t("marketplaceTrustPartnerVerified") : null,
    vehicle.accidentDisclosed === false ? t("marketplaceTrustNoAccidents") : null,
    vehicle.accidentDisclosed === true ? t("marketplaceTrustAccidentDisclosed") : null,
    vehicle.ownerCount != null
      ? `${formatNumber(vehicle.ownerCount, locale)} ${t("marketplaceTrustOwnerCount")}`
      : null,
    vehicle.dealerGuarantee ? t("marketplaceTrustDealerGuarantee") : null,
  ].filter((fact): fact is string => Boolean(fact));

  if (facts.length === 0) return null;

  return (
    <View style={styles.factList}>
      {facts.map((fact) => (
        <Text key={fact} style={styles.factText}>
          {fact}
        </Text>
      ))}
    </View>
  );
}

// Per-card saved state so the heart toggles without threading store state
// through the whole results list. Anonymous buyers save to the on-device store.
function useVehicleSaved(vehicleId: string) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    loadSavedVehicles()
      .then((list) => {
        if (active) setSaved(isVehicleSaved(list, vehicleId));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [vehicleId]);
  const toggle = useCallback(
    async (snapshot: SavedVehicle) => {
      const next = await toggleSavedVehicle(snapshot);
      setSaved(isVehicleSaved(next, vehicleId));
    },
    [vehicleId],
  );
  return { saved, toggle };
}

// Builds the WhatsApp opener text: a greeting + the car title + its public
// listing link, so the dealer sees exactly which car the buyer means.
function buildWhatsappContactUrl(vehicle: MobileMarketplaceVehicle, greeting: string): string | null {
  const message = [greeting, getVehicleTitle(vehicle), getListingUrl(vehicle)]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return buildWhatsappUrl(vehicle.dealerWhatsapp, message);
}

// Direct-contact CTAs — the #1 marketplace conversion lever (regional buyers
// reach dealers by Call/WhatsApp, not in-app forms). Rendered as a sticky
// footer on the detail sheet and inline on cards. Returns null when the dealer
// exposed no reachable number, so no dead button is shown.
function ContactBar({
  vehicle,
  variant = "sticky",
}: Readonly<{ vehicle: MobileMarketplaceVehicle; variant?: "sticky" | "inline" }>) {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const telUrl = buildTelUrl(vehicle.dealerPhone);
  const whatsappUrl = buildWhatsappContactUrl(vehicle, t("marketplaceWhatsappMessage"));

  if (!telUrl && !whatsappUrl) return null;

  return (
    <View style={[variant === "sticky" ? styles.contactBar : styles.contactBarInline, { direction: textDirection }]}>
      {telUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceCall")}
          style={({ pressed }) => [styles.contactButton, styles.contactButtonCall, pressed && styles.pressed]}
          onPress={() => openExternalUrl(telUrl)}
        >
          <Icon color="onPrimary" name="call" size={18} />
          <Text style={styles.contactButtonText}>{t("marketplaceCall")}</Text>
        </Pressable>
      ) : null}
      {whatsappUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceWhatsapp")}
          style={({ pressed }) => [styles.contactButton, styles.contactButtonWhatsapp, pressed && styles.pressed]}
          onPress={() => openExternalUrl(whatsappUrl)}
        >
          <Icon color="onPrimary" name="whatsapp" size={18} />
          <Text style={styles.contactButtonText}>{t("marketplaceWhatsapp")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// A compact card in the "Similar cars" strip on the detail sheet.
function SimilarCarCard({
  vehicle,
  onSelect,
}: Readonly<{ vehicle: MobileMarketplaceVehicle; onSelect: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t } = useLocale();
  const title = getVehicleTitle(vehicle);
  const price = formatMoney(vehicle.price, locale);
  const monthly = formatMoney(vehicle.estimatedMonthlyPayment, locale);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("marketplaceViewDetails")}: ${title}`}
      style={({ pressed }) => [styles.similarCard, pressed && styles.pressed]}
      onPress={onSelect}
    >
      <View style={styles.similarImageWrap}>
        {vehicle.imageUrls[0] ? (
          <Image source={{ uri: vehicle.imageUrls[0] }} style={styles.similarImage} resizeMode="cover" />
        ) : (
          <Text style={styles.noImageText}>{t("marketplaceNoImage")}</Text>
        )}
      </View>
      <Text numberOfLines={1} style={styles.similarTitle}>{title}</Text>
      {price ? <Text numberOfLines={1} style={styles.similarPrice}>{price}</Text> : null}
      {monthly ? (
        <Text numberOfLines={1} style={styles.similarMonthly}>
          {t("marketplaceFromPerMonth")} {monthly}/{t("marketplaceMonth")}
        </Text>
      ) : null}
    </Pressable>
  );
}

// Native, in-app vehicle detail — the buyer's conversion screen. Uses the
// vehicle object already returned by the search query (no extra round-trip) so
// the journey stays in AutoFlow instead of bouncing to the dealer's website.
// Holds its own "shown" vehicle so the Similar-cars strip can swap the detail
// in place without leaving the sheet.
function VehicleDetailModal({
  vehicle,
  visible,
  onClose,
  onTradeInPress,
}: Readonly<{
  vehicle: MobileMarketplaceVehicle;
  visible: boolean;
  onClose: () => void;
  onTradeInPress: (dealer: TradeInDealerTarget) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [shown, setShown] = useState(vehicle);

  // Reset to the card's vehicle whenever the sheet (re)opens for it, so a prior
  // Similar-cars selection doesn't linger into the next open.
  useEffect(() => {
    if (visible) setShown(vehicle);
  }, [visible, vehicle]);

  const { saved, toggle } = useVehicleSaved(shown.id);
  const title = getVehicleTitle(shown);
  const price = formatMoney(shown.price, locale);
  const monthly = formatMoney(shown.estimatedMonthlyPayment, locale);
  const listingUrl = getListingUrl(shown);

  const snapshot: SavedVehicle = {
    id: shown.id,
    orgId: shown.orgId,
    title,
    price: shown.price ?? undefined,
    monthlyPayment: shown.estimatedMonthlyPayment ?? undefined,
    imageUrl: shown.imageUrls[0],
    dealershipName: shown.dealershipName,
    savedAt: Date.now(),
  };

  // Only query while the sheet is open. Same-make cars from the marketplace,
  // minus the one being viewed.
  const similarResult = useQuery(
    api.marketplaceBrowse.search,
    visible ? { make: shown.make, numItems: 8 } : "skip",
  ) as MobileMarketplaceSearchResult | undefined;
  const similar = (similarResult?.vehicles ?? []).filter((car) => car.id !== shown.id).slice(0, 6);

  const selectSimilar = (car: MobileMarketplaceVehicle) => {
    setShown(car);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.detailContent}>
          <View style={[styles.sheetHeader, { direction: textDirection }]}>
            <Text numberOfLines={1} style={styles.detailDealer}>{shown.dealershipName}</Text>
            <View style={styles.sheetHeaderActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("marketplaceShare")}
                style={({ pressed }) => [styles.sheetClose, pressed && styles.pressed]}
                onPress={() => void shareVehicle(shown, title, t("marketplaceShareError"))}
              >
                <Icon color="text" name="share" size={20} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("close")}
                style={({ pressed }) => [styles.sheetClose, pressed && styles.pressed]}
                onPress={onClose}
              >
                <Icon color="text" name="close" size={20} />
              </Pressable>
            </View>
          </View>

          {shown.imageUrls.length > 0 ? (
            <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={styles.gallery}>
              {shown.imageUrls.map((url, index) => (
                <Image
                  key={`${url}-${index}`}
                  source={{ uri: url }}
                  style={[styles.galleryImage, { width }]}
                  resizeMode="cover"
                />
              ))}
            </ScrollView>
          ) : (
            <View style={styles.galleryEmpty}>
              <Text style={styles.noImageText}>{t("marketplaceNoImage")}</Text>
            </View>
          )}

          <View style={[styles.detailBody, { direction: textDirection }]}>
            <Text style={styles.detailTitle}>{title}</Text>
            {price ? <Text style={styles.detailPrice}>{price}</Text> : null}
            {monthly ? (
              <Text style={styles.detailMonthly}>
                {t("marketplaceFromPerMonth")} {monthly}/{t("marketplaceMonth")}
              </Text>
            ) : null}

            <View style={styles.badgeRow}>
              {isRecentlyListed(shown.listedAt) ? <Badge label={t("marketplaceNew")} tone="amber" /> : null}
              {shown.financeAvailable ? <Badge label={t("marketplaceFinanceAvailable")} /> : null}
              {shown.dealerBadges.includes("VERIFIED_PHONE") ? (
                <Badge label={t("marketplaceVerifiedDealer")} tone="blue" />
              ) : null}
              {shown.dealerBadges.includes("FAST_RESPONSE") ? (
                <Badge label={t("marketplaceFastResponse")} tone="amber" />
              ) : null}
            </View>

            <SpecsTable vehicle={shown} />

            <TrustFacts vehicle={shown} />

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: saved }}
              style={({ pressed }) => [styles.detailPrimaryAction, saved && styles.detailPrimaryActionActive, pressed && styles.pressed]}
              onPress={() => void toggle(snapshot)}
            >
              <Icon color={saved ? "onPrimary" : "primary"} name="save" size={18} />
              <Text style={[styles.detailPrimaryActionText, saved && styles.detailPrimaryActionTextActive]}>
                {saved ? t("marketplaceSavedRemove") : t("marketplaceSaveCar")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => {
                onClose();
                onTradeInPress({ orgId: shown.orgId, dealershipName: shown.dealershipName });
              }}
            >
              <Text style={styles.secondaryButtonText}>{t("marketplaceRequestTradeIn")}</Text>
            </Pressable>
            {listingUrl ? (
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
                onPress={() => openExternalUrl(listingUrl)}
              >
                <Text style={styles.inlineButtonText}>{t("marketplaceOpenListing")}</Text>
              </Pressable>
            ) : null}

            {similar.length > 0 ? (
              <View style={styles.similarSection}>
                <Text style={styles.specSectionTitle}>{t("marketplaceSimilarTitle")}</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={[styles.similarRow, { direction: textDirection }]}
                >
                  {similar.map((car) => (
                    <SimilarCarCard
                      key={`${car.orgId}-${car.id}`}
                      vehicle={car}
                      onSelect={() => selectSimilar(car)}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>
        </ScrollView>
        <ContactBar vehicle={shown} />
      </Screen>
    </Modal>
  );
}

function VehicleCard({
  vehicle,
  onTradeInPress,
}: Readonly<{
  vehicle: MobileMarketplaceVehicle;
  onTradeInPress: (dealer: TradeInDealerTarget) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const title = getVehicleTitle(vehicle);
  const listingUrl = getListingUrl(vehicle);
  const price = formatMoney(vehicle.price, locale);
  const monthly = formatMoney(vehicle.estimatedMonthlyPayment, locale);
  const { saved, toggle } = useVehicleSaved(vehicle.id);
  const [detailOpen, setDetailOpen] = useState(false);

  const snapshot: SavedVehicle = {
    id: vehicle.id,
    orgId: vehicle.orgId,
    title,
    price: vehicle.price ?? undefined,
    monthlyPayment: vehicle.estimatedMonthlyPayment ?? undefined,
    imageUrl: vehicle.imageUrls[0],
    dealershipName: vehicle.dealershipName,
    savedAt: Date.now(),
  };

  return (
    <View style={[styles.vehicleCard, { direction: textDirection }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("marketplaceViewDetails")}: ${title}`}
        style={styles.vehicleImageWrap}
        onPress={() => setDetailOpen(true)}
      >
        {vehicle.imageUrls[0] ? (
          <Image source={{ uri: vehicle.imageUrls[0] }} style={styles.vehicleImage} resizeMode="cover" />
        ) : (
          <Text style={styles.noImageText}>{t("marketplaceNoImage")}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saved ? t("marketplaceSavedRemove") : t("marketplaceSaveCar")}
          accessibilityState={{ selected: saved }}
          style={({ pressed }) => [styles.saveButton, saved && styles.saveButtonActive, pressed && styles.pressed]}
          onPress={() => void toggle(snapshot)}
        >
          <Icon color={saved ? "onPrimary" : "text"} name="save" size={18} />
        </Pressable>
        {price ? (
          <View style={styles.priceBadge}>
            <Text style={styles.priceBadgeText}>{price}</Text>
          </View>
        ) : null}
        {vehicle.imageUrls.length > 0 ? (
          <View style={styles.photoCountBadge}>
            <Icon color="onPrimary" name="photos" size={13} />
            <Text style={styles.photoCountText}>{formatNumber(vehicle.imageUrls.length, locale)}</Text>
          </View>
        ) : null}
      </Pressable>
      <View style={styles.cardBody}>
        <Pressable accessibilityRole="button" onPress={() => setDetailOpen(true)}>
          <Text style={styles.cardTitle}>{title}</Text>
        </Pressable>
        <Text style={styles.cardMeta}>{vehicle.dealershipName}</Text>
        {vehicle.mileage != null ? (
          <Text style={styles.cardMeta}>
            {formatNumber(vehicle.mileage, locale)} {t("marketplaceMileage")}
          </Text>
        ) : null}
        {monthly ? (
          <Text style={styles.cardMeta}>
            {t("marketplaceFromPerMonth")} {monthly}/{t("marketplaceMonth")}
          </Text>
        ) : null}
        <View style={styles.badgeRow}>
          {isRecentlyListed(vehicle.listedAt) ? <Badge label={t("marketplaceNew")} tone="amber" /> : null}
          {vehicle.financeAvailable ? <Badge label={t("marketplaceFinanceAvailable")} /> : null}
          {vehicle.dealerBadges.includes("VERIFIED_PHONE") ? (
            <Badge label={t("marketplaceVerifiedDealer")} tone="blue" />
          ) : null}
          {vehicle.dealerBadges.includes("FAST_RESPONSE") ? (
            <Badge label={t("marketplaceFastResponse")} tone="amber" />
          ) : null}
        </View>
        <TrustFacts vehicle={vehicle} />
        <ContactBar vehicle={vehicle} variant="inline" />
        <View style={styles.actionRow}>
          {listingUrl ? (
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
              onPress={() => openExternalUrl(listingUrl)}
            >
              <Text style={styles.inlineButtonText}>{t("marketplaceOpenListing")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            onPress={() => onTradeInPress({ orgId: vehicle.orgId, dealershipName: vehicle.dealershipName })}
          >
            <Text style={styles.secondaryButtonText}>{t("marketplaceRequestTradeIn")}</Text>
          </Pressable>
        </View>
      </View>
      <VehicleDetailModal
        vehicle={vehicle}
        visible={detailOpen}
        onClose={() => setDetailOpen(false)}
        onTradeInPress={onTradeInPress}
      />
    </View>
  );
}

function CarsResultsPage({
  filters,
  cursor,
  isFirst,
  isLast,
  onLoadMore,
  onTradeInPress,
}: {
  filters: SearchFilters;
  cursor: string | undefined;
  isFirst: boolean;
  isLast: boolean;
  onLoadMore: (cursor: string) => void;
  onTradeInPress: (dealer: TradeInDealerTarget) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useLocale();
  const searchResult = useQuery(api.marketplaceBrowse.search, { ...filters, cursor }) as
    | MobileMarketplaceSearchResult
    | undefined;

  if (searchResult === undefined) {
    return isFirst ? <RouteLoadingState label={t("marketplaceLoadingCars")} /> : null;
  }

  if (isFirst && searchResult.vehicles.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceCarsEmpty")}</Text>;
  }

  return (
    <View style={styles.resultsBlock}>
      {searchResult.vehicles.map((vehicle) => (
        <VehicleCard
          key={`${vehicle.orgId}-${vehicle.id}`}
          vehicle={vehicle}
          onTradeInPress={onTradeInPress}
        />
      ))}
      {isLast && !searchResult.isDone && searchResult.continueCursor ? (
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => onLoadMore(searchResult.continueCursor!)}
        >
          <Text style={styles.secondaryButtonText}>{t("marketplaceLoadMore")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function CarsPanel({
  onTradeInPress,
  onRequest,
}: Readonly<{ onTradeInPress: (dealer: TradeInDealerTarget) => void; onRequest: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();
  const [fields, setFields] = useState<SearchFields>(DEFAULT_FIELDS);
  const [searchKey, setSearchKey] = useState(0);
  const [filters, setFilters] = useState<SearchFilters>(() => buildSearchFilters(DEFAULT_FIELDS));
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    let active = true;
    loadSavedSearches()
      .then((list) => {
        if (active) setSavedSearches(list);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  function applyFields(next: SearchFields) {
    setFields(next);
    setSearchKey((value) => value + 1);
    setFilters(buildSearchFilters(next));
    setCursors([undefined]);
  }

  async function handleSaveSearch() {
    setSavedSearches(await saveSearch(fields, buildSearchLabel(fields, t)));
    setSheetOpen(false);
  }

  async function handleRemoveSaved(id: string) {
    setSavedSearches(await removeSavedSearchById(id));
  }

  function handleApplySaved(entry: SavedSearch) {
    applyFields({ ...entry.fields, sortBy: coerceSortBy(entry.fields.sortBy) });
  }

  const activeCount = countActiveFilters(fields);

  return (
    <View style={styles.panelGap}>
      {/* Reverse-marketplace hero: AutoFlow's wedge — the buyer posts a request
          and dealers compete with real monthly-payment offers. Kept at the top
          of Browse so it's the differentiator buyers see, not buried in a tab. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("marketplaceRequestHeroCta")}
        style={({ pressed }) => [styles.requestHero, { direction: textDirection }, pressed && styles.pressed]}
        onPress={onRequest}
      >
        <View style={styles.requestHeroIcon}>
          <Icon color="onPrimary" name="marketplace" size={22} />
        </View>
        <View style={styles.requestHeroText}>
          <Text style={styles.requestHeroTitle}>{t("marketplaceRequestHeroTitle")}</Text>
          <Text style={styles.requestHeroBody}>{t("marketplaceRequestHeroBody")}</Text>
          <View style={styles.requestHeroCta}>
            <Text style={styles.requestHeroCtaText}>{t("marketplaceRequestHeroCta")}</Text>
            <Icon color="onPrimary" name="chevronForward" size={16} />
          </View>
        </View>
      </Pressable>

      {/* Results-first: a slim bar (Filters sheet + Finance chip) sits above the
          inventory instead of a full desktop-style form. */}
      <View style={[styles.browseBar, { direction: textDirection }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceFilters")}
          style={({ pressed }) => [styles.filtersButton, pressed && styles.pressed]}
          onPress={() => setSheetOpen(true)}
        >
          <Icon color="text" name="search" size={18} />
          <Text style={styles.filtersButtonText}>{t("marketplaceFilters")}</Text>
          {activeCount > 0 ? <Badge label={String(activeCount)} tone="blue" /> : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceSort")}
          style={({ pressed }) => [styles.filtersButton, pressed && styles.pressed]}
          onPress={() => setSortOpen(true)}
        >
          <Icon color="text" name="sort" size={18} />
          <Text style={styles.filtersButtonText}>{t("marketplaceSort")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceFinanceOnly")}
          accessibilityState={{ selected: fields.financeOnly }}
          style={({ pressed }) => [styles.chip, fields.financeOnly && styles.chipActive, pressed && styles.pressed]}
          onPress={() => applyFields({ ...fields, financeOnly: !fields.financeOnly })}
        >
          <Text style={[styles.chipText, fields.financeOnly && styles.chipTextActive]}>
            {t("marketplaceFinanceOnly")}
          </Text>
        </Pressable>
      </View>

      {savedSearches.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.savedSearchRow, { direction: textDirection }]}
        >
          {savedSearches.map((entry) => (
            <View key={entry.id} style={styles.savedSearchChip}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={entry.label}
                style={({ pressed }) => [styles.savedSearchChipMain, pressed && styles.pressed]}
                onPress={() => handleApplySaved(entry)}
              >
                <Icon color="primary" name="search" size={13} />
                <Text numberOfLines={1} style={styles.savedSearchChipText}>{entry.label}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("marketplaceRemoveSearch")}
                style={({ pressed }) => [styles.savedSearchRemove, pressed && styles.pressed]}
                onPress={() => void handleRemoveSaved(entry.id)}
              >
                <Icon color="mutedText" name="close" size={13} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {cursors.map((cursor, index) => (
        <CarsResultsPage
          key={`${searchKey}-${index}`}
          filters={filters}
          cursor={cursor}
          isFirst={index === 0}
          isLast={index === cursors.length - 1}
          onLoadMore={(nextCursor) => setCursors((previous) => [...previous, nextCursor])}
          onTradeInPress={onTradeInPress}
        />
      ))}

      <Modal
        visible={sheetOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheetOpen(false)}
      >
        <Screen>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={[styles.sheetHeader, { direction: textDirection }]}>
              <Text style={styles.sheetTitle}>{t("marketplaceFilters")}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("close")}
                style={({ pressed }) => [styles.sheetClose, pressed && styles.pressed]}
                onPress={() => setSheetOpen(false)}
              >
                <Icon color="text" name="close" size={20} />
              </Pressable>
            </View>
            <SearchPanel
              fields={fields}
              setFields={setFields}
              onSearch={() => {
                applyFields(fields);
                setSheetOpen(false);
              }}
              onReset={() => applyFields(DEFAULT_FIELDS)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: activeCount === 0 }}
              disabled={activeCount === 0}
              style={({ pressed }) => [
                styles.saveSearchButton,
                activeCount === 0 && styles.disabledButton,
                pressed && styles.pressed,
              ]}
              onPress={() => void handleSaveSearch()}
            >
              <Icon color="primary" name="save" size={16} />
              <Text style={styles.saveSearchButtonText}>{t("marketplaceSaveSearch")}</Text>
            </Pressable>
          </ScrollView>
        </Screen>
      </Modal>

      <Modal
        visible={sortOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSortOpen(false)}
      >
        <Screen>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={[styles.sheetHeader, { direction: textDirection }]}>
              <Text style={styles.sheetTitle}>{t("marketplaceSortTitle")}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("close")}
                style={({ pressed }) => [styles.sheetClose, pressed && styles.pressed]}
                onPress={() => setSortOpen(false)}
              >
                <Icon color="text" name="close" size={20} />
              </Pressable>
            </View>
            <View style={[styles.sortList, { direction: textDirection }]}>
              {SORT_OPTIONS.map((option) => {
                const selected = fields.sortBy === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [styles.sortRow, selected && styles.sortRowActive, pressed && styles.pressed]}
                    onPress={() => {
                      applyFields({ ...fields, sortBy: option.value });
                      setSortOpen(false);
                    }}
                  >
                    <Text style={[styles.sortRowText, selected && styles.sortRowTextActive]}>{t(option.labelKey)}</Text>
                    {selected ? <Icon color="primary" name="check" size={18} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </Screen>
      </Modal>
    </View>
  );
}

function DealerCard({
  dealer,
  onTradeInPress,
}: Readonly<{
  dealer: MobileMarketplaceDealer;
  onTradeInPress: (dealer: TradeInDealerTarget) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();

  return (
    <View style={[styles.dealerCard, { direction: textDirection }]}>
      <View style={styles.dealerTopRow}>
        <View style={styles.dealerLogo}>
          {dealer.logoUrl ? (
            <Image source={{ uri: dealer.logoUrl }} style={styles.dealerLogoImage} resizeMode="cover" />
          ) : (
            <Text style={styles.dealerLogoText}>AF</Text>
          )}
        </View>
        <View style={styles.dealerText}>
          <Text style={styles.cardTitle}>{dealer.dealershipName}</Text>
          {dealer.address ? <Text style={styles.cardMeta}>{dealer.address}</Text> : null}
          <Text style={styles.cardMeta}>
            {formatNumber(dealer.activeVehicleCount, locale)} {t("marketplaceVehiclesAvailable")}
          </Text>
        </View>
      </View>
      <View style={styles.badgeRow}>
        {dealer.badges.includes("VERIFIED_PHONE") ? (
          <Badge label={t("marketplaceVerifiedDealer")} tone="blue" />
        ) : null}
        {dealer.badges.includes("FAST_RESPONSE") ? (
          <Badge label={t("marketplaceFastResponse")} tone="amber" />
        ) : null}
        {dealer.badges.includes("FINANCE_AVAILABLE") ? (
          <Badge label={t("marketplaceFinanceAvailable")} />
        ) : null}
      </View>
      <View style={styles.actionRow}>
        {dealer.siteUrl ? (
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={() => openExternalUrl(dealer.siteUrl)}
          >
            <Text style={styles.primaryButtonText}>{t("marketplaceOpenListing")}</Text>
          </Pressable>
        ) : null}
        {dealer.phone ? (
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            onPress={() => openExternalUrl(`tel:${dealer.phone}`)}
          >
            <Text style={styles.secondaryButtonText}>{t("marketplaceCallDealer")}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => onTradeInPress(dealer)}
        >
          <Text style={styles.secondaryButtonText}>{t("marketplaceRequestTradeIn")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function DealersPanel({ onTradeInPress }: Readonly<{ onTradeInPress: (dealer: TradeInDealerTarget) => void }>) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useLocale();
  const dealers = useQuery(api.marketplaceDealers.listPublicDirectory, {});

  if (dealers === undefined) {
    return <RouteLoadingState label={t("marketplaceLoadingDealers")} />;
  }

  if (dealers.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceDealersEmpty")}</Text>;
  }

  return (
    <View style={styles.panelGap}>
      {dealers.map((dealer) => (
        <DealerCard key={dealer.orgId} dealer={dealer} onTradeInPress={onTradeInPress} />
      ))}
    </View>
  );
}

export function MarketplaceScreen({
  variant = "full",
  embedded = false,
  onRequestTradeIn,
  onOpenRequest,
}: Readonly<{
  variant?: MarketplaceVariant;
  embedded?: boolean;
  onRequestTradeIn?: () => void;
  onOpenRequest?: () => void;
}> = {}) {
  const styles = useThemedStyles(makeStyles);
  const { textDirection } = useLocale();
  const visibleTabs = getVariantTabs(variant);
  const [activeTab, setActiveTab] = useState<BuyerTab>(() => getVariantInitialTab(variant));
  const [selectedTradeInDealer, setSelectedTradeInDealer] = useState<TradeInDealerTarget | null>(null);
  const [openRoomPublicId, setOpenRoomPublicId] = useState<string | null>(null);
  const [offersReloadToken, setOffersReloadToken] = useState(0);

  // The buyer shell swaps browse↔request into the same tree slot, so React
  // reuses this component instance and keeps the old activeTab. Without this,
  // arriving on Request with a stale "cars" tab falls through to the Browse
  // car list. Reset to the variant's first tab whenever the variant changes.
  useEffect(() => {
    setActiveTab(getVariantInitialTab(variant));
  }, [variant]);

  function openTradeInForDealer(dealer: TradeInDealerTarget) {
    // In the Browse tab there is no trade-in sub-tab; hand off to the shell so it
    // switches to the Request tab (dealer selection is re-made in that form).
    if (onRequestTradeIn && !visibleTabs.includes("tradein")) {
      onRequestTradeIn();
      return;
    }
    setSelectedTradeInDealer(dealer);
    setActiveTab("tradein");
  }

  function openRoom(publicId: string) {
    setOpenRoomPublicId(publicId);
  }

  // The buyer-shell Browse tab has no in-screen Request tab, so hand off to the
  // shell (it switches to the Request bottom tab); the dealer "full" variant
  // switches its own inline tab.
  function openRequest() {
    if (onOpenRequest && !visibleTabs.includes("request")) {
      onOpenRequest();
      return;
    }
    setActiveTab("request");
  }

  async function handleRequestSubmitted(request: SavedBuyerRequest) {
    await saveBuyerRequest(request);
    setOffersReloadToken((value) => value + 1);
    setActiveTab("offers");
    setOpenRoomPublicId(request.publicId);
  }

  const wrap = (node: ReactNode): ReactNode => (embedded ? node : <Screen>{node}</Screen>);

  // A Request Room is a full-screen takeover so the buyer stays focused on the
  // offers streaming in; backing out returns to whichever tab they were on.
  if (openRoomPublicId) {
    return wrap(
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { direction: textDirection }]}>
        <RequestRoomScreen
          publicId={openRoomPublicId}
          onBack={() => {
            setOpenRoomPublicId(null);
            setOffersReloadToken((value) => value + 1);
          }}
        />
      </ScrollView>,
    );
  }

  let content: ReactNode;
  if (activeTab === "request") {
    content = <BuyerRequestPanel onRequestSubmitted={handleRequestSubmitted} />;
  } else if (activeTab === "tradein") {
    content = (
      <TradeInRequestPanel
        selectedDealer={selectedTradeInDealer}
        onSelectDealer={setSelectedTradeInDealer}
        onClearDealer={() => setSelectedTradeInDealer(null)}
      />
    );
  } else if (activeTab === "dealers") {
    content = <DealersPanel onTradeInPress={openTradeInForDealer} />;
  } else if (activeTab === "offers") {
    content = <OffersTab reloadToken={offersReloadToken} onOpenRoom={openRoom} />;
  } else {
    content = <CarsPanel onTradeInPress={openTradeInForDealer} onRequest={openRequest} />;
  }

  return wrap(
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { direction: textDirection }]}>
      <Header showAccount={!embedded} />
      <TabBar activeTab={activeTab} onChange={setActiveTab} visibleTabs={visibleTabs} />
      {content}
    </ScrollView>,
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: theme.spacing.lg,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.md,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  brand: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  title: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: "700",
    lineHeight: 36,
  },
  subtitle: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
  },
  secondaryIconButton: {
    minWidth: 58,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  secondaryIconText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  tabsScroll: {
    flexGrow: 0,
  },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.xs,
  },
  tab: {
    flexShrink: 0,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.xs,
  },
  tabSelected: {
    backgroundColor: theme.colors.surface,
  },
  tabText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  tabTextSelected: {
    color: theme.colors.text,
  },
  panelGap: {
    gap: theme.spacing.md,
  },
  requestHero: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.hero,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  requestHeroIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  requestHeroText: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  requestHeroTitle: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  requestHeroBody: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: "500",
    opacity: 0.9,
  },
  requestHeroCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  requestHeroCtaText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "800",
  },
  browseBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  filtersButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    minHeight: 44,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  filtersButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  chipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  chipText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    fontWeight: "700",
  },
  chipTextActive: {
    color: theme.colors.primaryDark,
  },
  savedSearchRow: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  savedSearchChip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 260,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  savedSearchChipMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    flexShrink: 1,
    paddingStart: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  savedSearchChipText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
    flexShrink: 1,
  },
  savedSearchRemove: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  saveSearchButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
    paddingHorizontal: theme.spacing.md,
  },
  saveSearchButtonText: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: "800",
  },
  sheetContent: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "800",
  },
  sheetHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  sheetClose: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  detailContent: {
    paddingBottom: theme.spacing.xxl,
  },
  detailDealer: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.mutedText,
    fontSize: 14,
    fontWeight: "700",
    paddingHorizontal: theme.spacing.lg,
  },
  gallery: {
    width: "100%",
    aspectRatio: 4 / 3,
    backgroundColor: theme.colors.surfaceAlt,
  },
  galleryImage: {
    width: 720,
    height: "100%",
  },
  galleryEmpty: {
    width: "100%",
    aspectRatio: 4 / 3,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  detailBody: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  detailTitle: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 30,
  },
  detailPrice: {
    color: theme.colors.primary,
    fontSize: 26,
    fontWeight: "900",
  },
  detailMonthly: {
    color: theme.colors.mutedText,
    fontSize: 15,
    fontWeight: "600",
  },
  chipGroup: {
    gap: theme.spacing.sm,
  },
  chipGroupLabel: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  chipGroupRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  sortList: {
    gap: theme.spacing.sm,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 52,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  sortRowActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  sortRowText: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  sortRowTextActive: {
    color: theme.colors.primary,
  },
  specSection: {
    gap: theme.spacing.sm,
  },
  specSectionTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "800",
  },
  similarSection: {
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  similarRow: {
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  similarCard: {
    width: 168,
    gap: 4,
  },
  similarImageWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceAlt,
  },
  similarImage: {
    width: "100%",
    height: "100%",
  },
  similarTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  similarPrice: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "800",
  },
  similarMonthly: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  specGrid: {
    gap: theme.spacing.sm,
  },
  specRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  specLabel: {
    color: theme.colors.mutedText,
    fontSize: 14,
    fontWeight: "700",
  },
  specValue: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  detailPrimaryAction: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  detailPrimaryActionActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  detailPrimaryActionText: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "800",
  },
  detailPrimaryActionTextActive: {
    color: theme.colors.onPrimary,
  },
  contactBar: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  contactBarInline: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  contactButton: {
    minHeight: 48,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
  },
  contactButtonCall: {
    backgroundColor: theme.colors.primary,
  },
  // WhatsApp brand green — kept literal (not a theme token) so the button reads
  // as WhatsApp in both light and dark, matching how buyers expect it to look.
  contactButtonWhatsapp: {
    backgroundColor: "#25D366",
  },
  contactButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 15,
    fontWeight: "800",
  },
  searchPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  formGrid: {
    gap: theme.spacing.md,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  switchText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  primaryButton: {
    minHeight: 44,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
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
    minHeight: 44,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  disabledButton: {
    opacity: 0.46,
  },
  resultsBlock: {
    gap: theme.spacing.md,
  },
  vehicleCard: {
    overflow: "hidden",
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    ...theme.shadows.sm,
  },
  vehicleImageWrap: {
    aspectRatio: 16 / 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  vehicleImage: {
    width: "100%",
    height: "100%",
  },
  noImageText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "600",
  },
  saveButton: {
    position: "absolute",
    top: theme.spacing.md,
    end: theme.spacing.md,
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    ...theme.shadows.sm,
  },
  saveButtonActive: {
    backgroundColor: theme.colors.primary,
  },
  priceBadge: {
    position: "absolute",
    bottom: theme.spacing.md,
    left: theme.spacing.md,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.hero,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  priceBadgeText: {
    color: theme.colors.onPrimary,
    fontSize: 15,
    fontWeight: "700",
  },
  photoCountBadge: {
    position: "absolute",
    bottom: theme.spacing.md,
    end: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.full,
    // Translucent charcoal so it reads over any photo, in either theme.
    backgroundColor: "rgba(17, 24, 39, 0.72)",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
  },
  photoCountText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  cardBody: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 24,
  },
  cardMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  priceText: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  badge: {
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.successSoft,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  amberBadge: {
    backgroundColor: theme.colors.warningSoft,
  },
  blueBadge: {
    backgroundColor: theme.colors.infoSoft,
  },
  badgeText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "600",
  },
  factList: {
    gap: theme.spacing.xs,
  },
  factText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  inlineButton: {
    minHeight: 40,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
  },
  inlineButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  dealerCard: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  dealerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  dealerLogo: {
    width: 48,
    height: 48,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dealerLogoImage: {
    width: "100%",
    height: "100%",
  },
  dealerLogoText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  dealerText: {
    flex: 1,
    minWidth: 0,
  },
  lookupPanel: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  statusResult: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  statusTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21,
  },
  successText: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
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
