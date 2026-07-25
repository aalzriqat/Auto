import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../../components/Card";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { Screen } from "../../components/Screen";
import { useLocale } from "../../providers/LocaleProvider";
import { useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { formatMoney, parseOptionalPositiveNumber } from "../marketplace/marketplaceUtils";
import { estimateMonthlyPayment } from "./financingCalc";

/**
 * Buyer Financing tab. A self-contained monthly-payment estimator (no account
 * needed) — the "حاسبة القسط" quick action and the Financing bottom tab both
 * land here. Pure math via {@link estimateMonthlyPayment}; the disclaimer keeps
 * it clearly an estimate, not an offer.
 */
export function FinancingScreen({ embedded = false }: Readonly<{ embedded?: boolean }> = {}) {
  const styles = useThemedStyles(makeStyles);
  const { locale, t, textDirection } = useLocale();
  const [price, setPrice] = useState("20000");
  const [downPayment, setDownPayment] = useState("4000");
  const [termMonths, setTermMonths] = useState("60");
  const [rate, setRate] = useState("6");

  const monthly = useMemo(() => {
    const p = parseOptionalPositiveNumber(price) ?? 0;
    const d = parseOptionalPositiveNumber(downPayment) ?? 0;
    const term = parseOptionalPositiveNumber(termMonths) ?? 0;
    const r = parseOptionalPositiveNumber(rate) ?? 0;
    return estimateMonthlyPayment(p, d, term, r);
  }, [price, downPayment, termMonths, rate]);

  const monthlyLabel = monthly > 0 ? formatMoney(Math.round(monthly), locale) : formatMoney(0, locale);

  const body = (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { direction: textDirection }]}>
      <View style={styles.headerText}>
        <Text style={styles.brand}>{t("appName")}</Text>
        <Text style={styles.title}>{t("financingTitle")}</Text>
        <Text style={styles.subtitle}>{t("financingSubtitle")}</Text>
      </View>

      <Card style={styles.resultCard}>
        <View style={styles.resultIcon}>
          <Icon color="onPrimary" name="calculator" size={22} />
        </View>
        <Text style={styles.resultLabel}>{t("financingMonthlyLabel")}</Text>
        <Text style={styles.resultValue}>{monthlyLabel}</Text>
        <Text style={styles.resultPerMonth}>/{t("marketplaceMonth")}</Text>
      </Card>

      <Card style={styles.formCard}>
        <Text style={styles.formTitle}>{t("financingCalcTitle")}</Text>
        <FormField
          label={t("financingPrice")}
          value={price}
          keyboardType="number-pad"
          onChangeText={setPrice}
        />
        <FormField
          label={t("financingDownPayment")}
          value={downPayment}
          keyboardType="number-pad"
          onChangeText={setDownPayment}
        />
        <FormField
          label={t("financingTermMonths")}
          value={termMonths}
          keyboardType="number-pad"
          onChangeText={setTermMonths}
        />
        <FormField
          label={t("financingRate")}
          value={rate}
          keyboardType="number-pad"
          onChangeText={setRate}
        />
      </Card>

      <Text style={styles.disclaimer}>{t("financingDisclaimer")}</Text>
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
      gap: theme.spacing.lg,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    headerText: {
      gap: theme.spacing.xs,
    },
    brand: {
      color: theme.colors.primary,
      fontSize: 12,
      fontWeight: "700",
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
    resultCard: {
      alignItems: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.hero,
      paddingVertical: theme.spacing.xl,
    },
    resultIcon: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: "rgba(255,255,255,0.14)",
    },
    resultLabel: {
      color: "rgba(255,255,255,0.8)",
      fontSize: 13,
      fontWeight: "600",
    },
    resultValue: {
      color: theme.colors.onPrimary,
      fontSize: 34,
      fontWeight: "800",
    },
    resultPerMonth: {
      color: "rgba(255,255,255,0.8)",
      fontSize: 13,
      fontWeight: "600",
    },
    formCard: {
      gap: theme.spacing.md,
    },
    formTitle: {
      color: theme.colors.text,
      fontSize: 17,
      fontWeight: "700",
    },
    disclaimer: {
      color: theme.colors.subtleText,
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
    },
  });
