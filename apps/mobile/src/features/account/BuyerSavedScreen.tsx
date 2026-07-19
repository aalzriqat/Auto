import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";

/**
 * Saved cars tab. Buyers can save without an account — the local store lands in
 * a later phase; for now this shows the empty state so the tab exists in the
 * buyer shell. `embedded` skips the outer Screen when hosted inside BuyerShell.
 */
export function BuyerSavedScreen({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const styles = useThemedStyles(makeStyles);
  const { t, textDirection } = useLocale();

  const body: ReactNode = (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { direction: textDirection }]}>
      <View style={styles.stateShell}>
        <EmptyState hint={t("buyerSavedEmptyHint")} icon="save" title={t("buyerSavedEmptyTitle")} />
      </View>
    </ScrollView>
  );

  return embedded ? body : <Screen>{body}</Screen>;
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    stateShell: {
      paddingVertical: theme.spacing.xl,
    },
  });
