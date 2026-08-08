/**
 * Regression tests for ChatThread's scroll contract — the `/messages` page and
 * the mobile chat sheet.
 *
 * These exist because adding `min-h-0` to this pane is what made it genuinely
 * scrollable, and therefore what made "Load older messages" reachable at all.
 * The sibling FloatingChatWindow got the scroll fixes first; this component was
 * left keying on `messages?.length`, so every click of "Load older messages"
 * scrolled the reader straight back to the newest message — a closed loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const state: { results: Array<Record<string, unknown>>; status: string } = {
  results: [],
  status: "Exhausted",
};

let conversation: Record<string, unknown> | undefined;

vi.mock("convex/react", () => ({
  useQuery: () => conversation,
  useMutation: () => vi.fn(async () => null),
  usePaginatedQuery: () => ({
    results: state.results,
    status: state.status,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/convex/_generated/api", () => ({ api: { directMessages: {} } }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (k: string) => k, isRtl: false, locale: "en" }),
}));

vi.mock("@/lib/messageSounds", () => ({ playSound: vi.fn() }));

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ body }: { body: ReactNode }) => <div data-testid="bubble">{body}</div>,
}));

import { ChatThread } from "./ChatThread";

const CONVERSATION_ID = "conv1" as never;
const CURRENT_USER = "user1" as never;

function message(id: string, senderId = "user2") {
  return {
    _id: id,
    body: `body-${id}`,
    senderId,
    senderName: "Other",
    _creationTime: Date.now(),
    status: "received",
    seenBy: [],
  };
}

function renderThread() {
  return render(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);
}

/**
 * Every scroll the component performs, by whichever API. `scrollIntoView` is
 * counted too — otherwise a regression back to it would make these tests pass
 * silently while the page scrolled behind the mobile sheet again.
 */
let scrollCalls: Array<{ via: string; behavior?: string }> = [];

beforeEach(() => {
  scrollCalls = [];
  state.results = [message("m1"), message("m2")];
  state.status = "Exhausted";
  conversation = {
    type: "DM",
    members: [{ _id: "user2", name: "Other" }],
    isMuted: false,
    typingUsers: [],
  };
  Element.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    scrollCalls.push({ via: "scrollTo", behavior: (options as ScrollToOptions)?.behavior });
  } as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
    scrollCalls.push({
      via: "scrollIntoView",
      behavior: typeof arg === "object" ? arg?.behavior : undefined,
    });
  } as typeof Element.prototype.scrollIntoView;
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatThread scroll contract", () => {
  it("scrolls the pane itself, never scrollIntoView", () => {
    renderThread();
    // scrollIntoView walks every scrollable ancestor, which moves the page
    // behind the mobile sheet.
    expect(scrollCalls.every((c) => c.via === "scrollTo")).toBe(true);
    expect(scrollCalls.length).toBeGreaterThan(0);
  });

  it("jumps instantly on the first render of real content", () => {
    renderThread();
    expect(scrollCalls.at(-1)?.behavior).toBe("auto");
  });

  it("does not yank the reader to the bottom when older messages load", () => {
    state.status = "CanLoadMore";
    const { rerender } = renderThread();
    scrollCalls = [];

    // loadMore appends OLDER pages at the tail; the newest message is unchanged.
    state.results = [...state.results, message("m3"), message("m4")];
    rerender(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);

    expect(scrollCalls).toHaveLength(0);
  });

  it("does not yank a reader who has scrolled up into history", () => {
    const { container, rerender } = renderThread();
    const el = container.querySelector(".overflow-y-auto") as HTMLElement;

    // jsdom has no layout, so geometry is stubbed: a long thread scrolled well
    // away from the bottom.
    Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 500, configurable: true, writable: true });
    scrollCalls = [];

    state.results = [message("m0"), ...state.results];
    rerender(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);

    // 4000 - 500 - 400 = 3100px from the bottom — leave the reader alone.
    expect(scrollCalls).toHaveLength(0);
  });

  it("still follows a new message when already at the bottom", () => {
    const { container, rerender } = renderThread();
    const el = container.querySelector(".overflow-y-auto") as HTMLElement;

    Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 3600, configurable: true, writable: true });
    scrollCalls = [];

    state.results = [message("m0"), ...state.results];
    rerender(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);

    // Pinned to the bottom, so the thread should keep following.
    expect(scrollCalls.at(-1)?.behavior).toBe("smooth");
  });

  it("still scrolls when a genuinely new message arrives", () => {
    const { rerender } = renderThread();
    scrollCalls = [];

    state.results = [message("m0"), ...state.results];
    rerender(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);

    expect(scrollCalls.at(-1)?.behavior).toBe("smooth");
  });

  it("jumps, not glides, when the user switches to another conversation", () => {
    // MessagesPageClient renders ChatThread without a `key`, so selecting a
    // different conversation reuses this instance. The pane unmounts only
    // briefly while the new conversation loads; if the initial-scroll flag
    // survives that, the second thread animates ~1200px from its oldest
    // message instead of opening at the newest.
    const { rerender } = renderThread();
    scrollCalls = [];

    // Loading window for the newly selected conversation.
    conversation = undefined;
    state.results = [];
    rerender(<ChatThread conversationId={"conv2" as never} currentUserId={CURRENT_USER} />);

    conversation = {
      type: "DM",
      members: [{ _id: "user3", name: "Someone else" }],
      isMuted: false,
      typingUsers: [],
    };
    state.results = [message("n1", "user3"), message("n2", "user3")];
    rerender(<ChatThread conversationId={"conv2" as never} currentUserId={CURRENT_USER} />);

    expect(scrollCalls.at(-1)?.behavior).toBe("auto");
  });

  it("lets the messages pane shrink so it can scroll", () => {
    const { container } = renderThread();
    const el = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(el).toBeTruthy();
    // min-h-0 is what allows a flex child to shrink below its content; without
    // it this pane grows to the whole thread and clips the composer.
    expect(el.className).toContain("min-h-0");
    expect(el.className).toContain("overscroll-contain");
    expect(el.className).not.toMatch(/\bh-\[\d+px\]/);
  });

  it("exposes the scrollable pane to keyboard users", () => {
    const { container } = renderThread();
    const el = container.querySelector(".overflow-y-auto") as HTMLElement;
    // Made scrollable by this change, so it must be focusable — otherwise
    // keyboard-only users cannot reach the history at all.
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("role")).toBe("log");
    expect(el.getAttribute("aria-label")).toBeTruthy();
  });

  it("keeps a short thread resting on the composer", () => {
    const { container } = renderThread();
    // Without mt-auto a two-message thread is stranded at the top of the pane.
    expect(container.querySelector(".mt-auto")).toBeTruthy();
  });
});
