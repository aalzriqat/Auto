import { useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { Image, ImageBackground, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { api, type MobileMarketplaceSearchResult, type MobileMarketplaceVehicle } from "../../convexApi";
import { Card } from "../../components/Card";
import { Icon, type SemanticIconName } from "../../components/Icon";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { getVehicleBrandChipOptions } from "../../data/mobileOptions";
import { getMakeLogo } from "../../data/makeLogos";
import {
  formatMoney,
  formatNumber,
  getVehicleTitle,
  isRecentlyListed,
} from "./marketplaceUtils";
import {
  isVehicleSaved,
  loadSavedVehicles,
  toggleSavedVehicle,
  type SavedVehicle,
} from "./savedVehiclesStore";

// Banner images and their intrinsic aspect ratios, read from the bundled asset
// so each banner renders the WHOLE image (no crop) at a height derived from the
// device width. Drop in a taller image and the hero/banner resizes to fit it —
// no code change needed. Falls back to 16:9 if the metadata is unavailable.
const HERO_SOURCE = require("../../../assets/brand/hero-bg.png");
const REQUEST_SOURCE = require("../../../assets/brand/request-bg.png");

function assetAspectRatio(source: number, fallback: number): number {
  const resolved = Image.resolveAssetSource(source);
  return resolved && resolved.width > 0 && resolved.height > 0
    ? resolved.width / resolved.height
    : fallback;
}

const HERO_ASPECT = assetAspectRatio(HERO_SOURCE, 16 / 9);
const REQUEST_ASPECT = assetAspectRatio(REQUEST_SOURCE, 16 / 9);

type QuickAction = Readonly<{
  key: string;
  icon: SemanticIconName;
  tone: "green" | "blue" | "purple" | "red";
  title: string;
  body: string;
  badge?: string;
  onPress: () => void;
}>;

export type MarketplaceHomeScreenProps = Readonly<{
  onOpenCars: (make?: string) => void;
  onOpenFavorites: () => void;
  onOpenFinancing: () => void;
  onOpenCompare: () => void;
  onOpenRequest: () => void;
}>;

// The buyer's storefront landing (الرئيسية). A search-first hero, one-tap brand
// shortcuts, quick actions, a live "latest offers" strip, the reverse-market
// request banner, and the trust promise. Every element hands off to a real
// destination via the props above — no dead ends.
export function MarketplaceHomeScreen({
  onOpenCars,
  onOpenFavorites,
  onOpenFinancing,
  onOpenCompare,
  onOpenRequest,
}: MarketplaceHomeScreenProps) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const [search, setSearch] = useState("");
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    let active = true;
    loadSavedVehicles()
      .then((list) => {
        if (active) setSavedCount(list.length);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const offers = useQuery(api.marketplaceBrowse.search, { sortBy: "year_desc", numItems: 8 }) as
    | MobileMarketplaceSearchResult
    | undefined;
  const offerCars = (offers?.vehicles ?? []).slice(0, 6);

  const submitSearch = () => {
    const term = search.trim();
    onOpenCars(term.length > 0 ? term : undefined);
  };

  const brands = getVehicleBrandChipOptions(locale);

  // RTL renders the array left→right, so this order puts طلب تمويل on the left
  // and المفضلة on the right, matching the mockup.
  const quickActions: QuickAction[] = [
    {
      key: "finance",
      icon: "applications",
      tone: "purple",
      title: t("homeActionFinanceTitle"),
      body: t("homeActionFinanceBody"),
      onPress: onOpenFinancing,
    },
    {
      key: "calculator",
      icon: "calculator",
      tone: "green",
      title: t("homeActionCalculatorTitle"),
      body: t("homeActionCalculatorBody"),
      onPress: onOpenFinancing,
    },
    {
      key: "compare",
      icon: "compare",
      tone: "blue",
      title: t("homeActionCompareTitle"),
      body: t("homeActionCompareBody"),
      onPress: onOpenCompare,
    },
    {
      key: "favorites",
      icon: "heartFilled",
      tone: "red",
      title: t("homeActionFavoritesTitle"),
      body: t("homeActionFavoritesBody"),
      badge: savedCount > 0 ? formatNumber(savedCount, locale) : undefined,
      onPress: onOpenFavorites,
    },
  ];

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* Header: logo + greeting + bell. RTL renders the first child on the
          right, so the logo sits top-right and the bell top-left. */}
      <View style={[styles.header, { direction: textDirection }]}>
        <Image
          source={require("../../../assets/brand/autoflow-logo.png")}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel={t("appName")}
        />
        <View style={styles.greetingBlock}>
          <Text style={styles.greeting}>{`${t("homeGreetingPrefix")} 👋`}</Text>
          <Text style={styles.greetingSub}>{t("homeGreetingSubtitle")}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("homeNotifications")}
          style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
          onPress={onOpenFavorites}
        >
          <Icon color="primary" name="notifications" size={20} />
        </Pressable>
      </View>

      {/* Hero: the full BMW banner at its natural aspect (no crop, scales with
          screen width) with the title overlaid, and the search + Request CTA on
          the dark card below it. */}
      <ImageBackground
        source={HERO_SOURCE}
        style={[styles.hero, { aspectRatio: HERO_ASPECT, direction: textDirection }]}
        imageStyle={styles.heroImage}
        resizeMode="cover"
      >
        <View style={styles.heroScrim} pointerEvents="none" />
        <View style={styles.heroContent}>
          <View style={styles.heroTextTop}>
            <Text style={styles.heroTitle}>{t("homeHeroTitle")}</Text>
            <Text style={styles.heroSubtitle}>{t("homeHeroSubtitle")}</Text>
          </View>
          <View style={styles.heroControls}>
        <View style={styles.searchBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("marketplaceSearch")}
            style={({ pressed }) => [styles.searchIcon, pressed && styles.pressed]}
            onPress={submitSearch}
          >
            <Icon color="onPrimary" name="search" size={18} />
          </Pressable>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t("homeSearchPlaceholder")}
            placeholderTextColor="#94a3b8"
            returnKeyType="search"
            onSubmitEditing={submitSearch}
            style={[styles.searchInput, { textAlign: textDirection === "rtl" ? "right" : "left" }]}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("marketplaceRequestHeroCta")}
          style={({ pressed }) => [styles.heroRequestBtn, pressed && styles.pressed]}
          onPress={onOpenRequest}
        >
          <Icon color="onPrimary" name="vehicles" size={18} />
          <Text style={styles.heroRequestText}>{t("marketplaceRequestHeroCta")}</Text>
        </Pressable>
          </View>
        </View>
      </ImageBackground>

      {/* Brand shortcuts — white pills below the hero. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.brandStrip, { direction: textDirection }]}
      >
        {brands.map((brand) => {
          const logo = getMakeLogo(brand.value);
          return (
            <Pressable
              key={brand.value}
              accessibilityRole="button"
              accessibilityLabel={brand.label}
              style={({ pressed }) => [styles.brandPill, pressed && styles.pressed]}
              onPress={() => onOpenCars(brand.value)}
            >
              {logo ? (
                <View style={styles.brandLogoChip}>
                  <Image source={logo} style={styles.brandLogo} resizeMode="contain" />
                </View>
              ) : null}
              <Text style={styles.brandPillText}>{brand.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Quick actions. */}
      <Text style={[styles.sectionTitle, { textAlign: textDirection === "rtl" ? "right" : "left" }]}>
        {t("homeQuickActionsTitle")}
      </Text>
      <View style={[styles.actionsRow, { direction: textDirection }]}>
        {quickActions.map((action) => (
          <QuickActionTile key={action.key} action={action} />
        ))}
      </View>

      {/* Latest offers. */}
      <View style={[styles.offersHeader, { direction: textDirection }]}>
        <Text style={styles.sectionTitle}>{t("homeLatestOffersTitle")}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("homeViewAll")}
          style={({ pressed }) => [styles.viewAll, pressed && styles.pressed]}
          onPress={() => onOpenCars()}
        >
          <Text style={styles.viewAllText}>{t("homeViewAll")}</Text>
          <Icon color="primary" name="chevronForward" size={14} />
        </Pressable>
      </View>
      {offerCars.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.offersRow, { direction: textDirection }]}
        >
          {offerCars.map((vehicle) => (
            <HomeOfferCard key={`${vehicle.orgId}-${vehicle.id}`} vehicle={vehicle} onPress={() => onOpenCars(vehicle.make)} />
          ))}
        </ScrollView>
      ) : (
        <Card style={styles.offersEmpty}>
          <Text style={styles.offersEmptyText}>{t("marketplaceCarsEmpty")}</Text>
        </Card>
      )}

      {/* Reverse-marketplace request banner — AutoFlow's wedge. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("homeRequestBannerCta")}
        style={({ pressed }) => [styles.requestBanner, { aspectRatio: REQUEST_ASPECT }, pressed && styles.pressed]}
        onPress={onOpenRequest}
      >
        {/* The request banner artwork already includes its own headline, body,
            and button, so the whole image is the tappable CTA (no overlay). The
            aspect ratio lives on this container (like the hero) and the image
            fills it — putting aspectRatio on the Image itself mis-sizes it. */}
        <Image source={REQUEST_SOURCE} style={styles.requestBannerImg} resizeMode="cover" />
      </Pressable>

      {/* Trust promise. */}
      <View style={[styles.trustStrip, { direction: textDirection }]}>
        <TrustItem icon="approvals" title={t("homeTrustSupportTitle")} body={t("homeTrustSupportBody")} />
        <TrustItem icon="sales" title={t("marketplaceTrustPricesTitle")} body={t("marketplaceTrustPricesBody")} />
        <TrustItem icon="approvalsFilled" title={t("marketplaceTrustDealersTitle")} body={t("marketplaceTrustDealersBody")} />
      </View>
    </ScrollView>
  );
}

