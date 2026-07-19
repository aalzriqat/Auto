import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { formatMoney } from "../marketplace/marketplaceUtils";
import {
  loadSavedVehicles,
  removeSavedVehicleById,
  type SavedVehicle,
} from "../marketplace/savedVehiclesStore";

/**
 * Saved cars tab. Reads the on-device store (buyers save without an account);
 * a later phase syncs it to a buyer account. Re-mounts whenever the buyer
 * switches to this tab in BuyerShell, so it always reflects the latest saves.
 */
export function BuyerSavedScreen({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const [saved, setSaved] = useState<SavedVehicle[] | null>(null);

  useEffect(() => {
    let active = true;
    loadSavedVehicles()
      .then((list) => {
        if (active) setSaved(list);
      })
      .catch(() => {
        if (active) setSaved([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function remove(vehicleId: string) {
    setSaved(await removeSavedVehicleById(vehicleId));
  }

  let body;
  if (saved === null) {
    body = <RouteLoadingState label={t("buyerTabSaved")} />;
  } else if (saved.length === 0) {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.emptyContent, { direction: textDirection }]}>
        <EmptyState hint={t("buyerSavedEmptyHint")} icon="save" title={t("buyerSavedEmptyTitle")} />
      </ScrollView>
    );
  } else {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.listContent, { direction: textDirection }]}>
        {saved.map((item) => {
          const price = formatMoney(item.price, locale);
          const monthly = formatMoney(item.monthlyPayment, locale);
          return (
            <Card key={item.id} style={styles.card}>
              {item.imageUrl ? (
                <Image source={{ uri: item.imageUrl }} style={styles.image} resizeMode="cover" />
              ) : null}
              <View style={styles.cardBody}>
                <Text numberOfLines={1} style={styles.cardTitle}>
                  {item.title}
                </Text>
                {item.dealershipName ? (
                  <Text numberOfLines={1} style={styles.cardMeta}>
                    {item.dealershipName}
                  </Text>
                ) : null}
                {price ? <Text style={styles.cardPrice}>{price}</Text> : null}
                {monthly ? (
                  <Text style={styles.cardMeta}>
                    {t("marketplaceFromPerMonth")} {monthly}/{t("marketplaceMonth")}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("buyerSavedRemove")}
                style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
                onPress={() => void remove(item.id)}
              >
                <Icon color="danger" name="close" size={18} />
              </Pressable>
            </Card>
          );
        })}
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
    emptyContent: {
      flexGrow: 1,
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    listContent: {
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      borderRadius: theme.radius.lg,
    },
    image: {
      width: 84,
      height: 64,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceAlt,
    },
    cardBody: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    cardTitle: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "700",
    },
    cardMeta: {
      color: theme.colors.mutedText,
      fontSize: 13,
    },
    cardPrice: {
      color: theme.colors.primary,
      fontSize: 15,
      fontWeight: "700",
    },
    removeButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.dangerSoft,
    },
    pressed: {
      opacity: 0.7,
    },
  });
