/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";

import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { LeadStagePicker } from "./LeadStagePicker";

type AlertButton = Readonly<{
  onPress?: () => void;
  style?: string;
  text?: string;
}>;

async function renderPicker(props: Partial<React.ComponentProps<typeof LeadStagePicker>> = {}) {
  const onSelect = props.onSelect ?? jest.fn();
  const result = await render(
    <ThemeProvider>
      <LocaleProvider>
        <LeadStagePicker stage="NEW" {...props} onSelect={onSelect} />
      </LocaleProvider>
    </ThemeProvider>,
  );
  return { ...result, onSelect };
}

describe("LeadStagePicker", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("opens the whole pipeline from one tap, forwards and backwards", async () => {
    const { getByTestId, onSelect } = await renderPicker({ stage: "NEGOTIATION" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));

    // Every stage is reachable in a single interaction, including earlier ones.
    expect(getByTestId("lead-stage-option-NEW")).toBeTruthy();
    expect(getByTestId("lead-stage-option-RESERVED")).toBeTruthy();

    await fireEvent.press(getByTestId("lead-stage-option-CONTACTED"));
    expect(onSelect).toHaveBeenCalledWith("CONTACTED");
  });

  test("selecting the current stage writes nothing", async () => {
    const { getByTestId, onSelect } = await renderPicker({ stage: "NEW" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByTestId("lead-stage-option-NEW"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("confirms a terminal stage instead of firing it on a single tap", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const { getByTestId, onSelect } = await renderPicker({ stage: "NEGOTIATION" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByTestId("lead-stage-option-LOST"));

    expect(onSelect).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.style)).toEqual(["cancel", "destructive"]);

    // Only confirming applies it.
    buttons[1]?.onPress?.();
    expect(onSelect).toHaveBeenCalledWith("LOST");
  });

  test("cancelling a terminal move leaves the lead where it was", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const { getByTestId, onSelect } = await renderPicker({ stage: "RESERVED" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByTestId("lead-stage-option-WON"));

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    buttons[0]?.onPress?.();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("blocks re-entry and shows progress while a write is in flight", async () => {
    const { getByTestId, queryByTestId, onSelect } = await renderPicker({ busy: true, stage: "NEW" });

    expect(getByTestId("lead-stage-busy")).toBeTruthy();

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    expect(queryByTestId("lead-stage-option-CONTACTED")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // LocaleProvider's DEFAULT_LOCALE is "ar", so an unconfigured render is the
  // Arabic/RTL one — which makes these the assertions that matter most.
  test("labels the trigger with the localized stage, never the raw enum key", async () => {
    const { getByLabelText, queryByText } = await renderPicker({ stage: "TEST_DRIVE" });

    expect(getByLabelText("المرحلة: تجربة")).toBeTruthy();
    expect(queryByText("TEST_DRIVE")).toBeNull();
  });

  test("renders the compact pill variant with the same options", async () => {
    const { getByTestId, onSelect } = await renderPicker({ compact: true, stage: "NEW" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByTestId("lead-stage-option-INTERESTED"));

    expect(onSelect).toHaveBeenCalledWith("INTERESTED");
  });

  test("closes without selecting from the close button and the scrim", async () => {
    const { getByTestId, getByLabelText, queryByTestId, onSelect } = await renderPicker({ stage: "NEW" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByTestId("lead-stage-close"));
    expect(queryByTestId("lead-stage-option-CONTACTED")).toBeNull();

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    await fireEvent.press(getByLabelText("إغلاق"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("is inert when disabled", async () => {
    const { getByTestId, queryByTestId } = await renderPicker({ disabled: true, stage: "NEW" });

    await fireEvent.press(getByTestId("lead-stage-trigger"));
    expect(queryByTestId("lead-stage-option-CONTACTED")).toBeNull();
  });
});
