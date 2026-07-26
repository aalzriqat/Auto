import { nativeRoutes, type MobileFoundationStringKey } from "@autoflow/shared";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  api,
  type MobileMarketplaceListing,
  type MobileMarketplaceListingStatus,
} from "../../convexApi";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { formatNumber, getTradeInConditionKey } from "./marketplaceUtils";

const STATUS_LABEL_KEYS: Record<MobileMarketplaceListingStatus, MobileFoundationStringKey> = {
  PENDING_VERIFICATION: "myListingsStatusPending",
  LIVE: "myListingsStatusLive",
  REJECTED: "myListingsStatusRejected",
  SOLD: "myListingsStatusSold",
  REMOVED: "myListingsStatusRemoved",
};

function useStatusBadgeColors(status: MobileMarketplaceListingStatus) {
  const theme = useAppTheme();
  const map: Record<MobileMarketplaceListingStatus, { background: string; foreground: string }> = {
    PENDING_VERIFICATION: { background: theme.colors.warningSoft, foreground: theme.colors.warning },
    LIVE: { background: theme.colors.successSoft, foreground: theme.colors.success },
    REJECTED: { background: theme.colors.dangerSoft, foreground: theme.colors.danger },
    SOLD: { background: theme.colors.surfaceAlt, foreground: theme.colors.mutedText },
    REMOVED: { background: theme.colors.surfaceAlt, foreground: theme.colors.mutedText },
  };
  return map[status];
}

