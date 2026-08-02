/// <reference types="jest" />

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createRef } from "react";
import { TextInput } from "react-native";

import { LocaleProvider } from "../providers/LocaleProvider";
import { FormField } from "./FormField";

function renderField(element: React.ReactElement) {
  return render(<LocaleProvider>{element}</LocaleProvider>);
}

/** The resolved textAlign from the input's flattened style array. */
function alignmentOf(input: { props: Record<string, unknown> }): string | undefined {
  const style = input.props.style as Array<{ textAlign?: string } | false | undefined>;
  return style
    .filter(Boolean)
    .map((entry) => (entry as { textAlign?: string })?.textAlign)
    .find(Boolean);
}

describe("FormField", () => {
  test("labels the input for screen readers, since React Native has no htmlFor", async () => {
    const { getByLabelText } = await renderField(
      <FormField label="Phone" value="" onChangeText={jest.fn()} />,
    );

    expect(getByLabelText("Phone")).toBeTruthy();
  });

  test("prefers an explicit accessibilityLabel over the visible label", async () => {
    const { getByLabelText } = await renderField(
      <FormField
        accessibilityLabel="Customer phone number"
        label="Phone"
        value=""
        onChangeText={jest.fn()}
      />,
    );

    expect(getByLabelText("Customer phone number")).toBeTruthy();
  });

  test("shows an inline error and announces it with the field", async () => {
    const { getByLabelText, getByTestId } = await renderField(
      <FormField
        error="Name is required"
        label="Name"
        testID="name-field"
        value=""
        onChangeText={jest.fn()}
      />,
    );

    // A screen reader must hear WHICH field is wrong and why, in one utterance.
    expect(getByLabelText("Name, Name is required")).toBeTruthy();
    expect(getByTestId("name-field-error").props.children).toBe("Name is required");
  });

  test("renders no error node when the field is valid", async () => {
    const { queryByTestId } = await renderField(
      <FormField label="Name" testID="name-field" value="Sara" onChangeText={jest.fn()} />,
    );

    expect(queryByTestId("name-field-error")).toBeNull();
  });

  test("defaults the return key to done, and to next once a field hands off", async () => {
    const last = await renderField(
      <FormField label="Last" testID="last" value="" onChangeText={jest.fn()} />,
    );
    expect(last.getByTestId("last").props.returnKeyType).toBe("done");

    const chained = await renderField(
      <FormField
        label="First"
        testID="first"
        value=""
        onChangeText={jest.fn()}
        onSubmitEditing={jest.fn()}
      />,
    );
    expect(chained.getByTestId("first").props.returnKeyType).toBe("next");
    // Keeps the keyboard up while focus moves on.
    expect(chained.getByTestId("first").props.submitBehavior).toBe("submit");
  });

  test("an explicit returnKeyType wins over the inferred one", async () => {
    const { getByTestId } = await renderField(
      <FormField
        label="Search"
        returnKeyType="search"
        testID="search"
        value=""
        onChangeText={jest.fn()}
        onSubmitEditing={jest.fn()}
      />,
    );

    expect(getByTestId("search").props.returnKeyType).toBe("search");
  });

  test("a multiline field keeps its return key for newlines rather than chaining", async () => {
    const { getByTestId } = await renderField(
      <FormField
        label="Notes"
        multiline
        testID="notes"
        value=""
        onChangeText={jest.fn()}
        onSubmitEditing={jest.fn()}
      />,
    );

    expect(getByTestId("notes").props.returnKeyType).toBe("done");
    expect(getByTestId("notes").props.submitBehavior).toBeUndefined();
  });

  test("fires onSubmitEditing so a parent can move focus", async () => {
    const onSubmitEditing = jest.fn();
    const { getByTestId } = await renderField(
      <FormField
        label="First"
        testID="first"
        value=""
        onChangeText={jest.fn()}
        onSubmitEditing={onSubmitEditing}
      />,
    );

    await fireEvent(getByTestId("first"), "submitEditing");

    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
  });

  test("forwards a ref so a form can focus the field programmatically", async () => {
    const inputRef = createRef<TextInput>();
    await renderField(
      <FormField inputRef={inputRef} label="First" value="" onChangeText={jest.fn()} />,
    );

    expect(inputRef.current).not.toBeNull();
  });

  test("aligns text to the right under the default Arabic locale", async () => {
    const { getByTestId } = await renderField(
      <FormField label="Name" testID="name" value="" onChangeText={jest.fn()} />,
    );

    expect(alignmentOf(getByTestId("name"))).toBe("right");
  });

  test("aligns text to the left once the locale is English", async () => {
    (SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>)
      .mockResolvedValueOnce("en");

    const { getByTestId } = await renderField(
      <FormField label="Name" testID="name" value="" onChangeText={jest.fn()} />,
    );

    await waitFor(() => {
      expect(alignmentOf(getByTestId("name"))).toBe("left");
    });
  });

  test("renders an inline error even when the field has no testID", async () => {
    const { getByText } = await renderField(
      <FormField error="Required" label="Name" value="" onChangeText={jest.fn()} />,
    );

    expect(getByText("Required")).toBeTruthy();
  });

  test("renders the filled variant used by the module forms", async () => {
    const { getByTestId, getByText } = await renderField(
      <FormField
        error="Too long"
        label="Address"
        multiline
        testID="address"
        value=""
        variant="filled"
        onChangeText={jest.fn()}
      />,
    );

    expect(getByText("Address")).toBeTruthy();
    expect(getByTestId("address-error")).toBeTruthy();
  });

  test("passes through the keyboard, capitalization and placeholder settings", async () => {
    const onChangeText = jest.fn();
    const { getByPlaceholderText, getByTestId } = await renderField(
      <FormField
        autoCapitalize="none"
        autoFocus
        keyboardType="email-address"
        label="Email"
        placeholder="you@example.com"
        testID="email"
        value=""
        onChangeText={onChangeText}
      />,
    );

    const input = getByTestId("email");
    expect(input.props.keyboardType).toBe("email-address");
    expect(input.props.autoCapitalize).toBe("none");
    expect(input.props.autoFocus).toBe(true);
    expect(getByPlaceholderText("you@example.com")).toBeTruthy();

    await act(async () => {
      fireEvent.changeText(input, "sara@example.com");
    });
    expect(onChangeText).toHaveBeenCalledWith("sara@example.com");
  });
});
