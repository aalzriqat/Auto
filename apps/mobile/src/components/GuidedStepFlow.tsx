import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { getTypographyStyle, theme } from "../theme";

export type GuidedStep = Readonly<{
  subtitle?: string;
  title: string;
}>;

type GuidedStepFlowProps = Readonly<{
  activeIndex: number;
  children: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  steps: readonly GuidedStep[];
}>;

export function getSafeStepIndex(stepCount: number, activeIndex: number): number {
  if (stepCount <= 0) return 0;
  return Math.min(Math.max(activeIndex, 0), stepCount - 1);
}

export function GuidedStepFlow({
  activeIndex,
  children,
  containerStyle,
  steps,
}: GuidedStepFlowProps) {
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const safeIndex = getSafeStepIndex(steps.length, activeIndex);
  const activeStep = steps[safeIndex];
  const progressLabel = steps.length > 0 ? `${safeIndex + 1}/${steps.length}` : "0/0";

  return (
    <View style={[styles.root, { direction: textDirection }, containerStyle]}>
      {activeStep ? (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.kicker, getTypographyStyle("label", locale, fontsLoaded)]}>{progressLabel}</Text>
            <Text style={[styles.title, getTypographyStyle("heading", locale, fontsLoaded)]}>{activeStep.title}</Text>
            {activeStep.subtitle ? (
              <Text style={[styles.subtitle, getTypographyStyle("body", locale, fontsLoaded)]}>
                {activeStep.subtitle}
              </Text>
            ) : null}
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{
              min: 1,
              max: steps.length,
              now: safeIndex + 1,
              text: progressLabel,
            }}
            style={styles.rail}
          >
            {steps.map((step, index) => {
              const selected = index === safeIndex;
              const completed = index < safeIndex;
              return (
                <View
                  key={`${step.title}-${index}`}
                  style={[
                    styles.stepDot,
                    completed && styles.stepDotComplete,
                    selected && styles.stepDotActive,
                  ]}
                />
              );
            })}
          </View>
        </View>
      ) : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  header: {
    gap: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing.md,
  },
  headerText: {
    gap: theme.spacing.xs,
  },
  kicker: {
    alignSelf: "flex-start",
    overflow: "hidden",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primarySoft,
    color: theme.colors.primaryDark,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
  },
  subtitle: {
    color: theme.colors.mutedText,
  },
  rail: {
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  stepDot: {
    flex: 1,
    height: 5,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.border,
  },
  stepDotActive: {
    backgroundColor: theme.colors.primary,
  },
  stepDotComplete: {
    backgroundColor: theme.colors.heroAlt,
  },
  body: {
    gap: theme.spacing.md,
  },
});