function ListingCard({
  listing,
  pending,
  onMarkSold,
  onDelete,
}: Readonly<{
  listing: MobileMarketplaceListing;
  pending: boolean;
  onMarkSold: () => void;
  onDelete: () => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const badgeColors = useStatusBadgeColors(listing.status);
  const statusLabel = t(STATUS_LABEL_KEYS[listing.status]);
  const conditionLabel = t(getTradeInConditionKey(listing.condition));

  return (
    <Card style={styles.card}>
      <View style={[styles.cardTopRow, { direction: textDirection }]}>
        <View style={styles.thumbWrap}>
          {listing.thumbnailUrl ? (
            <Image source={{ uri: listing.thumbnailUrl }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <Icon color="mutedText" name="vehicles" size={22} />
          )}
        </View>
        <View style={styles.cardBody}>
          <View style={[styles.cardTitleRow, { direction: textDirection }]}>
            <Text numberOfLines={1} style={styles.cardTitle}>
              {listing.year} {listing.make} {listing.model}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: badgeColors.background }]}>
              <Text style={[styles.statusBadgeText, { color: badgeColors.foreground }]}>{statusLabel}</Text>
            </View>
          </View>
          <Text numberOfLines={1} style={styles.cardMeta}>
            {formatNumber(listing.price, locale)} {listing.currency} · {conditionLabel} · {listing.city}
          </Text>
          {listing.status === "REJECTED" && listing.rejectionReason ? (
            <Text style={styles.reasonText}>
              {t("myListingsRejectionReason")}: {listing.rejectionReason}
            </Text>
          ) : null}
          {listing.status === "REMOVED" && listing.removalReason ? (
            <Text style={styles.reasonText}>
              {t("myListingsRemovalReason")}: {listing.removalReason}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={[styles.actionsRow, { direction: textDirection }]}>
        {listing.status === "LIVE" ? (
          <Button
            disabled={pending}
            label={pending ? t("myListingsMarking") : t("myListingsMarkSold")}
            style={styles.actionButton}
            variant="secondary"
            onPress={onMarkSold}
          />
        ) : null}
        <Button
          disabled={pending}
          label={pending ? t("myListingsDeleting") : t("myListingsDelete")}
          style={styles.actionButton}
          variant="danger"
          onPress={onDelete}
        />
      </View>
    </Card>
  );
}

export function MyListingsScreen({
  embedded = false,
  onAddListing,
}: Readonly<{ embedded?: boolean; onAddListing?: () => void }> = {}) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t, textDirection } = useLocale();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const listings = useQuery(api.marketplaceListings.getMyListings, isAuthenticated ? {} : "skip");
  const markListingSold = useMutation(api.marketplaceListings.markListingSold);
  const softDeleteListing = useMutation(api.marketplaceListings.softDeleteListing);
  const [pendingListingId, setPendingListingId] = useState<string | null>(null);

  async function handleMarkSold(listingId: string) {
    setPendingListingId(listingId);
    try {
      await markListingSold({ listingId });
    } catch (error) {
      console.error("Mobile mark-listing-sold failed", error);
      Alert.alert("AutoFlow", t("marketplaceListingGenericError"));
    } finally {
      setPendingListingId(null);
    }
  }

  async function handleDelete(listingId: string) {
    setPendingListingId(listingId);
    try {
      await softDeleteListing({ listingId });
    } catch (error) {
      console.error("Mobile listing delete failed", error);
      Alert.alert("AutoFlow", t("marketplaceListingGenericError"));
    } finally {
      setPendingListingId(null);
    }
  }

  function confirmDelete(listingId: string) {
    Alert.alert(t("myListingsConfirmDeleteTitle"), t("myListingsConfirmDeleteBody"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("myListingsDelete"),
        style: "destructive",
        onPress: () => void handleDelete(listingId),
      },
    ]);
  }

  let body;
  if (authLoading) {
    body = <RouteLoadingState label={t("myListingsLoading")} />;
  } else if (!isAuthenticated) {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.emptyContent, { direction: textDirection }]}>
        <EmptyState
          actionLabel={t("signIn")}
          hint={t("myListingsSignInBody")}
          icon="vehicles"
          title={t("myListingsSignInTitle")}
          onAction={() => router.push(`${nativeRoutes.signIn}?returnTo=marketplace`)}
        />
      </ScrollView>
    );
  } else if (listings === undefined) {
    body = <RouteLoadingState label={t("myListingsLoading")} />;
  } else if (listings.length === 0) {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.emptyContent, { direction: textDirection }]}>
        <EmptyState
          actionLabel={onAddListing ? t("myListingsListFirstCar") : undefined}
          icon="vehicles"
          title={t("myListingsEmptyTitle")}
          onAction={onAddListing}
        />
      </ScrollView>
    );
  } else {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { direction: textDirection }]}>
        <View style={[styles.headerRow, { direction: textDirection }]}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{t("myListingsTitle")}</Text>
            <Text style={styles.subtitle}>{t("myListingsSubtitle")}</Text>
          </View>
          {onAddListing ? (
            <Button label={t("myListingsListAnother")} onPress={onAddListing} />
          ) : null}
        </View>
        {listings.map((listing) => (
          <ListingCard
            key={listing._id}
            listing={listing}
            pending={pendingListingId === listing._id}
            onDelete={() => confirmDelete(listing._id)}
            onMarkSold={() => void handleMarkSold(listing._id)}
          />
        ))}
      </ScrollView>
    );
  }

  return embedded ? body : <Screen>{body}</Screen>;
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
    },
    content: {
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    emptyContent: {
      flexGrow: 1,
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    headerText: {
      flex: 1,
      minWidth: 0,
      gap: theme.spacing.xs,
    },
    title: {
      color: theme.colors.text,
      fontSize: 24,
      fontWeight: "800",
    },
    subtitle: {
      color: theme.colors.mutedText,
      fontSize: 14,
      lineHeight: 20,
    },
    card: {
      gap: theme.spacing.sm,
    },
    cardTopRow: {
      flexDirection: "row",
      gap: theme.spacing.md,
    },
    thumbWrap: {
      width: 84,
      height: 64,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      overflow: "hidden",
      backgroundColor: theme.colors.surfaceAlt,
    },
    thumb: {
      width: "100%",
      height: "100%",
    },
    cardBody: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    cardTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
    },
    cardTitle: {
      flexShrink: 1,
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "700",
    },
    statusBadge: {
      borderRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
    },
    statusBadgeText: {
      fontSize: 11,
      fontWeight: "700",
    },
    cardMeta: {
      color: theme.colors.mutedText,
      fontSize: 13,
    },
    reasonText: {
      color: theme.colors.danger,
      fontSize: 12,
      lineHeight: 17,
    },
    actionsRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
    },
  });
