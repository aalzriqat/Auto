import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";

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
  const { textDirection } = useLocale();
  const safeIndex = getSafeStepIndex(steps.length, activeIndex);
  const activeStep = steps[safeIndex];
  const progressLabel = steps.length > 0 ? `${safeIndex + 1}/${steps.length}` : "0/0";

  return (
    <View style={[styles.root, { direction: textDirection }, containerStyle]}>
      {activeStep ? (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>{progressLabel}</Text>
            <Text style={styles.title}>{activeStep.title}</Text>
            {activeStep.subtitle ? <Text style={styles.subtitle}>{activeStep.subtitle}</Text> : null}
          </View>
          <View style={styles.rail} accessibilityRole="progressbar">
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
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  header: {
    gap: theme.spacing.md,
    borderBottomWidth: 1,
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
    fontSize: 11,
    fontWeight: "900",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: 19,
    fontWeight: "900",
    lineHeight: 25,
  },
  subtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
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
