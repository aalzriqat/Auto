import type { KeyboardTypeOptions, StyleProp, ViewStyle } from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";

type FormFieldProps = Readonly<{
  containerStyle?: StyleProp<ViewStyle>;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  value: string;
}>;

export function FormField({
  containerStyle,
  keyboardType = "default",
  label,
  multiline = false,
  onChangeText,
  value,
}: FormFieldProps) {
  const { isRtl, locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={[styles.fieldLabel, getTypographyStyle("label", locale, fontsLoaded)]}>
        {label}
      </Text>
      <TextInput
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholderTextColor={theme.colors.subtleText}
        style={[
          styles.input,
          multiline && styles.multilineInput,
          getTypographyStyle("body", locale, fontsLoaded),
          { textAlign: isRtl ? "right" : "left" },
        ]}
        value={value}
      />
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  field: {
    gap: theme.spacing.xs,
  },
  fieldLabel: {
    color: theme.colors.mutedText,
  },
  input: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  multilineInput: {
    minHeight: 86,
    textAlignVertical: "top",
  },
});
