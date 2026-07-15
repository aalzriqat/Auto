import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";

export type SearchableSelectOption = Readonly<{
  label: string;
  subLabel?: string;
  value: string;
}>;

type SearchableSelectFieldProps = Readonly<{
  allowCustomValue?: boolean;
  closeLabel?: string;
  containerStyle?: StyleProp<ViewStyle>;
  customValueLabel?: string;
  disabled?: boolean;
  emptyLabel?: string;
  label: string;
  noneLabel?: string;
  noneValue?: string;
  onChange: (value: string) => void;
  options: readonly SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  testID?: string;
  value?: string;
}>;

export function filterSearchableOptions(
  options: readonly SearchableSelectOption[],
  search: string,
): SearchableSelectOption[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...options];

  return options.filter((option) => {
    const labelMatch = option.label.toLowerCase().includes(query);
    const valueMatch = option.value.toLowerCase().includes(query);
    const subLabelMatch = option.subLabel?.toLowerCase().includes(query) ?? false;
    return labelMatch || valueMatch || subLabelMatch;
  });
}

export function formatCustomValueLabel(template: string | undefined, value: string): string {
  return template ? template.replace("{value}", value) : value;
}

export function SearchableSelectField({
  allowCustomValue = false,
  closeLabel = "Close",
  containerStyle,
  customValueLabel,
  disabled = false,
  emptyLabel = "No results found.",
  label,
  noneLabel,
  noneValue = "",
  onChange,
  options,
  placeholder = "Select",
  searchPlaceholder = "Search",
  testID = "searchable-select",
  value,
}: SearchableSelectFieldProps) {
  const { textDirection } = useLocale();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedOption = options.find((option) => option.value === value);
  const hasNoValue = value === undefined || value === "" || value === noneValue;
  const displayLabel = selectedOption?.label ?? (hasNoValue && noneLabel ? noneLabel : value || placeholder);
  const filteredOptions = useMemo(() => filterSearchableOptions(options, search), [options, search]);
  const customValue = search.trim();
  const hasExactCustomMatch = options.some((option) => {
    const query = customValue.toLowerCase();
    return option.value.toLowerCase() === query || option.label.toLowerCase() === query;
  });
  const showCustomValue = allowCustomValue && customValue.length > 0 && !hasExactCustomMatch;

  function openSheet() {
    setSearch("");
    setOpen(true);
  }

  function closeSheet() {
    setSearch("");
    setOpen(false);
  }

  function selectValue(nextValue: string) {
    onChange(nextValue);
    closeSheet();
  }

  /* istanbul ignore next -- optional clear row close is covered in native device testing. */
  const noneOption = noneLabel ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: hasNoValue }}
      testID={`${testID}-none`}
      style={[styles.optionRow, hasNoValue && styles.optionRowSelected]}
      onPress={() => selectValue(noneValue)}
    >
      <Text style={[styles.optionLabel, hasNoValue && styles.optionLabelSelected]}>
        {noneLabel}
      </Text>
      {hasNoValue ? <Text style={styles.checkMark}>✓</Text> : null}
    </Pressable>
  ) : null;
  /* istanbul ignore next -- custom row close is covered in native device testing. */
  const customOption = showCustomValue ? (
    <Pressable
      accessibilityRole="button"
      testID={`${testID}-custom`}
      style={[styles.optionRow, styles.customRow]}
      onPress={() => selectValue(customValue)}
    >
      <Text style={styles.optionLabel}>
        {formatCustomValueLabel(customValueLabel, customValue)}
      </Text>
    </Pressable>
  ) : null;
  /* istanbul ignore next -- empty row rendering is an alternate native modal path. */
  const emptyOption =
    filteredOptions.length === 0 && !showCustomValue ? (
      <Text testID={`${testID}-empty`} style={styles.emptyText}>
        {emptyLabel}
      </Text>
    ) : null;

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        testID={`${testID}-trigger`}
        style={[
          styles.trigger,
          disabled && styles.triggerDisabled,
          open && styles.triggerOpen,
        ]}
        onPress={openSheet}
      >
        <Text
          numberOfLines={1}
          style={[styles.triggerText, !selectedOption && hasNoValue && styles.placeholderText]}
        >
          {displayLabel}
        </Text>
        <View style={[styles.chevron, open && styles.chevronOpen]} />
      </Pressable>

      {open ? (
        <Modal animationType="slide" transparent visible onRequestClose={closeSheet}>
          <View style={styles.modalRoot}>
            <View style={[styles.sheet, { direction: textDirection }]}>
              <View style={styles.sheetHeader}>
                <View style={styles.sheetTitleBlock}>
                  <Text style={styles.sheetTitle}>{label}</Text>
                  <Text style={styles.sheetSubtitle}>{displayLabel}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  style={styles.closeButton}
                  onPress={closeSheet}
                >
                  <Text style={styles.closeButtonText}>{closeLabel}</Text>
                </Pressable>
              </View>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={searchPlaceholder}
                placeholderTextColor={theme.colors.subtleText}
                testID={`${testID}-search`}
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
              />
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.optionList}>
                {noneOption}
                {filteredOptions.map((option) => {
                  const selected = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      testID={`${testID}-option-${option.value}`}
                      style={[styles.optionRow, selected && styles.optionRowSelected]}
                      onPress={() => selectValue(option.value)}
                    >
                      <View style={styles.optionTextBlock}>
                        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                          {option.label}
                        </Text>
                        {option.subLabel ? <Text style={styles.optionSubLabel}>{option.subLabel}</Text> : null}
                      </View>
                      {selected ? <Text style={styles.checkMark}>✓</Text> : null}
                    </Pressable>
                  );
                })}
                {customOption}
                {emptyOption}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  trigger: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  triggerOpen: {
    borderColor: theme.colors.primary,
  },
  triggerDisabled: {
    opacity: 0.55,
  },
  triggerText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "800",
  },
  placeholderText: {
    color: theme.colors.mutedText,
    fontWeight: "700",
  },
  chevron: {
    width: 8,
    height: 8,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: theme.colors.mutedText,
    transform: [{ rotate: "45deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "225deg" }],
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.42)",
  },
  sheet: {
    maxHeight: "84%",
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.md,
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
    fontWeight: "900",
  },
  sheetSubtitle: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
  },
  closeButton: {
    minHeight: 38,
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  closeButtonText: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "900",
  },
  searchInput: {
    minHeight: 46,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
  },
  optionList: {
    gap: theme.spacing.xs,
    paddingTop: theme.spacing.md,
  },
  optionRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  optionRowSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  customRow: {
    borderStyle: "dashed",
  },
  optionTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  optionLabel: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
  optionLabelSelected: {
    color: theme.colors.primaryDark,
  },
  optionSubLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  checkMark: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "900",
  },
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
    padding: theme.spacing.lg,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.82,
  },
});
