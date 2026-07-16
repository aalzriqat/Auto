import { nativeRoutes } from "@autoflow/shared";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
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
  type MobileMarketplaceVehicle,
} from "../../convexApi";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { SearchableSelectField } from "../../components/SearchableSelectField";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  BuyerRequestPanel,
  TradeInRequestPanel,
  type TradeInDealerTarget,
} from "./BuyerIntakePanels";
import {
  formatMoney,
  formatNumber,
  getListingUrl,
  getRequestStatusKey,
  getTradeInStatusKey,
  getVehicleTitle,
  parseOptionalPositiveNumber,
  trimOrUndefined,
} from "./marketplaceUtils";
import { getMarketplaceSelectOptions } from "./marketplaceSelectOptions";

type BuyerTab = "cars" | "request" | "tradein" | "dealers" | "status";

type SearchFields = {
  make: string;
  city: string;
  priceMin: string;
  priceMax: string;
  maxMonthlyPayment: string;
  financeOnly: boolean;
};

type SearchFilters = {
  make?: string;
  city?: string;
  priceMin?: number;
  priceMax?: number;
  maxMonthlyPayment?: number;
  paymentType?: MobileMarketplacePaymentFilter;
  numItems: number;
};

const DEFAULT_FIELDS: SearchFields = {
  make: "",
  city: "",
  priceMin: "",
  priceMax: "",
  maxMonthlyPayment: "",
  financeOnly: false,
};

function buildSearchFilters(fields: SearchFields): SearchFilters {
  return {
    make: trimOrUndefined(fields.make),
    city: trimOrUndefined(fields.city),
    priceMin: parseOptionalPositiveNumber(fields.priceMin),
    priceMax: parseOptionalPositiveNumber(fields.priceMax),
    maxMonthlyPayment: parseOptionalPositiveNumber(fields.maxMonthlyPayment),
    paymentType: fields.financeOnly ? "FINANCE" : undefined,
    numItems: 12,
  };
}

function openExternalUrl(url: string | null) {
  if (!url) return;
  Linking.openURL(url).catch((error: unknown) => {
    console.error("Failed to open marketplace link", error);
    Alert.alert("AutoFlow", "Unable to open this link right now.");
  });
}

function Header() {
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text style={styles.title}>{t("marketplaceTitle")}</Text>
        <Text style={styles.subtitle}>{t("marketplaceSubtitle")}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("home")}
        style={({ pressed }) => [styles.secondaryIconButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.home)}
      >
        <Icon color="primary" name="dashboard" size={18} />
        <Text style={styles.secondaryIconText}>{t("home")}</Text>
      </Pressable>
    </View>
  );
}

