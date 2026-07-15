import { nativeRoutes } from "@autoflow/shared";
import { useAuth } from "@clerk/expo";
import { UserButton } from "@clerk/expo/native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  api,
  type MobileMarketplaceRequestRow,
  type MobileMarketplaceResponseKind,
  type MobileMarketplaceTradeInRow,
  type MobileOrgSummary,
  type MobileVehiclePickerItem,
} from "../../convexApi";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  formatMoney,
  formatNumber,
  getBuyerIntentKey,
  getPaymentTypeKey,
  getResponseKindKey,
  getTradeInConditionKey,
  getTradeInStatusKey,
  parseOptionalPositiveNumber,
} from "./marketplaceUtils";

type DealerTab = "requests" | "tradeins";

const RESPONSE_KINDS: MobileMarketplaceResponseKind[] = [
  "HAVE_MATCH",
  "HAVE_SIMILAR",
  "CAN_SOURCE",
  "NOT_AVAILABLE",
];

function getSafeOrgs(orgs: Array<MobileOrgSummary | null> | undefined): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

function Header({ org }: Readonly<{ org: MobileOrgSummary }>) {
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.header, { direction: textDirection }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("back")}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        onPress={() =>
          router.replace({
            pathname: nativeRoutes.orgHome,
            params: { orgId: org._id },
          })
        }
      >
        <Icon color="text" name="back" size={22} />
      </Pressable>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text numberOfLines={1} style={styles.title}>
          {t("dealerMarketplace")}
        </Text>
        <Text numberOfLines={1} style={styles.subtitle}>
          {org.name || t("untitledWorkspace")}
        </Text>
      </View>
      <UserButton />
    </View>
  );
}

