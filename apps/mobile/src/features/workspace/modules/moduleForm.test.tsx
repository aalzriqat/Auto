/// <reference types="jest" />

import { act, fireEvent, render } from "@testing-library/react-native";
import { useState } from "react";
import { Alert, Pressable, Text, View, type TextInput } from "react-native";

import { LocaleProvider } from "../../../providers/LocaleProvider";
import {
  FormField,
  requiredText,
  useFieldFocusChain,
  useFormErrors,
} from "./moduleShared";

/** Three chained fields, wired the way a module form wires them. */
function ChainedForm() {
  const chain = useFieldFocusChain(3);
  const [values, setValues] = useState(["", "", ""]);

  return (
    <View>
      {["Name", "Phone", "Email"].map((label, index) => (
        <FormField
          key={label}
          label={label}
          testID={`field-${index}`}
          value={values[index]}
          onChangeText={(next) =>
            setValues((current) => current.map((item, at) => (at === index ? next : item)))
          }
          {...chain.fieldProps(index)}
        />
      ))}
    </View>
  );
}

describe("module form fields", () => {
  test("announces its label, which the module forms' own copy had dropped", async () => {
    const { getByLabelText } = await render(
      <LocaleProvider>
        <FormField label="Branch name" value="" onChangeText={jest.fn()} />
      </LocaleProvider>,
    );

    // React Native has no htmlFor, so without an explicit accessibilityLabel
    // every field in every module form reads as an unlabelled text box.
    expect(getByLabelText("Branch name")).toBeTruthy();
  });

  test("aligns its text for RTL, which the module forms' own copy had dropped", async () => {
    const { getByTestId } = await render(
      <LocaleProvider>
        <FormField label="Branch name" testID="branch" value="" onChangeText={jest.fn()} />
      </LocaleProvider>,
    );

    const style = getByTestId("branch").props.style as Array<{ textAlign?: string } | false>;
    expect(
      style
        .filter(Boolean)
        .map((entry) => (entry as { textAlign?: string })?.textAlign)
        .find(Boolean),
    ).toBe("right");
  });

  test("surfaces an inline error instead of leaving the field unannotated", async () => {
    const { getByTestId } = await render(
      <LocaleProvider>
        <FormField
          error="Name is required"
          label="Branch name"
          testID="branch"
          value=""
          onChangeText={jest.fn()}
        />
      </LocaleProvider>,
    );

    expect(getByTestId("branch-error").props.children).toBe("Name is required");
  });

  test("walks the form with the return key instead of one tap per field", async () => {
    const { getByTestId } = await render(
      <LocaleProvider>
        <ChainedForm />
      </LocaleProvider>,
    );

    expect(getByTestId("field-0").props.returnKeyType).toBe("next");
    expect(getByTestId("field-1").props.returnKeyType).toBe("next");
    // The last field submits rather than pretending there is somewhere to go.
    expect(getByTestId("field-2").props.returnKeyType).toBe("done");

  });

  test("the return key hands focus to the next field, and stops at the last", async () => {
    let chain: ReturnType<typeof useFieldFocusChain> | undefined;
    function ChainProbe() {
      chain = useFieldFocusChain(2);
      return null;
    }
    await render(<ChainProbe />);

    const first = chain?.fieldProps(0);
    const second = chain?.fieldProps(1);
    const secondInput = { focus: jest.fn() } as unknown as TextInput;

    // The chain stores each field's handle through the ref it hands out.
    (second?.inputRef as (instance: TextInput | null) => void)(secondInput);
    first?.onSubmitEditing?.();

    expect(secondInput.focus).toHaveBeenCalledTimes(1);
    // Nothing to hand off to after the last field.
    expect(second?.onSubmitEditing).toBeUndefined();
  });

  test("names every failing field in one pass instead of one alert at a time", async () => {
    const alert = jest.spyOn(Alert, "alert");
    let form: ReturnType<typeof useFormErrors<"name" | "phone">> | undefined;

    function ValidatedForm() {
      form = useFormErrors<"name" | "phone">();
      const [values, setValues] = useState({ name: "", phone: "" });
      return (
        <View>
          <FormField
            error={form.errors.name}
            label="Name"
            testID="name"
            value={values.name}
            onChangeText={(name) => setValues((current) => ({ ...current, name }))}
          />
          <FormField
            error={form.errors.phone}
            label="Phone"
            testID="phone"
            value={values.phone}
            onChangeText={(phone) => setValues((current) => ({ ...current, phone }))}
          />
          <Pressable
            accessibilityRole="button"
            testID="save"
            onPress={() =>
              form?.validate({
                name: requiredText(values.name, "en"),
                phone: requiredText(values.phone, "en"),
              })
            }
          >
            <Text>Save</Text>
          </Pressable>
        </View>
      );
    }

    const { getByTestId, queryByTestId } = await render(
      <LocaleProvider>
        <ValidatedForm />
      </LocaleProvider>,
    );

    expect(queryByTestId("name-error")).toBeNull();
    await fireEvent.press(getByTestId("save"));

    // Both problems are on screen at once, attached to their own field.
    expect(getByTestId("name-error").props.children).toBe("This field is required");
    expect(getByTestId("phone-error").props.children).toBe("This field is required");
    // And nothing blocked the user with a modal to dismiss.
    expect(alert).not.toHaveBeenCalled();

    await fireEvent.changeText(getByTestId("name"), "Sara");
    await fireEvent.changeText(getByTestId("phone"), "0790000000");
    await fireEvent.press(getByTestId("save"));

    expect(queryByTestId("name-error")).toBeNull();
    expect(queryByTestId("phone-error")).toBeNull();
  });

  test("reset clears the messages so a reopened form does not start in error", async () => {
    let form: ReturnType<typeof useFormErrors<"name">> | undefined;
    function Probe() {
      form = useFormErrors<"name">();
      return null;
    }
    await render(<Probe />);

    await act(async () => {
      form?.validate({ name: "This field is required" });
    });
    expect(form?.errors.name).toBe("This field is required");

    await act(async () => {
      form?.reset();
    });
    expect(form?.errors.name).toBeUndefined();
  });

  test("survives a return press whose next field has not mounted", async () => {
    let chain: ReturnType<typeof useFieldFocusChain> | undefined;
    function ChainProbe() {
      chain = useFieldFocusChain(2);
      return null;
    }
    await render(<ChainProbe />);

    expect(() => chain?.fieldProps(0).onSubmitEditing?.()).not.toThrow();
  });
});