function QuickActionTile({ action }: Readonly<{ action: QuickAction }>) {
  const styles = useThemedStyles(makeStyles);
  const theme = useAppTheme();
  const toneBg: Record<QuickAction["tone"], string> = {
    green: theme.colors.successSoft,
    blue: theme.colors.infoSoft,
    purple: theme.colors.primarySoft,
    red: theme.colors.dangerSoft,
  };
  const toneFg: Record<QuickAction["tone"], keyof AppTheme["colors"]> = {
    green: "success",
    blue: "info",
    purple: "primary",
    red: "danger",
  };

  return (
    <Card style={styles.actionTile} onPress={action.onPress} accessibilityLabel={action.title}>
      <View style={[styles.actionIcon, { backgroundColor: toneBg[action.tone] }]}>
        <Icon color={toneFg[action.tone]} name={action.icon} size={20} />
      </View>
      <Text numberOfLines={2} style={styles.actionTitle}>
        {action.title}
      </Text>
      <View style={styles.actionBodyRow}>
        {action.badge ? (
          <View style={styles.actionBadge}>
            <Text style={styles.actionBadgeText}>{action.badge}</Text>
          </View>
        ) : null}
        <Text numberOfLines={1} style={styles.actionBody}>
          {action.body}
        </Text>
      </View>
    </Card>
  );
}

