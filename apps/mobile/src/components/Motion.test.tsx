/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";

import { PressableScale } from "./Motion";

describe("PressableScale", () => {
  test("springs on press and fires onPress", async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await render(
      <PressableScale accessibilityLabel="scale-target" onPress={onPress} scaleTo={0.94}>
        <Text>tap me</Text>
      </PressableScale>,
    );

    const target = getByLabelText("scale-target");
    await fireEvent(target, "pressIn");
    await fireEvent(target, "pressOut");
    await fireEvent.press(target);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("renders a disabled instance with default props", async () => {
    const { getByText } = await render(
      <PressableScale disabled>
        <Text>static</Text>
      </PressableScale>,
    );

    expect(getByText("static")).toBeTruthy();
  });
});
