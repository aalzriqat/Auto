/// <reference types="jest" />

import type { ReactNode } from "react";

jest.mock("react-native", () => {
  const actual = jest.requireActual<typeof import("react-native")>("react-native");
  const React = jest.requireActual<typeof import("react")>("react");

  function MockModal({ children, visible }: { children?: ReactNode; visible?: boolean }) {
    return visible ? React.createElement(actual.View, null, children) : null;
  }

  return new Proxy(actual, {
    get(target, property, receiver) {
      if (property === "Modal") return MockModal;
      return Reflect.get(target, property, receiver);
    },
  });
});

jest.mock("@expo/vector-icons", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    Ionicons: ({
      accessibilityLabel,
      color,
      name,
      size,
      testID,
    }: {
      accessibilityLabel?: string;
      color?: string;
      name: string;
      size?: number;
      testID?: string;
    }) =>
      React.createElement(
        Text,
        { accessibilityLabel, testID: testID ?? "ionicon" },
        `${name}:${color}:${size}`,
      ),
  };
});

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { StyleSheet, Text, View } from "react-native";

import { LocaleProvider } from "../providers/LocaleProvider";
import { Badge, Pill } from "./Badge";
import { Button, getButtonPressedStyle } from "./Button";
import { Card, getCardPressedStyle } from "./Card";
import { EmptyState } from "./EmptyState";
import { FormField } from "./FormField";
import { GuidedStepFlow, getSafeStepIndex } from "./GuidedStepFlow";
import { Icon, resolveIconGlyph, semanticIconGlyphs } from "./Icon";
import { ListRow, getListRowPressedStyle } from "./ListRow";
import { getLocaleTogglePressedStyle, LocaleToggle } from "./LocaleToggle";
import { getRouteButtonPressedStyle, RouteErrorState, RouteLoadingState } from "./RouteState";
import { Screen } from "./Screen";
import {
  filterSearchableOptions,
  formatCustomValueLabel,
  SearchableSelectField,
  type SearchableSelectOption,
} from "./SearchableSelectField";
import { SectionHeader, getSectionActionPressedStyle } from "./SectionHeader";
import { SkeletonRow } from "./SkeletonRow";
import { StatTile } from "./StatTile";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

