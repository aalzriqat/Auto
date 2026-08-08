/**
 * Regression tests for the message stamp's visibility and bidi structure.
 *
 * Two defects these guard:
 *  1. The timestamp and sent/delivered/seen ticks were revealed only on hover,
 *     making them unreachable by touch and keyboard.
 *  2. Rendering the whole stamp as one `dir="ltr"` run reorders a mixed
 *     Arabic/Latin stamp: `أمس 04:53 PM` displays as `04:53 أمس PM`, tearing
 *     the AM/PM marker off its time. Verified by measuring visual character
 *     order in a real browser; asserted structurally here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Literal, not the constant below: vi.mock factories are hoisted above it.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (k: string) => (k === "MessagesYesterday" ? "أمس" : k),
    isRtl: true,
  }),
}));

import { MessageBubble } from "./MessageBubble";

/**
 * The localised label injected through the mocked `t()` below. Assertions key
 * off this rather than "contains any Arabic character": MessageBubble passes no
 * `locale`, so under an `ar-*` runtime the *time itself* is legitimately Arabic
 * script (`٠٤:٥٣ م`). Asserting on the label keeps the barrier meaningful on
 * any CI machine.
 */
const YESTERDAY_LABEL = "أمس";

function at(y: number, m: number, d: number, h = 12, min = 0) {
  return new Date(y, m, d, h, min).getTime();
}

function renderBubble(creationTime: number, overrides: Record<string, unknown> = {}) {
  return render(
    <MessageBubble
      _id="m1"
      body="hello"
      senderName="Other"
      senderId="user2"
      _creationTime={creationTime}
      status="seen"
      seenBy={[]}
      isMine={true}
      showAvatar={true}
      isGroup={false}
      {...overrides}
    />
  );
}

/** Yesterday relative to right now, at a fixed clock time. */
function yesterdayAt(h: number, min: number) {
  const n = new Date();
  return at(n.getFullYear(), n.getMonth(), n.getDate() - 1, h, min);
}

afterEach(cleanup);

describe("MessageBubble stamp", () => {
  it("shows the timestamp without requiring hover", () => {
    const { container } = renderBubble(Date.now());
    const meta = container.querySelector(".text-\\[10px\\]") as HTMLElement;
    expect(meta).toBeTruthy();
    expect(meta.textContent?.trim()).not.toBe("");

    // The hover gate that hid the ticks must not come back.
    expect(container.innerHTML).not.toContain("opacity-0");
    expect(container.innerHTML).not.toContain("group-hover");
  });

  it("renders the delivery status icon alongside the stamp", () => {
    const { container } = renderBubble(Date.now(), { status: "seen", isMine: true });
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("never places an Arabic prefix inside the LTR-isolated run", () => {
    const { container } = renderBubble(yesterdayAt(16, 53));

    const ltr = container.querySelector('[dir="ltr"]') as HTMLElement;
    expect(ltr).toBeTruthy();

    // This is the whole point: isolating the compound string is what produced
    // `04:53 أمس PM`. Only the Latin date/time run may be isolated.
    expect(ltr.textContent?.includes(YESTERDAY_LABEL)).toBe(false);
    // Non-empty rather than /\d/: under an ar-* runtime the time is rendered
    // with Arabic-Indic digits, which ASCII \d does not match.
    expect(ltr.textContent?.trim()).not.toBe("");
  });

  it("still renders the localised yesterday label, outside that run", () => {
    const { container } = renderBubble(yesterdayAt(16, 53));
    const ltr = container.querySelector('[dir="ltr"]') as HTMLElement;

    expect(container.textContent).toContain(YESTERDAY_LABEL);
    expect(ltr.textContent).not.toContain(YESTERDAY_LABEL);
  });

  it("gives the stamp a tooltip that says more than the stamp itself", () => {
    // The defect this guards: the tooltip previously re-rendered the exact
    // string already visible beneath it, so it resolved nothing. A bare
    // "02:32 PM" must resolve to a full date on hover.
    const { container } = renderBubble(Date.now());
    const titled = container.querySelector("[title]") as HTMLElement;
    expect(titled).toBeTruthy();

    const title = titled.getAttribute("title") ?? "";
    expect(title).not.toBe(titled.textContent?.trim());
    expect(title).toContain(String(new Date().getFullYear()));
  });

  it("uses a single isolated run for a same-day message", () => {
    const { container } = renderBubble(Date.now());
    const ltr = container.querySelector('[dir="ltr"]') as HTMLElement;
    expect(ltr.textContent?.includes(YESTERDAY_LABEL)).toBe(false);
    // No prefix for today, so the whole stamp is the isolated time.
    expect(container.textContent).not.toContain(YESTERDAY_LABEL);
  });
});
