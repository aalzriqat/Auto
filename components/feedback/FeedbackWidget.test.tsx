/**
 * SCRUM-609 F-01 — the floating feedback trigger covered the sales wizard's
 * step actions. A full-screen flow now suppresses it while mounted and opens
 * the same panel from its own header entry.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FeedbackWidget } from "./FeedbackWidget";
import { closeFeedbackPanel, openFeedbackPanel, useSuppressFeedbackTrigger } from "./feedbackWidgetStore";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

function FullScreenFlow() {
  useSuppressFeedbackTrigger();
  return null;
}

afterEach(() => {
  act(() => closeFeedbackPanel());
  cleanup();
});

const trigger = () => screen.queryByRole("button", { name: "FeedbackWidgetTitle" });

describe("FeedbackWidget — full-screen flows (SCRUM-609 F-01)", () => {
  test("the floating trigger is hidden while a flow suppresses it, and returns when it unmounts", () => {
    const { rerender } = render(
      <>
        <FeedbackWidget />
        <FullScreenFlow />
      </>
    );
    expect(trigger()).toBeNull();

    rerender(<FeedbackWidget />);
    expect(trigger()).not.toBeNull();
  });

  test("the flow's own entry opens the same feedback panel", () => {
    render(
      <>
        <FeedbackWidget />
        <FullScreenFlow />
      </>
    );
    expect(screen.queryByText("FeedbackWidgetDesc")).toBeNull();

    act(() => openFeedbackPanel());
    expect(screen.getByText("FeedbackWidgetDesc")).toBeTruthy();
  });
});
