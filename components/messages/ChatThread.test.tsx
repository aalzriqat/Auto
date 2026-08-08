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

  it("still scrolls when a genuinely new message arrives", () => {
    const { rerender } = renderThread();
    scrollCalls = [];

    state.results = [message("m0"), ...state.results];
    rerender(<ChatThread conversationId={CONVERSATION_ID} currentUserId={CURRENT_USER} />);

    expect(scrollCalls.at(-1)?.behavior).toBe("smooth");
  });

  it("keeps a short thread resting on the composer", () => {
    const { container } = renderThread();
    // Without mt-auto a two-message thread is stranded at the top of the pane.
    expect(container.querySelector(".mt-auto")).toBeTruthy();
  });
});