function HomeOfferCard({
  vehicle,
  onPress,
}: Readonly<{ vehicle: MobileMarketplaceVehicle; onPress: () => void }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t } = useLocale();
  const title = getVehicleTitle(vehicle);
  const price = formatMoney(vehicle.price, locale);
  const monthly = formatMoney(vehicle.estimatedMonthlyPayment, locale);
  const specs = [
    vehicle.transmission,
    vehicle.fuelType,
    vehicle.mileage != null ? `${formatNumber(vehicle.mileage, locale)} ${t("marketplaceMileage")}` : null,
  ].filter((part): part is string => Boolean(part));

  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    loadSavedVehicles()
      .then((list) => {
        if (active) setSaved(isVehicleSaved(list, vehicle.id));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [vehicle.id]);

  const toggle = useCallback(async () => {
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
    const next = await toggleSavedVehicle(snapshot);
    setSaved(isVehicleSaved(next, vehicle.id));
  }, [vehicle, title]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("marketplaceViewDetails")}: ${title}`}
      style={({ pressed }) => [styles.offerCard, pressed && styles.pressed]}
      onPress={onPress}
    >
      <View style={styles.offerImageWrap}>
        {vehicle.imageUrls[0] ? (
          <Image source={{ uri: vehicle.imageUrls[0] }} style={styles.offerImage} resizeMode="cover" />
        ) : (
          <Text style={styles.offerNoImage}>{t("marketplaceNoImage")}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saved ? t("marketplaceSavedRemove") : t("marketplaceSaveCar")}
          accessibilityState={{ selected: saved }}
          style={({ pressed }) => [styles.offerHeart, pressed && styles.pressed]}
          onPress={() => void toggle()}
        >
          <Icon color={saved ? "danger" : "text"} name={saved ? "heartFilled" : "heart"} size={16} />
        </Pressable>
        {isRecentlyListed(vehicle.listedAt) ? (
          <View style={styles.offerBadge}>
            <Text style={styles.offerBadgeText}>{t("homeFeatured")}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.offerBody}>
        <Text numberOfLines={1} style={styles.offerTitle}>
          {title}
        </Text>
        {specs.length > 0 ? (
          <Text numberOfLines={1} style={styles.offerSpecs}>
            {specs.join("  ·  ")}
          </Text>
        ) : null}
        {price ? <Text style={styles.offerPrice}>{price}</Text> : null}
        {monthly ? (
          <View style={styles.offerMonthly}>
            <Text style={styles.offerMonthlyText}>
              {t("marketplaceMonth")}، {monthly}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function TrustItem({
  icon,
  title,
  body,
}: Readonly<{ icon: SemanticIconName; title: string; body: string }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.trustItem}>
      <Icon color="primary" name={icon} size={20} />
      <Text numberOfLines={1} style={styles.trustTitle}>
        {title}
      </Text>
      <Text numberOfLines={2} style={styles.trustBody}>
        {body}
      </Text>
    </View>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
    },
    content: {
      gap: theme.spacing.lg,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    bell: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceAlt,
    },
    greetingBlock: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    greeting: {
      color: theme.colors.text,
      fontSize: 17,
      fontWeight: "800",
    },
    greetingSub: {
      color: theme.colors.mutedText,
      fontSize: 12,
    },
    logo: {
      width: 96,
      height: 44,
    },
    hero: {
      width: "100%",
      overflow: "hidden",
      justifyContent: "center",
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.hero,
    },
    heroImage: {
      borderRadius: theme.radius.xl,
    },
    heroScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(8,12,24,0.28)",
    },
    heroContent: {
      // Overlaid on the full image: title at the top (over the sky), search +
      // CTA anchored full-width at the bottom (over the road). Text shadows keep
      // the copy legible wherever the photo is bright.
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      justifyContent: "space-between",
      padding: theme.spacing.lg,
    },
    heroTextTop: {
      gap: theme.spacing.xs,
    },
    heroControls: {
      gap: theme.spacing.sm,
    },
    heroTitle: {
      color: theme.colors.onPrimary,
      fontSize: 24,
      fontWeight: "900",
      lineHeight: 30,
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 8,
    },
    heroSubtitle: {
      color: "rgba(255,255,255,0.92)",
      fontSize: 13,
      lineHeight: 19,
      textShadowColor: "rgba(0,0,0,0.5)",
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 6,
    },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing.xs,
    },
    searchIcon: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
    },
    searchInput: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 14,
      paddingHorizontal: theme.spacing.sm,
    },
    heroRequestBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      minHeight: 50,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.lg,
    },
    heroRequestText: {
      color: theme.colors.onPrimary,
      fontSize: 15,
      fontWeight: "800",
    },
    brandStrip: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    brandPill: {
      flexDirection: "row",
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
      ...theme.shadows.sm,
    },
    // A small always-white puck so the marque logo (which sits on its own white
    // ground) reads cleanly on both light and dark pills.
    brandLogoChip: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: "#ffffff",
    },
    brandLogo: {
      width: 26,
      height: 26,
    },
    brandPillText: {
      color: theme.colors.text,
      fontSize: 14,
      fontWeight: "700",
    },
    sectionTitle: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "800",
    },
    actionsRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
    },
    actionTile: {
      flex: 1,
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
    },
    actionIcon: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
    },
    actionTitle: {
      color: theme.colors.text,
      fontSize: 12,
      fontWeight: "800",
      lineHeight: 16,
    },
    actionBodyRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    actionBadge: {
      minWidth: 16,
      alignItems: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.danger,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    actionBadgeText: {
      color: theme.colors.onPrimary,
      fontSize: 9,
      fontWeight: "800",
    },
    actionBody: {
      flex: 1,
      color: theme.colors.mutedText,
      fontSize: 10,
      lineHeight: 14,
    },
    offersHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    viewAll: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
    },
    viewAllText: {
      color: theme.colors.primary,
      fontSize: 13,
      fontWeight: "700",
    },
    offersRow: {
      flexDirection: "row",
      gap: theme.spacing.md,
      paddingBottom: theme.spacing.xs,
    },
    offerCard: {
      width: 220,
      overflow: "hidden",
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface,
      ...theme.shadows.sm,
    },
    offerImageWrap: {
      height: 130,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceAlt,
    },
    offerImage: {
      width: "100%",
      height: "100%",
    },
    offerNoImage: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "700",
    },
    offerHeart: {
      position: "absolute",
      top: theme.spacing.sm,
      start: theme.spacing.sm,
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surface,
      ...theme.shadows.sm,
    },
    offerBadge: {
      position: "absolute",
      top: theme.spacing.sm,
      end: theme.spacing.sm,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.primarySoft,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
    },
    offerBadgeText: {
      color: theme.colors.primaryDark,
      fontSize: 10,
      fontWeight: "800",
    },
    offerBody: {
      gap: theme.spacing.xs,
      padding: theme.spacing.md,
    },
    offerTitle: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "800",
    },
    offerSpecs: {
      color: theme.colors.mutedText,
      fontSize: 11,
    },
    offerPrice: {
      color: theme.colors.primary,
      fontSize: 17,
      fontWeight: "900",
    },
    offerMonthly: {
      alignSelf: "flex-start",
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surfaceAlt,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 3,
    },
    offerMonthlyText: {
      color: theme.colors.mutedText,
      fontSize: 11,
      fontWeight: "700",
    },
    offersEmpty: {
      alignItems: "center",
    },
    offersEmptyText: {
      color: theme.colors.mutedText,
      fontSize: 13,
      textAlign: "center",
    },
    requestBanner: {
      width: "100%",
      overflow: "hidden",
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.heroAlt,
    },
    requestBannerImg: {
      width: "100%",
      height: "100%",
    },
    requestBg: {
      width: "100%",
      justifyContent: "center",
    },
    requestImage: {
      borderRadius: theme.radius.xl,
    },
    requestScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(6,10,24,0.42)",
    },
    requestContent: {
      // Overlaid on the (physical) right — the RTL start — so the copy sits over
      // the darker side while the magnifier art shows on the left.
      width: "64%",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
    },
    requestTitle: {
      color: theme.colors.onPrimary,
      fontSize: 16,
      fontWeight: "800",
    },
    requestBody: {
      color: "rgba(255,255,255,0.78)",
      fontSize: 12,
      lineHeight: 17,
    },
    requestCta: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      marginTop: theme.spacing.xs,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
    },
    requestCtaText: {
      color: theme.colors.text,
      fontSize: 12,
      fontWeight: "800",
    },
    trustStrip: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing.md,
    },
    trustItem: {
      flex: 1,
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    trustTitle: {
      color: theme.colors.text,
      fontSize: 11,
      fontWeight: "800",
      textAlign: "center",
    },
    trustBody: {
      color: theme.colors.mutedText,
      fontSize: 10,
      lineHeight: 14,
      textAlign: "center",
    },
    pressed: {
      opacity: 0.85,
    },
  });
