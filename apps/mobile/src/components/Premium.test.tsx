/// <reference types="jest" />

import { render } from "@testing-library/react-native";
import { Text } from "react-native";

import { GlassCard, GradientFill, GradientHero } from "./Premium";

describe("Premium building blocks", () => {
  test("GradientFill renders every direction and stop configuration", async () => {
    // multi-stop vertical (offset = index / (len - 1))
    expect((await render(<GradientFill colors={["#111111", "#222222", "#333333"]} direction="vertical" />)).toJSON()).toBeTruthy();
    // horizontal endpoints
    expect((await render(<GradientFill colors={["#111111", "#222222"]} direction="horizontal" />)).toJSON()).toBeTruthy();
    // single stop (offset = 0) + diagonal endpoints
    expect((await render(<GradientFill colors={["#111111"]} direction="diagonal" />)).toJSON()).toBeTruthy();
    // empty colors falls back to the theme hero stop, default (vertical) direction
    expect((await render(<GradientFill colors={[]} />)).toJSON()).toBeTruthy();
  });

  test("GradientHero renders defaults, custom props, and children", async () => {
    const withDefaults = await render(
      <GradientHero>
        <Text>hero-child</Text>
      </GradientHero>,
    );
    expect(withDefaults.getByText("hero-child")).toBeTruthy();

    const custom = await render(
      <GradientHero colors={["#0a0a0a", "#1a1a1a"]} direction="horizontal" style={{ margin: 4 }} />,
    );
    expect(custom.toJSON()).toBeTruthy();
  });

  test("GlassCard renders both strengths", async () => {
    const plain = await render(
      <GlassCard>
        <Text>glass-a</Text>
      </GlassCard>,
    );
    expect(plain.getByText("glass-a")).toBeTruthy();

    const strong = await render(
      <GlassCard strong style={{ padding: 2 }}>
        <Text>glass-b</Text>
      </GlassCard>,
    );
    expect(strong.getByText("glass-b")).toBeTruthy();
  });
});
