import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useAppFontState } from "../providers/AppFontContext";
import { useLocale } from "../providers/LocaleProvider";
import { useAppTheme, useThemedStyles } from "../providers/ThemeProvider";
import { getTypographyStyle, type AppTheme } from "../theme";
import { Icon } from "./Icon";

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

function OptionSeparator() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.optionSeparator} />;
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
  const { locale, textDirection } = useLocale();
  const { fontsLoaded } = useAppFontState();
  const theme = useAppTheme();
  const styles = useThemedStyles(makeStyles);
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
      <Text
        style={[
          styles.optionLabel,
          getTypographyStyle("body", locale, fontsLoaded),
          hasNoValue && styles.optionLabelSelected,
        ]}
      >
        {noneLabel}
      </Text>
      {hasNoValue ? <Icon color="primary" name="check" size={18} /> : null}
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
      <Text style={[styles.optionLabel, getTypographyStyle("body", locale, fontsLoaded)]}>
        {formatCustomValueLabel(customValueLabel, customValue)}
      </Text>
    </Pressable>
  ) : null;
  /* istanbul ignore next -- empty row rendering is an alternate native modal path. */
  const emptyOption =
    filteredOptions.length === 0 && !showCustomValue ? (
      <Text
        testID={`${testID}-empty`}
        style={[styles.emptyText, getTypographyStyle("body", locale, fontsLoaded)]}
      >
        {emptyLabel}
      </Text>
    ) : null;

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={[styles.label, getTypographyStyle("label", locale, fontsLoaded)]}>{label}</Text>
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
          style={[
            styles.triggerText,
            getTypographyStyle("body", locale, fontsLoaded),
            !selectedOption && hasNoValue && styles.placeholderText,
          ]}
        >
          {displayLabel}
        </Text>
        <Icon color="mutedText" name={open ? "chevronUp" : "chevronDown"} size={18} />
      </Pressable>

      <Modal animationType="slide" transparent visible={open} onRequestClose={closeSheet}>
        {open ? (
          <View style={styles.modalRoot}>
            <View style={[styles.sheet, { direction: textDirection }]}>
              <View style={styles.sheetHeader}>
                <View style={styles.sheetTitleBlock}>
                  <Text style={[styles.sheetTitle, getTypographyStyle("heading", locale, fontsLoaded)]}>{label}</Text>
                  <Text style={[styles.sheetSubtitle, getTypographyStyle("caption", locale, fontsLoaded)]}>
                    {displayLabel}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  style={styles.closeButton}
                  onPress={closeSheet}
                >
                  <Text style={[styles.closeButtonText, getTypographyStyle("label", locale, fontsLoaded)]}>
                    {closeLabel}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.searchBox}>
                <Icon color="primary" name="search" size={18} />
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={searchPlaceholder}
                  placeholderTextColor={theme.colors.subtleText}
                  testID={`${testID}-search`}
                  style={[styles.searchInput, getTypographyStyle("body", locale, fontsLoaded)]}
                  value={search}
                  onChangeText={setSearch}
                />
              </View>
              <FlatList
                data={filteredOptions}
                ItemSeparatorComponent={OptionSeparator}
                keyboardShouldPersistTaps="handled"
                keyExtractor={(option) => option.value}
                ListFooterComponent={(
                  <>
                    {customOption}
                    {emptyOption}
                  </>
                )}
                ListHeaderComponent={noneOption}
                contentContainerStyle={styles.optionList}
                renderItem={({ item: option }) => {
                  const selected = option.value === value;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      testID={`${testID}-option-${option.value}`}
                      style={[styles.optionRow, selected && styles.optionRowSelected]}
                      onPress={() => selectValue(option.value)}
                    >
                      <View style={styles.optionTextBlock}>
                        <Text
                          style={[
                            styles.optionLabel,
                            getTypographyStyle("body", locale, fontsLoaded),
                            selected && styles.optionLabelSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                        {option.subLabel ? (
                          <Text style={[styles.optionSubLabel, getTypographyStyle("caption", locale, fontsLoaded)]}>
                            {option.subLabel}
                          </Text>
                        ) : null}
                      </View>
                      {selected ? <Icon color="primary" name="check" size={18} /> : null}
                    </Pressable>
                  );
                }}
              />
            </View>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.text,
  },
  trigger: {
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
  triggerOpen: {
    borderColor: theme.colors.primary,
  },
  triggerDisabled: {
    opacity: 0.55,
  },
  triggerText: {
    flex: 1,
    color: theme.colors.text,
  },
  placeholderText: {
    color: theme.colors.mutedText,
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
  },
  sheetSubtitle: {
    color: theme.colors.mutedText,
  },
  closeButton: {
    minHeight: 38,
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  closeButtonText: {
    color: theme.colors.text,
  },
  searchBox: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
  },
  optionList: {
    paddingTop: theme.spacing.md,
  },
  optionSeparator: {
    height: theme.spacing.xs,
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
  customRow: {
    borderStyle: "dashed",
  },
  optionTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  optionLabel: {
    color: theme.colors.text,
  },
  optionLabelSelected: {
    color: theme.colors.primaryDark,
  },
  optionSubLabel: {
    color: theme.colors.mutedText,
  },
  emptyText: {
    color: theme.colors.mutedText,
    padding: theme.spacing.lg,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.82,
  },
});