function TabBar({
  activeTab,
  onChange,
}: Readonly<{ activeTab: DealerTab; onChange: (tab: DealerTab) => void }>) {
  const { t, textDirection } = useLocale();
  const tabs: Array<{ value: DealerTab; label: string }> = [
    { value: "requests", label: t("marketplaceDealerInboxTab") },
    { value: "tradeins", label: t("marketplaceTradeInsTab") },
  ];

  return (
    <View style={[styles.tabs, { direction: textDirection }]}>
      {tabs.map((tab) => {
        const selected = activeTab === tab.value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.tab,
              selected && styles.tabSelected,
              pressed && styles.pressed,
            ]}
            onPress={() => onChange(tab.value)}
          >
            <Text style={[styles.tabText, selected && styles.tabTextSelected]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Pill({
  label,
  tone = "slate",
}: Readonly<{ label: string; tone?: "green" | "amber" | "rose" | "slate" }>) {
  return (
    <View
      style={[
        styles.pill,
        tone === "green" && styles.greenPill,
        tone === "amber" && styles.amberPill,
        tone === "rose" && styles.rosePill,
      ]}
    >
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

function RequestCard({
  orgId,
  request,
  openRequestId,
  onToggle,
}: Readonly<{
  orgId: string;
  request: MobileMarketplaceRequestRow;
  openRequestId: string | null;
  onToggle: (requestId: string | null) => void;
}>) {
  const { locale, t, textDirection } = useLocale();
  const isOpen = openRequestId === request.requestId;
  const vehicleLabel = [request.make, request.model].filter(Boolean).join(" ") || t("marketplaceVehicle");
  const priceRange =
    request.priceMin != null || request.priceMax != null
      ? `${formatMoney(request.priceMin, locale) ?? "..."} - ${formatMoney(request.priceMax, locale) ?? "..."}`
      : null;

  return (
    <View style={[styles.card, { direction: textDirection }]}>
      <View style={styles.cardTopRow}>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{request.buyerFirstName}</Text>
          <Text style={styles.cardMeta}>
            {vehicleLabel} · {request.buyerCity} · {t(getPaymentTypeKey(request.paymentType))}
          </Text>
          {priceRange ? <Text style={styles.cardMeta}>{priceRange}</Text> : null}
        </View>
        <Pill
          label={t(getBuyerIntentKey(request.buyerIntent))}
          tone={request.buyerIntent === "HOT" ? "rose" : request.buyerIntent === "WARM" ? "amber" : "slate"}
        />
      </View>
      {request.latestResponse ? (
        <Pill label={t("marketplaceAlreadyResponded")} tone="green" />
      ) : (
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => onToggle(isOpen ? null : request.requestId)}
        >
          <Text style={styles.secondaryButtonText}>{t("marketplaceRespond")}</Text>
        </Pressable>
      )}
      {isOpen ? <ResponseForm orgId={orgId} requestId={request.requestId} onSaved={() => onToggle(null)} /> : null}
    </View>
  );
}

function VehicleOption({
  vehicle,
  selected,
  onSelect,
}: Readonly<{
  vehicle: MobileVehiclePickerItem;
  selected: boolean;
  onSelect: () => void;
}>) {
  const { locale } = useLocale();
  const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");

  return (
    <Pressable
      style={({ pressed }) => [
        styles.vehicleOption,
        selected && styles.vehicleOptionSelected,
        pressed && styles.pressed,
      ]}
      onPress={onSelect}
    >
      <Text style={[styles.vehicleOptionText, selected && styles.vehicleOptionTextSelected]}>{label}</Text>
      {vehicle.sellingPrice != null ? (
        <Text style={styles.vehicleOptionMeta}>{formatMoney(vehicle.sellingPrice, locale)}</Text>
      ) : null}
    </Pressable>
  );
}

function ResponseForm({
  orgId,
  requestId,
  onSaved,
}: Readonly<{
  orgId: string;
  requestId: string;
  onSaved: () => void;
}>) {
  const { isRtl, t } = useLocale();
  const respond = useMutation(api.marketplaceResponses.respond);
  const [kind, setKind] = useState<MobileMarketplaceResponseKind>("HAVE_MATCH");
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [offerPrice, setOfferPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const showOfferFields = kind !== "NOT_AVAILABLE";
  const vehiclesPage = useQuery(
    api.vehicles.list,
    showOfferFields
      ? {
          orgId,
          status: "AVAILABLE",
          paginationOpts: { numItems: 30, cursor: null },
        }
      : "skip",
  );
  const parsedOffer = parseOptionalPositiveNumber(offerPrice);

  async function submit() {
    setSaving(true);
    try {
      await respond({
        orgId,
        requestId,
        kind,
        vehicleId: showOfferFields && vehicleId ? vehicleId : undefined,
        offerPriceJod: showOfferFields ? parsedOffer : undefined,
        note: note.trim() || undefined,
      });
      Alert.alert("AutoFlow", t("marketplaceResponseSaved"));
      onSaved();
    } catch (error) {
      console.error("Failed to save marketplace response", error);
      Alert.alert("AutoFlow", t("marketplaceSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.inlineForm}>
      <Text style={styles.formLabel}>{t("marketplaceResponseKind")}</Text>
      <View style={styles.optionGrid}>
        {RESPONSE_KINDS.map((option) => {
          const selected = option === kind;
          return (
            <Pressable
              key={option}
              style={({ pressed }) => [
                styles.optionButton,
                selected && styles.optionButtonSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => setKind(option)}
            >
              <Text style={[styles.optionButtonText, selected && styles.optionButtonTextSelected]}>
                {t(getResponseKindKey(option))}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {showOfferFields ? (
        <>
          <Text style={styles.formLabel}>{t("marketplaceVehicle")}</Text>
          <VehicleOption
            vehicle={{ _id: "", year: 0, make: t("marketplaceNoVehicle"), model: "", status: "AVAILABLE" }}
            selected={!vehicleId}
            onSelect={() => setVehicleId(null)}
          />
          {vehiclesPage === undefined ? <RouteLoadingState label={t("loadingWorkspace")} /> : null}
          {vehiclesPage?.page.map((vehicle) => (
            <VehicleOption
              key={vehicle._id}
              vehicle={vehicle}
              selected={vehicleId === vehicle._id}
              onSelect={() => setVehicleId(vehicle._id)}
            />
          ))}

          <Text style={styles.formLabel}>{t("marketplaceOfferPrice")}</Text>
          <TextInput
            value={offerPrice}
            onChangeText={setOfferPrice}
            keyboardType="number-pad"
            style={[styles.input, { textAlign: isRtl ? "right" : "left" }]}
          />
        </>
      ) : null}

      <Text style={styles.formLabel}>{t("marketplaceNote")}</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        multiline
        style={[styles.input, styles.noteInput, { textAlign: isRtl ? "right" : "left" }]}
      />

      <Pressable
        disabled={saving}
        style={({ pressed }) => [styles.primaryButton, saving && styles.disabledButton, pressed && styles.pressed]}
        onPress={submit}
      >
        <Text style={styles.primaryButtonText}>{t("marketplaceSendResponse")}</Text>
      </Pressable>
    </View>
  );
}

function RequestsTab({ orgId }: Readonly<{ orgId: string }>) {
  const { t } = useLocale();
  const requests = useQuery(api.marketplaceResponses.listForOrg, { orgId });
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);

  if (requests === undefined) {
    return <RouteLoadingState label={t("dashboardLoading")} />;
  }

  if (requests.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceNoRequests")}</Text>;
  }

  return (
    <View style={styles.listGap}>
      {requests.map((request) => (
        <RequestCard
          key={request.requestId}
          orgId={orgId}
          request={request}
          openRequestId={openRequestId}
          onToggle={setOpenRequestId}
        />
      ))}
    </View>
  );
}

function TradeInCard({
  orgId,
  tradeIn,
}: Readonly<{ orgId: string; tradeIn: MobileMarketplaceTradeInRow }>) {
  const { locale, t, textDirection } = useLocale();
  const makeOffer = useMutation(api.marketplaceTradeIns.makeOffer);
  const [expanded, setExpanded] = useState(false);
  const [offerAmount, setOfferAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const parsedOffer = parseOptionalPositiveNumber(offerAmount);

  async function submitOffer() {
    if (parsedOffer === undefined) return;
    setSaving(true);
    try {
      await makeOffer({ orgId, tradeInRequestId: tradeIn._id, offerAmountJod: parsedOffer });
      Alert.alert("AutoFlow", t("marketplaceOfferSaved"));
      setExpanded(false);
    } catch (error) {
      console.error("Failed to save trade-in offer", error);
      Alert.alert("AutoFlow", t("marketplaceSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.card, { direction: textDirection }]}>
      <View style={styles.cardTopRow}>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{tradeIn.buyerFirstName}</Text>
          <Text style={styles.cardMeta}>
            {tradeIn.currentYear} {tradeIn.currentMake} {tradeIn.currentModel}
          </Text>
          <Text style={styles.cardMeta}>
            {formatNumber(tradeIn.currentMileage, locale)} km · {t(getTradeInConditionKey(tradeIn.condition))}
          </Text>
        </View>
        <Pill label={t(getTradeInStatusKey(tradeIn.status))} tone={tradeIn.status === "PENDING" ? "amber" : "green"} />
      </View>
      {tradeIn.offerAmountJod != null ? (
        <Text style={styles.priceText}>{formatMoney(tradeIn.offerAmountJod, locale)}</Text>
      ) : null}
      {tradeIn.notes ? <Text style={styles.cardMeta}>{tradeIn.notes}</Text> : null}
      {tradeIn.status === "PENDING" ? (
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => setExpanded((value) => !value)}
        >
          <Text style={styles.secondaryButtonText}>{t("marketplaceMakeOffer")}</Text>
        </Pressable>
      ) : null}
      {expanded ? (
        <View style={styles.inlineForm}>
          <Text style={styles.formLabel}>{t("marketplaceOfferAmount")}</Text>
          <TextInput
            value={offerAmount}
            onChangeText={setOfferAmount}
            keyboardType="number-pad"
            style={styles.input}
          />
          <Pressable
            disabled={saving || parsedOffer === undefined}
            style={({ pressed }) => [
              styles.primaryButton,
              (saving || parsedOffer === undefined) && styles.disabledButton,
              pressed && styles.pressed,
            ]}
            onPress={submitOffer}
          >
            <Text style={styles.primaryButtonText}>{t("marketplaceMakeOffer")}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function TradeInsTab({ orgId }: Readonly<{ orgId: string }>) {
  const { t } = useLocale();
  const tradeIns = useQuery(api.marketplaceTradeIns.listForOrg, { orgId });

  if (tradeIns === undefined) {
    return <RouteLoadingState label={t("dashboardLoading")} />;
  }

  if (tradeIns.length === 0) {
    return <Text style={styles.emptyText}>{t("marketplaceNoTradeIns")}</Text>;
  }

  return (
    <View style={styles.listGap}>
      {tradeIns.map((tradeIn) => (
        <TradeInCard key={tradeIn._id} orgId={orgId} tradeIn={tradeIn} />
      ))}
    </View>
  );
}

function InaccessibleState() {
  const router = useRouter();
  const { t, textDirection } = useLocale();

  return (
    <View style={[styles.emptyState, { direction: textDirection }]}>
      <Text style={styles.emptyTitle}>{t("inaccessibleWorkspaceTitle")}</Text>
      <Text style={styles.cardMeta}>{t("inaccessibleWorkspaceBody")}</Text>
      <Pressable
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        onPress={() => router.replace(nativeRoutes.home)}
      >
        <Text style={styles.primaryButtonText}>{t("back")}</Text>
      </Pressable>
    </View>
  );
}

export function DealerMarketplaceScreen({ orgId }: Readonly<{ orgId: string | null }>) {
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const canQuery = isLoaded && isSignedIn && !convexAuthLoading && isAuthenticated && Boolean(orgId);
  const orgs = useQuery(api.organizations.listMine, canQuery ? {} : "skip");
  const safeOrgs = useMemo(() => getSafeOrgs(orgs), [orgs]);
  const selectedOrg = safeOrgs.find((org) => org._id === orgId) ?? null;
  const [activeTab, setActiveTab] = useState<DealerTab>("requests");

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace(nativeRoutes.signIn);
    }
  }, [isLoaded, isSignedIn, router]);

  if (!orgId || !isLoaded || convexAuthLoading || !isSignedIn || !isAuthenticated) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingSession")} />
      </Screen>
    );
  }

  if (orgs === undefined) {
    return (
      <Screen>
        <RouteLoadingState label={t("loadingWorkspace")} />
      </Screen>
    );
  }

  if (!selectedOrg) {
    return (
      <Screen>
        <InaccessibleState />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { direction: textDirection }]}>
        <Header org={selectedOrg} />
        <TabBar activeTab={activeTab} onChange={setActiveTab} />
        {activeTab === "requests" ? <RequestsTab orgId={selectedOrg._id} /> : <TradeInsTab orgId={selectedOrg._id} />}
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
    alignItems: "center",
    gap: theme.spacing.md,
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
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  brand: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  title: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 30,
  },
  subtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.xs,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  tabSelected: {
    backgroundColor: theme.colors.surface,
  },
  tabText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "800",
  },
  tabTextSelected: {
    color: theme.colors.text,
  },
  listGap: {
    gap: theme.spacing.md,
  },
  card: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
    lineHeight: 24,
  },
  cardMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  priceText: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  pill: {
    maxWidth: 132,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  greenPill: {
    backgroundColor: theme.colors.successSoft,
  },
  amberPill: {
    backgroundColor: theme.colors.warningSoft,
  },
  rosePill: {
    backgroundColor: theme.colors.dangerSoft,
  },
  pillText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "900",
    textAlign: "center",
  },
  secondaryButton: {
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
  },
  primaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
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
  inlineForm: {
    gap: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.md,
  },
  formLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "900",
  },
  optionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  optionButton: {
    minHeight: 38,
    minWidth: "47%",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  optionButtonSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  optionButtonText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  optionButtonTextSelected: {
    color: theme.colors.text,
  },
  vehicleOption: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.sm,
  },
  vehicleOptionSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  vehicleOptionText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  vehicleOptionTextSelected: {
    color: theme.colors.primary,
  },
  vehicleOptionMeta: {
    color: theme.colors.mutedText,
    fontSize: 12,
  },
  input: {
    minHeight: 44,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
  },
  noteInput: {
    minHeight: 82,
    paddingVertical: theme.spacing.sm,
    textAlignVertical: "top",
  },
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingVertical: theme.spacing.lg,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "900",
  },
  pressed: {
    opacity: 0.82,
  },
});
