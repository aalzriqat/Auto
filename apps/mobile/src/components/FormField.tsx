import type { KeyboardTypeOptions, StyleProp, ViewStyle } from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";

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
  const { isRtl } = useLocale();

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholderTextColor="#94a3b8"
        style={[
          styles.input,
          multiline && styles.multilineInput,
          { textAlign: isRtl ? "right" : "left" },
        ]}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: theme.spacing.xs,
  },
  fieldLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
  },
  input: {
    minHeight: 46,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
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
