/**
 * SCRUM-417 UX5 -- the announcer speaks TRANSITIONS, and the position sentence is
 * judged with the REAL dictionaries (a `t` that returns keys proves neither the
 * Arabic sentence nor the isolation of its numbers).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { StageViewAnnouncer } from "./StageViewAnnouncer";
import { StagePosition } from "./StagePosition";

afterEach(cleanup);

const REC = "Recorded. Next: Handover";
type Props = { message: string | null; restore: string; recorded: string | null };
const ui = ({ message, restore, recorded }: Props) => (
  <StageViewAnnouncer message={message} restoreMessage={restore} recordedMessage={recorded} />
);
const said = () => document.querySelector("[data-testid=deal-stage-view-announcer]")!.textContent;

describe("StageViewAnnouncer announces transitions only", () => {
  test("silent until something changes; entering a viewed step announces it", () => {
    const view = render(ui({ message: null, restore: "Back to X", recorded: null }));
    expect(said()).toBe("");
    view.rerender(ui({ message: "Showing step: Credit", restore: "Back to X", recorded: null }));
    expect(said()).toBe("Showing step: Credit");
  });

  test("navigating AFTER 'Recorded' announces the stage: the recorded line does not mask the view", () => {
    const view = render(ui({ message: null, restore: "Back to X", recorded: null }));
    view.rerender(ui({ message: null, restore: "Back to X", recorded: REC }));
    expect(said()).toBe(REC);
    view.rerender(ui({ message: "Showing step: Credit", restore: "Back to X", recorded: REC }));
    expect(said()).toBe("Showing step: Credit");
    // Still recorded, back on the live step: the way back is said once.
    view.rerender(ui({ message: null, restore: "Back to X", recorded: REC }));
    expect(said()).toBe("Back to X");
  });

  test("a live-stage change by ANOTHER user announces nothing (restore text changing is not a transition)", () => {
    const view = render(ui({ message: null, restore: "Back to X", recorded: null }));
    view.rerender(ui({ message: "Showing step: Credit", restore: "Back to X", recorded: null }));
    view.rerender(ui({ message: null, restore: "Back to X", recorded: null }));
    expect(said()).toBe("Back to X");
    // Someone else moves the live step: only the restore text and nothing else changes.
    view.rerender(ui({ message: null, restore: "Back to Y", recorded: null }));
    expect(said()).toBe("Back to X");
    view.rerender(ui({ message: null, restore: "Back to Z", recorded: null }));
    expect(said()).toBe("Back to X");
  });

  test("the recorded line is said once, frozen at release: another user's change never re-announces 'Next: Y'", () => {
    const view = render(ui({ message: null, restore: "r", recorded: null }));
    view.rerender(ui({ message: null, restore: "r", recorded: REC }));
    expect(said()).toBe(REC);
    view.rerender(ui({ message: null, restore: "r", recorded: "Recorded. Next: Settlement" }));
    expect(said()).toBe(REC);
  });

  test("dismissing the line says nothing, and a later identical line can be announced again", () => {
    const view = render(ui({ message: null, restore: "r", recorded: REC }));
    view.rerender(ui({ message: null, restore: "r", recorded: null }));
    expect(said()).toBe("");
    view.rerender(ui({ message: null, restore: "r", recorded: REC }));
    expect(said()).toBe(REC);
  });

  test("switching between two viewed steps announces the new one; the region is one node for its whole life", () => {
    const view = render(ui({ message: "Showing step: A", restore: "r", recorded: null }));
    const region = document.querySelector("[data-testid=deal-stage-view-announcer]");
    expect(said()).toBe("Showing step: A");
    view.rerender(ui({ message: "Showing step: B", restore: "r", recorded: null }));
    expect(said()).toBe("Showing step: B");
    expect(document.querySelector("[data-testid=deal-stage-view-announcer]")).toBe(region);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});

describe("StagePosition", () => {
  const sentence = (locale: "en" | "ar", position: number, total: number) => {
    const table = dictionaries[locale] as Record<string, string>;
    const { container } = render(<StagePosition t={(key) => table[key] ?? key} position={position} total={total} />);
    return container;
  };

  test("real English: 'Step 7 of 8', each number its own isolated run", () => {
    const container = sentence("en", 7, 8);
    expect(container.textContent).toBe("Step 7 of 8");
    expect(Array.from(container.querySelectorAll("bdi")).map((n) => n.textContent)).toEqual(["7", "8"]);
  });

  test("real Arabic: reads 7 before 8 as a sentence, no slash form", () => {
    const container = sentence("ar", 7, 8);
    expect(container.textContent).toBe("الخطوة 7 من 8");
    expect(container.textContent).not.toContain("/");
    expect(Array.from(container.querySelectorAll("bdi")).map((n) => n.textContent)).toEqual(["7", "8"]);
  });

  test("the phone bar and the focus row use the same word in both languages", () => {
    for (const locale of ["en", "ar"] as const) {
      const table = dictionaries[locale] as Record<string, string>;
      expect(table.StageOfLabel).toBe(table.MobileStepLabel);
    }
  });

  test.each([
    [0, 8],
    [-1, 8],
    [9, 8],
    [3, 0],
    [1.5, 8],
    [Number.NaN, 8],
  ])("an invalid position (%s of %s) renders nothing rather than a clamped, wrong count", (position, total) => {
    const container = sentence("en", position, total);
    expect(container.textContent).toBe("");
  });
});
