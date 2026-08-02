import { type Ref } from "react";
import type {
  KeyboardTypeOptions,
  ReturnKeyTypeOptions,
  StyleProp,
  TextInput as TextInputHandle,
  TextInputProps,
  ViewStyle,
} from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";

/**
 * `bordered` is the standalone look (outlined field on a surface); `filled` is
 * the look the workspace module forms use inside their sheets. Two skins, ONE
 * implementation — the module forms previously had their own copy of this
 * component, and that copy had silently dropped the accessibility label and the
 * RTL text alignment.
 */
export type FormFieldVariant = "bordered" | "filled";

export type FormFieldProps = Readonly<{
  accessibilityLabel?: string;
  autoCapitalize?: TextInputProps["autoCapitalize"];
  autoFocus?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  /** Inline validation message. Rendered under the field and announced with it. */
  error?: string;
  inputRef?: Ref<TextInputHandle>;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  onSubmitEditing?: () => void;
  placeholder?: string;
  returnKeyType?: ReturnKeyTypeOptions;
  testID?: string;
  value: string;
  variant?: FormFieldVariant;
}>;

export function FormField({
  accessibilityLabel,
  autoCapitalize,
  autoFocus = false,
  containerStyle,
  error,
  inputRef,
  keyboardType = "default",
  label,
  multiline = false,
  onChangeText,
  onSubmitEditing,
  placeholder,
  returnKeyType,
  testID,
  value,
  variant = "bordered",
}: FormFieldProps) {
  const { isRtl, locale } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
  const filled = variant === "filled";
  const chained = Boolean(onSubmitEditing) && !multiline;

  // "next" when this field hands off to another, "done" when it is the last
  // one. Without this every field showed a generic return key and the user had
  // to dismiss the keyboard and tap the next input by hand.
  const resolvedReturnKeyType = returnKeyType ?? (chained ? "next" : "done");

  return (
    <View style={[styles.field, containerStyle]}>
      <Text
        style={[
          filled ? styles.labelFilled : styles.label,
          filled ? undefined : getTypographyStyle("label", locale, fontsLoaded),
        ]}
      >
        {label}
      </Text>
      <TextInput
        // React Native has no htmlFor equivalent, so the visible label above
        // is not announced with the input; without this, every field in the
        // app reads as an unlabelled text box. The error is folded in so a
        // screen reader hears WHICH field is wrong and why.
        accessibilityLabel={
          error ? `${accessibilityLabel ?? label}, ${error}` : (accessibilityLabel ?? label)
        }
        autoCapitalize={autoCapitalize}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.mutedText}
        ref={inputRef}
        returnKeyType={resolvedReturnKeyType}
        // Keep the keyboard up while focus moves on to the next field.
        submitBehavior={chained ? "submit" : undefined}
        style={[
          filled ? styles.inputFilled : styles.input,
          multiline && (filled ? styles.multilineInputFilled : styles.multilineInput),
          Boolean(error) && styles.inputInvalid,
          filled ? undefined : getTypographyStyle("body", locale, fontsLoaded),
          { textAlign: isRtl ? "right" : "left" },
        ]}
        testID={testID}
        textAlignVertical={multiline ? "top" : "center"}
        value={value}
      />
      {error ? (
        <Text
          style={[
            styles.errorText,
            filled ? undefined : getTypographyStyle("caption", locale, fontsLoaded),
          ]}
          testID={testID ? `${testID}-error` : undefined}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.mutedText,
  },
  labelFilled: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
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
  inputFilled: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    // A transparent border keeps the box the same size in both states, so
    // showing an error does not shift the rest of the form down.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    fontSize: 16,
    paddingHorizontal: theme.spacing.md,
  },
  inputInvalid: {
    borderColor: theme.colors.danger,
  },
  multilineInput: {
    minHeight: 86,
  },
  multilineInputFilled: {
    minHeight: 96,
    paddingTop: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
