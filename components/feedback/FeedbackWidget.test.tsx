/**
 * SCRUM-609 F-01 / SCRUM-612 — a floating feedback trigger covered page
 * actions (the sales wizard's step buttons). The widget now renders only the
 * panel; the top bar and the mobile menu drawer open it.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FeedbackWidget } from "./FeedbackWidget";
import { closeFeedbackPanel, openFeedbackPanel } from "./feedbackWidgetStore";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

afterEach(() => {
  act(() => closeFeedbackPanel());
  cleanup();
});

describe("FeedbackWidget (SCRUM-612)", () => {
  test("renders no floating trigger — nothing at all while the panel is closed", () => {
    const { container } = render(<FeedbackWidget />);
    expect(screen.queryByRole("button", { name: "FeedbackWidgetTitle" })).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  test("openFeedbackPanel opens the panel, and its close button is labelled", () => {
    render(<FeedbackWidget />);
    expect(screen.queryByText("FeedbackWidgetDesc")).toBeNull();

    act(() => openFeedbackPanel());
    expect(screen.getByText("FeedbackWidgetDesc")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });

  test("a panel left open when the widget unmounts is closed on the next mount", () => {
    const first = render(<FeedbackWidget />);
    act(() => openFeedbackPanel());
    expect(screen.getByText("FeedbackWidgetDesc")).toBeTruthy();

    first.unmount();
    render(<FeedbackWidget />);
    expect(screen.queryByText("FeedbackWidgetDesc")).toBeNull();
  });
});
