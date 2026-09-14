/**
 * The radio group's arrow keys under both writing directions.
 *
 * An inline row under `dir="rtl"` paints its FIRST option on the RIGHT. The
 * group used to treat ArrowRight as "next in DOM order" regardless, so an
 * Arabic operator pressing → watched the selection jump to the option on their
 * LEFT. Horizontal arrows must follow what the eye sees; vertical arrows and
 * the stacked column have no mirrored axis and must not change.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

const language = vi.hoisted(() => ({ rtl: false }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    isRtl: language.rtl,
    locale: language.rtl ? "ar" : "en",
  }),
}));

import { RadioCardGroup } from "./RadioCardGroup";

type Basis = "A" | "B" | "C";
const OPTIONS = [
  { value: "A" as const, label: "Option A" },
  { value: "B" as const, label: "Option B" },
  { value: "C" as const, label: "Option C" },
];

/** A controlled host, as every dialog that uses the group is. */
function Host({ layout }: Readonly<{ layout: "inline" | "stacked" }>) {
  const [value, setValue] = useState<Basis>("A");
  return (
    <RadioCardGroup
      ariaLabel="basis"
      idPrefix="basis"
      layout={layout}
      value={value}
      options={OPTIONS}
      onChange={setValue}
    />
  );
}

function checked(): string {
  return screen.getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")!
    .textContent!;
}

function press(key: string) {
  const current = screen
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")!;
  fireEvent.keyDown(current, { key });
}

afterEach(() => {
  cleanup();
  language.rtl = false;
});

describe("inline layout, horizontal arrows follow the visual direction", () => {
  test("LTR: ArrowRight advances in DOM order, ArrowLeft retreats, both wrap", () => {
    render(<Host layout="inline" />);
    expect(checked()).toBe("Option A");
    press("ArrowRight");
    expect(checked()).toBe("Option B");
    press("ArrowLeft");
    expect(checked()).toBe("Option A");
    press("ArrowLeft");
    expect(checked()).toBe("Option C");
  });

  test("RTL: ArrowRight moves to the option painted on the right — the PREVIOUS in DOM order", () => {
    language.rtl = true;
    render(<Host layout="inline" />);
    expect(checked()).toBe("Option A");
    // A is painted at the far right; → from it wraps to the far-left option, C.
    press("ArrowRight");
    expect(checked()).toBe("Option C");
    // ← from C moves toward the right-hand side of the row: back to A.
    press("ArrowLeft");
    expect(checked()).toBe("Option A");
    press("ArrowLeft");
    expect(checked()).toBe("Option B");
  });

  test("RTL: focus moves with the selection to the option the arrow pointed at", () => {
    language.rtl = true;
    render(<Host layout="inline" />);
    press("ArrowLeft");
    expect(document.activeElement).toBe(document.getElementById("basis-B"));
  });

  test("RTL: vertical arrows and Home/End are unaffected", () => {
    language.rtl = true;
    render(<Host layout="inline" />);
    press("ArrowDown");
    expect(checked()).toBe("Option B");
    press("ArrowUp");
    expect(checked()).toBe("Option A");
    press("End");
    expect(checked()).toBe("Option C");
    press("Home");
    expect(checked()).toBe("Option A");
  });
});

describe("stacked layout is a column and reads the same in both directions", () => {
  test.each([false, true])("rtl=%s: ArrowRight/ArrowDown advance, ArrowLeft/ArrowUp retreat", (rtl) => {
    language.rtl = rtl;
    render(<Host layout="stacked" />);
    press("ArrowRight");
    expect(checked()).toBe("Option B");
    press("ArrowDown");
    expect(checked()).toBe("Option C");
    press("ArrowLeft");
    expect(checked()).toBe("Option B");
    press("ArrowUp");
    expect(checked()).toBe("Option A");
  });
});
