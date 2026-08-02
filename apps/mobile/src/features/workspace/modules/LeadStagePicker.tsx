import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "../../../components/Icon";
import { type MobileLeadStage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../../../providers/ThemeProvider";
import { type AppTheme } from "../../../theme";
import {
  OPEN_LEAD_STAGES,
  TERMINAL_LEAD_STAGES,
  leadStageConfirmation,
  leadStageDirection,
  leadStageDirectionHint,
  leadStageLabel,
} from "./leadStage";

type LeadStagePickerProps = Readonly<{
  /** True while a stage write is in flight. Blocks re-entry and shows a spinner. */
  busy?: boolean;
  /** Pill form used inside a list card; the field form is used in the detail sheet. */
  compact?: boolean;
  disabled?: boolean;
  label?: string;
  onSelect: (stage: MobileLeadStage) => void;
  stage: MobileLeadStage;
  testID?: string;
}>;

/**
 * Stage selector for a lead.
 *
 * Presents the whole pipeline in a bottom sheet so any stage is one
 * interaction away in either direction, rather than the one-way "Advance"
 * button this replaces. Stages that close the lead are grouped apart and
 * confirmed before they fire, matching the way a platform action sheet
 * separates destructive choices from routine ones.
 *
 * Purely controlled: it renders the stage it is handed and reports the chosen
 * one. The caller owns the write, so the optimistic value and its rollback
 * stay in one place (`commitLeadStageChange`).
 */
export function LeadStagePicker({
  busy = false,
  compact = false,
  disabled = false,
  label,
  onSelect,
  stage,
  testID = "lead-stage",
}: LeadStagePickerProps) {
  const { locale, textDirection } = useLocale();
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  const isArabic = locale === "ar";
  const fieldLabel = label ?? (isArabic ? "المرحلة" : "Stage");
  const currentLabel = leadStageLabel(stage, locale);
  const locked = disabled || busy;

  function choose(nextStage: MobileLeadStage) {
    setOpen(false);
    if (nextStage === stage) return;

    const confirmation = leadStageConfirmation(nextStage, locale);
    if (!confirmation) {
      onSelect(nextStage);
      return;
    }

    Alert.alert(confirmation.title, confirmation.body, [
      { style: "cancel", text: confirmation.cancelLabel },
      {
        style: confirmation.destructive ? "destructive" : "default",
        text: confirmation.confirmLabel,
        onPress: () => onSelect(nextStage),
      },
    ]);
  }

  function renderRow(rowStage: MobileLeadStage) {
    const selected = rowStage === stage;
    const rowLabel = leadStageLabel(rowStage, locale);
    const hint = leadStageDirectionHint(leadStageDirection(stage, rowStage), locale);

    return (
      <Pressable
        key={rowStage}
        accessibilityHint={hint}
        accessibilityLabel={rowLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        testID={`${testID}-option-${rowStage}`}
        style={({ pressed }) => [
          styles.optionRow,
          selected && styles.optionRowSelected,
          pressed && styles.pressed,
        ]}
        onPress={() => choose(rowStage)}
      >
        <Text
          style={[
            styles.optionLabel,
            selected && styles.optionLabelSelected,
            rowStage === "LOST" && styles.optionLabelDanger,
          ]}
        >
          {rowLabel}
        </Text>
        {selected ? <Icon color="primary" name="check" size={18} /> : null}
      </Pressable>
    );
  }

  const trigger = (
    <Pressable
      accessibilityHint={isArabic ? "يفتح قائمة مراحل خط المبيعات." : "Opens the pipeline stage list."}
      accessibilityLabel={`${fieldLabel}: ${currentLabel}`}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: locked, expanded: open }}
      disabled={locked}
      testID={`${testID}-trigger`}
      style={({ pressed }) => [
        compact ? styles.pillTrigger : styles.fieldTrigger,
        locked && styles.triggerDisabled,
        pressed && !locked && styles.pressed,
      ]}
      onPress={() => setOpen(true)}
    >
      <Text numberOfLines={1} style={compact ? styles.pillText : styles.fieldText}>
        {currentLabel}
      </Text>
      {busy ? (
        <ActivityIndicator color={theme.colors.mutedText} size="small" testID={`${testID}-busy`} />
      ) : (
        <Icon color="mutedText" name={open ? "chevronUp" : "chevronDown"} size={compact ? 14 : 18} />
      )}
    </Pressable>
  );

  return (
    <View style={compact ? styles.pillWrapper : styles.field}>
      {compact ? null : <Text style={styles.fieldLabel}>{fieldLabel}</Text>}
      {trigger}

      <Modal animationType="slide" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          {/* Distinct from the Close button's label: two controls both
              announced as "Close" is a screen-reader ambiguity. */}
          <Pressable
            accessibilityLabel={isArabic ? "إغلاق قائمة المراحل" : "Dismiss stage list"}
            accessibilityRole="button"
            testID={`${testID}-scrim`}
            style={styles.scrim}
            onPress={() => setOpen(false)}
          />
          <View style={[styles.sheet, { direction: textDirection }]}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleBlock}>
                <Text style={styles.sheetTitle}>{fieldLabel}</Text>
                <Text style={styles.sheetSubtitle}>{currentLabel}</Text>
              </View>
              <Pressable
                accessibilityLabel={isArabic ? "إغلاق" : "Close"}
                accessibilityRole="button"
                testID={`${testID}-close`}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                onPress={() => setOpen(false)}
              >
                <Text style={styles.closeButtonText}>{isArabic ? "إغلاق" : "Close"}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.optionList}>
              <Text style={styles.sectionCaption}>{isArabic ? "خط المبيعات" : "Pipeline"}</Text>
              {OPEN_LEAD_STAGES.map(renderRow)}
              <Text style={styles.sectionCaption}>
                {isArabic ? "إغلاق الفرصة" : "Close this lead"}
              </Text>
              {TERMINAL_LEAD_STAGES.map(renderRow)}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    field: {
      gap: theme.spacing.xs,
    },
    fieldLabel: {
      color: theme.colors.mutedText,
      fontSize: 13,
      fontWeight: "600",
    },
    fieldTrigger: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
    },
    fieldText: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 16,
    },
    pillWrapper: {
      alignItems: "flex-start",
    },
    // 44pt tall so the pill clears the platform minimum touch target even
    // though it reads as a small status chip.
    pillTrigger: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      borderRadius: theme.radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceAlt,
      paddingHorizontal: theme.spacing.md,
    },
    pillText: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    triggerDisabled: {
      opacity: 0.55,
    },
    pressed: {
      opacity: 0.82,
    },
    modalRoot: {
      flex: 1,
      justifyContent: "flex-end",
    },
    // All four edges, so this is a full-bleed cover rather than a directional
    // offset — nothing here needs to flip under RTL.
    scrim: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.overlayScrim,
    },
    sheet: {
      maxHeight: "84%",
      borderTopLeftRadius: theme.radius.xl,
      borderTopRightRadius: theme.radius.xl,
      backgroundColor: theme.colors.background,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
      paddingBottom: theme.spacing.sm,
    },
    sheetTitleBlock: {
      flex: 1,
      minWidth: 0,
    },
    sheetTitle: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "700",
    },
    sheetSubtitle: {
      color: theme.colors.mutedText,
      fontSize: 13,
    },
    closeButton: {
      minHeight: 44,
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceAlt,
      paddingHorizontal: theme.spacing.lg,
    },
    closeButtonText: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "600",
    },
    optionList: {
      gap: theme.spacing.xs,
      paddingTop: theme.spacing.sm,
    },
    sectionCaption: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 0.4,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xs,
      textTransform: "uppercase",
    },
    optionRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    optionRowSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primarySoft,
    },
    optionLabel: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 16,
    },
    optionLabelSelected: {
      color: theme.colors.primaryDark,
      fontWeight: "700",
    },
    optionLabelDanger: {
      color: theme.colors.danger,
    },
  });