describe("mobile shell components", () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
  });

  test("renders screen children inside the shared surface", async () => {
    const { getByText } = await render(
      <Screen>
        <Text>Inside shell</Text>
      </Screen>,
    );

    expect(getByText("Inside shell")).toBeTruthy();

    const scrollScreen = await render(
      <Screen scroll padding="lg">
        <Text>Scrollable shell</Text>
      </Screen>,
    );
    expect(scrollScreen.getByText("Scrollable shell")).toBeTruthy();
  });

  test("renders semantic icons with token colors and RTL directional flipping", async () => {
    expect(semanticIconGlyphs.vehicles).toBe("car-sport-outline");
    expect(resolveIconGlyph("back", false)).toBe("chevron-back");
    expect(resolveIconGlyph("back", true)).toBe("chevron-forward");
    expect(resolveIconGlyph("vehicles", true)).toBe("car-sport-outline");

    getItemAsync.mockResolvedValueOnce("en");
    const ltrIcon = await render(
      <LocaleProvider>
        <Icon accessibilityLabel="Search icon" color="primary" name="search" size={24} testID="search-icon" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(ltrIcon.getByTestId("search-icon").props.children).toBe("search:#0f766e:24");
    });
    expect(ltrIcon.getByLabelText("Search icon")).toBeTruthy();

    const rtlIcon = await render(
      <LocaleProvider>
        <Icon name="back" testID="back-icon" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(rtlIcon.getByTestId("back-icon").props.children).toBe("chevron-forward:#0f172a:20");
    });
  });

  test("renders modern card and button primitives with press feedback", async () => {
    const onCardPress = jest.fn();
    const onButtonPress = jest.fn();
    const { getByLabelText, getByText } = await render(
      <LocaleProvider>
        <View>
          <Card testID="static-card">
            <Text>Static card</Text>
          </Card>
          <Card accessibilityLabel="Open card" onPress={onCardPress}>
            <Text>Pressable card</Text>
          </Card>
          <Button label="Save" leadingIcon="save" onPress={onButtonPress} />
          <Button disabled label="Disabled" onPress={onButtonPress} variant="secondary" />
          <Button label="Delete" onPress={onButtonPress} variant="danger" />
          <Button label="Preview" onPress={onButtonPress} variant="ghost" />
        </View>
      </LocaleProvider>,
    );

    expect(getCardPressedStyle(false)).toBeNull();
    expect(getCardPressedStyle(true)).not.toBeNull();
    expect(getButtonPressedStyle(false)).toBeNull();
    expect(getButtonPressedStyle(true)).not.toBeNull();
    expect(getButtonPressedStyle(true, true)).toBeNull();

    await fireEvent.press(getByLabelText("Open card"));
    await fireEvent.press(getByText("Save"));
    await fireEvent.press(getByText("Disabled"));

    expect(onCardPress).toHaveBeenCalledTimes(1);
    expect(onButtonPress).toHaveBeenCalledTimes(1);
    expect(getByText("Delete")).toBeTruthy();
    expect(getByText("Preview")).toBeTruthy();
  });

  test("renders modern display primitives for stats, empty states, rows, badges, and skeletons", async () => {
    const onAction = jest.fn();
    const onRowPress = jest.fn();
    const rendered = await render(
      <LocaleProvider>
        <View>
          <StatTile caption="vs last month" icon="sales" label="Revenue" tone="success" value="42K" />
          <StatTile icon="tasks" label="Open tasks" tone="warning" value="8" />
          <StatTile icon="reports" label="Reports" value="4" />
          <EmptyState actionLabel="Reset" hint="Try another filter." icon="search" onAction={onAction} title="No results" />
          <EmptyState title="No data" />
          <ListRow leadingIcon="vehicles" meta="12 available" onPress={onRowPress} title="Inventory" />
          <ListRow avatarLabel="AF" title="AutoFlow" />
          <ListRow title="Plain row" />
          <SectionHeader actionLabel="View all" onAction={onAction} subtitle="Latest activity" title="Pipeline" />
          <SectionHeader title="Finance" />
          <Badge label="Pending" tone="warning" />
          <Badge label="Neutral" />
          <Pill label="Synced" tone="success" />
          <Pill label="Default pill" />
          <SkeletonRow count={2} />
          <SkeletonRow />
        </View>
      </LocaleProvider>,
    );

    expect(getListRowPressedStyle(false)).toBeNull();
    expect(getListRowPressedStyle(true)).not.toBeNull();
    expect(getSectionActionPressedStyle(false)).toBeNull();
    expect(getSectionActionPressedStyle(true)).not.toBeNull();

    await fireEvent.press(rendered.getByLabelText("Inventory"));
    await fireEvent.press(rendered.getByText("Reset"));
    await fireEvent.press(rendered.getByText("View all"));

    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(rendered.getByText("42K")).toBeTruthy();
    expect(rendered.getByText("No data")).toBeTruthy();
    expect(rendered.getByText("Pending")).toBeTruthy();
    expect(rendered.getByText("Neutral")).toBeTruthy();
    expect(rendered.getAllByTestId("skeleton-row")).toHaveLength(3);
  });

  test("reports shared form field text changes", async () => {
    const onChangeText = jest.fn();
    const defaultField = await render(
      <LocaleProvider>
        <FormField label="Name" value="initial" onChangeText={onChangeText} />
      </LocaleProvider>,
    );

    await fireEvent.changeText(defaultField.getByDisplayValue("initial"), "next");

    expect(defaultField.getByText("Name")).toBeTruthy();
    expect(onChangeText).toHaveBeenCalledWith("next");
  });

  test("passes multiline and keyboard settings to shared form fields", async () => {
    const onChangeText = jest.fn();
    const multilineField = await render(
      <LocaleProvider>
        <FormField
          keyboardType="number-pad"
          label="Notes"
          multiline
          onChangeText={onChangeText}
          value="long"
        />
      </LocaleProvider>,
    );

    expect(multilineField.getByDisplayValue("long").props.multiline).toBe(true);
    expect(multilineField.getByDisplayValue("long").props.keyboardType).toBe("number-pad");
  });

  test("aligns shared form fields with the loaded locale direction", async () => {
    const onChangeText = jest.fn();
    const rtlField = await render(
      <LocaleProvider>
        <FormField label="City" onChangeText={onChangeText} value="Amman" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(StyleSheet.flatten(rtlField.getByDisplayValue("Amman").props.style).textAlign).toBe("right");
    });

    getItemAsync.mockResolvedValueOnce("en");
    const ltrField = await render(
      <LocaleProvider>
        <FormField label="City" onChangeText={onChangeText} value="Amman" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(StyleSheet.flatten(ltrField.getByDisplayValue("Amman").props.style).textAlign).toBe("left");
    });
  });

  test("filters searchable select options by label, value, and sub label", () => {
    const options: SearchableSelectOption[] = [
      { label: "Camry", subLabel: "Toyota sedan", value: "camry-id" },
      { label: "Accord", subLabel: "Honda sedan", value: "accord-id" },
      { label: "Sportage", value: "sportage-id" },
    ];

    expect(filterSearchableOptions(options, "")).toHaveLength(3);
    expect(filterSearchableOptions(options, "cam")).toEqual([options[0]]);
    expect(filterSearchableOptions(options, "honda")).toEqual([options[1]]);
    expect(filterSearchableOptions(options, "sportage-id")).toEqual([options[2]]);
    expect(filterSearchableOptions(options, "missing")).toEqual([]);
    expect(formatCustomValueLabel(undefined, "Genesis")).toBe("Genesis");
    expect(formatCustomValueLabel('Use "{value}"', "Lucid")).toBe('Use "Lucid"');
  });

  test("renders guided step flow state and clamps active step indexes", async () => {
    expect(getSafeStepIndex(0, 4)).toBe(0);
    expect(getSafeStepIndex(3, -1)).toBe(0);
    expect(getSafeStepIndex(3, 8)).toBe(2);
    expect(getSafeStepIndex(3, 1)).toBe(1);

    const steps = [
      { title: "Contact", subtitle: "Buyer info" },
      { title: "Vehicle" },
      { title: "Review", subtitle: "Final check" },
    ];
    const flow = await render(
      <LocaleProvider>
        <GuidedStepFlow activeIndex={1} steps={steps}>
          <Text>Step body</Text>
        </GuidedStepFlow>
      </LocaleProvider>,
    );

    await waitFor(() => expect(flow.getByText("2/3")).toBeTruthy());
    expect(flow.getByText("2/3")).toBeTruthy();
    expect(flow.getByText("Vehicle")).toBeTruthy();
    expect(flow.queryByText("Buyer info")).toBeNull();
    expect(flow.getByText("Step body")).toBeTruthy();

    await flow.rerender(
      <LocaleProvider>
        <GuidedStepFlow activeIndex={0} steps={steps}>
          <Text>Step body</Text>
        </GuidedStepFlow>
      </LocaleProvider>,
    );
    expect(flow.getByText("Buyer info")).toBeTruthy();

    const emptyFlow = await render(
      <LocaleProvider>
        <GuidedStepFlow activeIndex={3} steps={[]}>
          <Text>No steps body</Text>
        </GuidedStepFlow>
      </LocaleProvider>,
    );
    expect(emptyFlow.getByText("No steps body")).toBeTruthy();
    expect(emptyFlow.queryByText("0/0")).toBeNull();
  });

  test("renders loading and error states with retry behavior", async () => {
    const retry = jest.fn();
    const loading = await render(<RouteLoadingState label="Loading workspace" />);
    expect(loading.getByText("Loading workspace")).toBeTruthy();

    const fallbackError = await render(<RouteErrorState />);
    expect(fallbackError.getByText("An unexpected error occurred.")).toBeTruthy();

    const explicitError = await render(<RouteErrorState message="Could not load" onRetry={retry} />);
    const retryText = explicitError.getByText("Retry");

    expect(getRouteButtonPressedStyle(false)).toBeNull();
    expect(getRouteButtonPressedStyle(true)).not.toBeNull();
    await fireEvent(retryText, "pressIn");
    await fireEvent(retryText, "pressOut");
    await fireEvent.press(retryText);

    expect(explicitError.getByText("Could not load")).toBeTruthy();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("switches locale from Arabic to English in the compact locale toggle", async () => {
    const { getByLabelText, getByText } = await render(
      <LocaleProvider>
        <LocaleToggle />
      </LocaleProvider>,
    );

    const toggle = getByLabelText("Switch to English");
    expect(getLocaleTogglePressedStyle(false)).toBeNull();
    expect(getLocaleTogglePressedStyle(true)).not.toBeNull();
    await fireEvent(toggle, "pressIn");
    await fireEvent(toggle, "pressOut");
    await fireEvent.press(toggle);

    expect(getByText("AR")).toBeTruthy();
  });

  test("switches locale from English to Arabic in the compact locale toggle", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    const { getByLabelText, getByText } = await render(
      <LocaleProvider>
        <LocaleToggle />
      </LocaleProvider>,
    );

    await fireEvent.press(getByLabelText("Switch to Arabic"));

    expect(getByText("EN")).toBeTruthy();
  });

  test("drives searchable select sheet interactions", async () => {
    const onChange = jest.fn();
    const options: SearchableSelectOption[] = [
      { label: "Camry", subLabel: "Toyota", value: "camry" },
      { label: "Accord", value: "accord" },
    ];
    const picker = await render(
      <LocaleProvider>
        <View>
          <SearchableSelectField
            allowCustomValue
            closeLabel="Done"
            customValueLabel={'Use "{value}"'}
            label="Vehicle"
            noneLabel="Any vehicle"
            options={options}
            searchPlaceholder="Find vehicle"
            testID="vehicle"
            value="camry"
            onChange={onChange}
          />
          <SearchableSelectField
            emptyLabel="Nothing here"
            label="Empty"
            noneLabel="Any empty"
            options={[]}
            searchPlaceholder="Find empty"
            testID="empty"
            value=""
            onChange={onChange}
          />
          <SearchableSelectField
            allowCustomValue
            label="Raw custom"
            options={[]}
            searchPlaceholder="Find raw"
            testID="raw-custom"
            value=""
            onChange={onChange}
          />
          <SearchableSelectField label="Default id" options={[]} value="" onChange={onChange} />
          <SearchableSelectField disabled label="Disabled" options={[]} testID="disabled" onChange={onChange} />
        </View>
      </LocaleProvider>,
    );

    fireEvent.press(picker.getByTestId("disabled-trigger"));
    expect(picker.queryByTestId("disabled-search")).toBeNull();
    expect(picker.getByText("Any empty")).toBeTruthy();

    fireEvent(picker.getByTestId("vehicle-trigger"), "pressIn");
    fireEvent(picker.getByTestId("vehicle-trigger"), "pressOut");
    fireEvent.press(picker.getByTestId("vehicle-trigger"));
    await waitFor(() => expect(picker.getByTestId("vehicle-search")).toBeTruthy());
    expect(picker.getByText("Toyota")).toBeTruthy();
    await fireEvent.changeText(picker.getByTestId("vehicle-search"), "Genesis");
    await waitFor(() => expect(picker.getByText('Use "Genesis"')).toBeTruthy());
    fireEvent(picker.getByTestId("vehicle-custom"), "pressIn");
    fireEvent(picker.getByTestId("vehicle-custom"), "pressOut");
    await fireEvent.changeText(picker.getByTestId("vehicle-search"), "accord");
    await waitFor(() => expect(picker.getByText("Accord")).toBeTruthy());
    fireEvent.press(picker.getByTestId("vehicle-option-accord"));
    expect(onChange).toHaveBeenCalledWith("accord");
    await waitFor(() => expect(picker.queryByTestId("vehicle-search")).toBeNull());
  });
});