function TabBar({ activeTab, onChange }: { activeTab: BuyerTab; onChange: (tab: BuyerTab) => void }) {
  const { t, textDirection } = useLocale();
  const { width } = useWindowDimensions();
  const tabs: Array<{ value: BuyerTab; label: string }> = [
    { value: "cars", label: t("marketplaceCarsTab") },
    { value: "request", label: t("marketplaceRequestCarTab") },
    { value: "tradein", label: t("marketplaceTradeInBuyerTab") },
    { value: "dealers", label: t("marketplaceDealersTab") },
    { value: "status", label: t("marketplaceStatusTab") },
  ];
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
  return (
    <View style={[styles.badge, tone === "amber" && styles.amberBadge, tone === "blue" && styles.blueBadge]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

function TrustFacts({ vehicle }: Readonly<{ vehicle: MobileMarketplaceVehicle }>) {
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

function VehicleCard({
  vehicle,
  onTradeInPress,
}: Readonly<{
  vehicle: MobileMarketplaceVehicle;
  onTradeInPress: (dealer: TradeInDealerTarget) => void;
}>) {
  const { locale, t, textDirection } = useLocale();
  const title = getVehicleTitle(vehicle);
  const listingUrl = getListingUrl(vehicle);
  const price = formatMoney(vehicle.price, locale);
  const monthly = formatMoney(vehicle.estimatedMonthlyPayment, locale);

  return (
    <View style={[styles.vehicleCard, { direction: textDirection }]}>
      <View style={styles.vehicleImageWrap}>
        {vehicle.imageUrls[0] ? (
          <Image source={{ uri: vehicle.imageUrls[0] }} style={styles.vehicleImage} resizeMode="cover" />
        ) : (
          <Text style={styles.noImageText}>{t("marketplaceNoImage")}</Text>
        )}
        {price ? (
          <View style={styles.priceBadge}>
            <Text style={styles.priceBadgeText}>{price}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle}>{title}</Text>
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
          {vehicle.financeAvailable ? <Badge label={t("marketplaceFinanceAvailable")} /> : null}
          {vehicle.dealerBadges.includes("VERIFIED_PHONE") ? (
            <Badge label={t("marketplaceVerifiedDealer")} tone="blue" />
          ) : null}
          {vehicle.dealerBadges.includes("FAST_RESPONSE") ? (
            <Badge label={t("marketplaceFastResponse")} tone="amber" />
          ) : null}
        </View>
        <TrustFacts vehicle={vehicle} />
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

function CarsPanel({ onTradeInPress }: Readonly<{ onTradeInPress: (dealer: TradeInDealerTarget) => void }>) {
  const [fields, setFields] = useState<SearchFields>(DEFAULT_FIELDS);
  const [searchKey, setSearchKey] = useState(0);
  const [filters, setFilters] = useState<SearchFilters>(() => buildSearchFilters(DEFAULT_FIELDS));
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  function applySearch() {
    setSearchKey((value) => value + 1);
    setFilters(buildSearchFilters(fields));
    setCursors([undefined]);
  }

  function resetSearch() {
    setFields(DEFAULT_FIELDS);
    setSearchKey((value) => value + 1);
    setFilters(buildSearchFilters(DEFAULT_FIELDS));
    setCursors([undefined]);
  }

  return (
    <View style={styles.panelGap}>
      <SearchPanel fields={fields} setFields={setFields} onSearch={applySearch} onReset={resetSearch} />
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

function StatusPanel() {
  const { locale, t, textDirection } = useLocale();
  const acceptOffer = useMutation(api.marketplaceTradeIns.acceptOfferByPublicId);
  const declineOffer = useMutation(api.marketplaceTradeIns.declineOfferByPublicId);
  const [requestId, setRequestId] = useState("");
  const [requestPhone, setRequestPhone] = useState("");
  const [submittedRequest, setSubmittedRequest] = useState<{ id: string; phone: string } | null>(null);
  const [tradeInId, setTradeInId] = useState("");
  const [tradeInPhone, setTradeInPhone] = useState("");
  const [submittedTradeIn, setSubmittedTradeIn] = useState<{ id: string; phone: string } | null>(null);
  const [offerUpdating, setOfferUpdating] = useState(false);
  const [offerMessage, setOfferMessage] = useState<string | null>(null);

  const requestStatus = useQuery(
    api.marketplaceRequests.getStatusForBuyerByPublicId,
    submittedRequest ? { requestId: submittedRequest.id, buyerPhone: submittedRequest.phone } : "skip",
  );
  const tradeInStatus = useQuery(
    api.marketplaceTradeIns.getStatusForBuyerByPublicId,
    submittedTradeIn
      ? { tradeInRequestId: submittedTradeIn.id, buyerPhone: submittedTradeIn.phone }
      : "skip",
  );

  const canCheckRequest = requestId.trim().length > 0 && requestPhone.trim().length > 0;
  const canCheckTradeIn = tradeInId.trim().length > 0 && tradeInPhone.trim().length > 0;

  async function updateTradeInOfferStatus(action: "accept" | "decline") {
    if (!submittedTradeIn) return;

    setOfferUpdating(true);
    setOfferMessage(null);
    try {
      const offerActionResult =
        action === "accept"
          ? await acceptOffer({
              tradeInRequestId: submittedTradeIn.id,
              buyerPhone: submittedTradeIn.phone,
            })
          : await declineOffer({
              tradeInRequestId: submittedTradeIn.id,
              buyerPhone: submittedTradeIn.phone,
            });

      if (!offerActionResult.success) {
        Alert.alert("AutoFlow", t("marketplaceOfferUpdateFailed"));
        return;
      }

      setOfferMessage(t("marketplaceOfferUpdated"));
    } catch (error) {
      console.error("Failed to update marketplace trade-in offer", error);
      Alert.alert("AutoFlow", t("marketplaceOfferUpdateFailed"));
    } finally {
      setOfferUpdating(false);
    }
  }

  return (
    <View style={[styles.panelGap, { direction: textDirection }]}>
      <View style={styles.lookupPanel}>
        <FormField label={t("marketplaceStatusRequestId")} value={requestId} onChangeText={setRequestId} />
        <FormField
          label={t("marketplaceStatusPhone")}
          value={requestPhone}
          onChangeText={setRequestPhone}
          keyboardType="phone-pad"
        />
        <Pressable
          disabled={!canCheckRequest}
          style={({ pressed }) => [
            styles.primaryButton,
            !canCheckRequest && styles.disabledButton,
            pressed && styles.pressed,
          ]}
          onPress={() => setSubmittedRequest({ id: requestId.trim(), phone: requestPhone.trim() })}
        >
          <Text style={styles.primaryButtonText}>{t("marketplaceStatusCheckRequest")}</Text>
        </Pressable>
        {submittedRequest && requestStatus === undefined ? (
          <RouteLoadingState label={t("marketplaceStatusCheckRequest")} />
        ) : null}
        {submittedRequest && requestStatus === null ? (
          <Text style={styles.emptyText}>{t("marketplaceStatusNotFound")}</Text>
        ) : null}
        {requestStatus ? (
          <View style={styles.statusResult}>
            <Text style={styles.statusTitle}>{t(getRequestStatusKey(requestStatus.status))}</Text>
            <Text style={styles.cardMeta}>
              {formatNumber(requestStatus.matchedCount, locale)} {t("marketplaceMatchedDealers")}
            </Text>
            <Text style={styles.cardMeta}>
              {formatNumber(requestStatus.respondedCount, locale)} {t("marketplaceDealerReplies")}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.lookupPanel}>
        <FormField label={t("marketplaceStatusTradeInId")} value={tradeInId} onChangeText={setTradeInId} />
        <FormField
          label={t("marketplaceStatusPhone")}
          value={tradeInPhone}
          onChangeText={setTradeInPhone}
          keyboardType="phone-pad"
        />
        <Pressable
          disabled={!canCheckTradeIn}
          style={({ pressed }) => [
            styles.primaryButton,
            !canCheckTradeIn && styles.disabledButton,
            pressed && styles.pressed,
          ]}
          onPress={() => {
            setOfferMessage(null);
            setSubmittedTradeIn({ id: tradeInId.trim(), phone: tradeInPhone.trim() });
          }}
        >
          <Text style={styles.primaryButtonText}>{t("marketplaceStatusCheckTradeIn")}</Text>
        </Pressable>
        {submittedTradeIn && tradeInStatus === undefined ? (
          <RouteLoadingState label={t("marketplaceStatusCheckTradeIn")} />
        ) : null}
        {submittedTradeIn && tradeInStatus === null ? (
          <Text style={styles.emptyText}>{t("marketplaceStatusNotFound")}</Text>
        ) : null}
        {tradeInStatus ? (
          <View style={styles.statusResult}>
            <Text style={styles.statusTitle}>{t(getTradeInStatusKey(tradeInStatus.status))}</Text>
            <Text style={styles.cardMeta}>
              {tradeInStatus.currentYear} {tradeInStatus.currentMake} {tradeInStatus.currentModel}
            </Text>
            {tradeInStatus.offerAmountJod != null ? (
              <Text style={styles.priceText}>
                {t("marketplaceOfferAmount")}: {formatMoney(tradeInStatus.offerAmountJod, locale)}
              </Text>
            ) : null}
            {tradeInStatus.status === "OFFERED" ? (
              <View style={styles.actionRow}>
                <Pressable
                  disabled={offerUpdating}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    offerUpdating && styles.disabledButton,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => void updateTradeInOfferStatus("accept")}
                >
                  <Text style={styles.primaryButtonText}>{t("marketplaceAcceptOffer")}</Text>
                </Pressable>
                <Pressable
                  disabled={offerUpdating}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    offerUpdating && styles.disabledButton,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => void updateTradeInOfferStatus("decline")}
                >
                  <Text style={styles.secondaryButtonText}>{t("marketplaceDeclineOffer")}</Text>
                </Pressable>
              </View>
            ) : null}
            {offerMessage ? <Text style={styles.successText}>{offerMessage}</Text> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function MarketplaceScreen() {
  const { textDirection } = useLocale();
  const [activeTab, setActiveTab] = useState<BuyerTab>("cars");
  const [selectedTradeInDealer, setSelectedTradeInDealer] = useState<TradeInDealerTarget | null>(null);

  function openTradeInForDealer(dealer: TradeInDealerTarget) {
    setSelectedTradeInDealer(dealer);
    setActiveTab("tradein");
  }

  let content: ReactNode;
  if (activeTab === "request") {
    content = <BuyerRequestPanel />;
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
  } else if (activeTab === "status") {
    content = <StatusPanel />;
  } else {
    content = <CarsPanel onTradeInPress={openTradeInForDealer} />;
  }

  return (
    <Screen>
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { direction: textDirection }]}>
        <Header />
        <TabBar activeTab={activeTab} onChange={setActiveTab} />
        {content}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
