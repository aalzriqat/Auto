/**
 * Regression tests for the floating chat window's layout and scroll contract.
 *
 * The bug these exist for: the messages pane carried `flex-1 h-[380px]`. Because
 * `flex-1` is `flex: 1 1 0%` and a flex item's default `min-height: auto`
 * resolves to content height, the pane never shrank, `overflow-y-auto` never
 * engaged, and the `fixed bottom-0` window grew upward until its own header —
 * with the close and minimise buttons — was off the top of the screen.
 *
 * jsdom has no layout engine, so the geometry itself cannot be asserted here;
 * these pin the CSS contract that produces it plus the scroll behaviour, which
 * is real observable behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const listMessagesState: {
  results: Array<Record<string, unknown>>;
  status: string;
} = { results: [], status: "CanLoadMore" };

let conversation: Record<string, unknown> | undefined;

vi.mock("convex/react", () => ({
  useQuery: () => conversation,
  useMutation: () => vi.fn(async () => null),
  usePaginatedQuery: () => ({
    results: listMessagesState.results,
    status: listMessagesState.status,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: { directMessages: {} },
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (k: string) => k, isRtl: false, locale: "en" }),
}));

const closeChat = vi.fn();
const toggleMinimize = vi.fn();
let minimizedChats: string[] = [];

vi.mock("./MessengerContext", () => ({
  useMessenger: () => ({ closeChat, toggleMinimize, minimizedChats }),
}));

vi.mock("@/lib/messageSounds", () => ({ playSound: vi.fn() }));

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ body }: { body: ReactNode }) => <div data-testid="bubble">{body}</div>,
}));

import { FloatingChatWindow } from "./FloatingChatWindow";

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

function renderWindow() {
  return render(
    <FloatingChatWindow
      conversationId={CONVERSATION_ID}
      currentUserId={CURRENT_USER}
      index={0}
    />
  );
}

/** The scrollable messages pane — the element the bug lived on. */
function pane(container: HTMLElement) {
  return container.querySelector(".overflow-y-auto") as HTMLElement | null;
}

let scrollCalls: ScrollToOptions[] = [];

beforeEach(() => {
  scrollCalls = [];
  minimizedChats = [];
  listMessagesState.results = [message("m1"), message("m2")];
  listMessagesState.status = "Exhausted";
  conversation = {
    type: "DM",
    members: [{ _id: "user2", name: "Other" }],
    isMuted: false,
    hasUnread: false,
    typingUsers: [],
  };
  // jsdom implements neither scrollTo nor real layout.
  Element.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    scrollCalls.push(options as ScrollToOptions);
  } as typeof Element.prototype.scrollTo;
  // Also absent from jsdom. Stubbed so that if this component ever regresses to
  // scrollIntoView, these tests fail on the contract rather than on a TypeError.
  Element.prototype.scrollIntoView = vi.fn();
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

describe("FloatingChatWindow layout contract", () => {
  it("lets the messages pane shrink so it can scroll", () => {
    const { container } = renderWindow();
    const el = pane(container)!;
    expect(el).toBeTruthy();

    // `min-h-0` is what allows a flex child to shrink below its content.
    // Without it the pane grows to the full thread and never scrolls.
    expect(el.className).toContain("min-h-0");
    expect(el.className).toContain("overflow-y-auto");

    // The fixed-height rule that `flex-1` silently overrode must not return.
    expect(el.className).not.toMatch(/\bh-\[\d+px\]/);
  });

  it("bounds the expanded window so it cannot grow past the viewport", () => {
    const { container } = renderWindow();
    const win = container.querySelector(".fixed.bottom-0") as HTMLElement;
    expect(win).toBeTruthy();

    // Without a bounded height the bottom-anchored column grows upward and
    // pushes its own header off the top of the screen.
    expect(win.className).toMatch(/h-\[\d+px\]/);
    expect(win.className).toContain("max-h-[calc(100dvh-1.5rem)]");
  });

  it("keeps the header rendered alongside the messages", () => {
    renderWindow();
    // The header is what disappeared off-screen in the original bug.
    expect(screen.getByLabelText("MessagesMinimize")).toBeTruthy();
  });

  it("does not reserve the expanded height while minimized", () => {
    minimizedChats = [CONVERSATION_ID as unknown as string];
    const { container } = renderWindow();
    const win = container.querySelector(".fixed.bottom-0") as HTMLElement;

    expect(win.className).not.toMatch(/h-\[\d+px\]/);
    // Body is unmounted, so there is no pane at all.
    expect(pane(container)).toBeNull();
  });
});

describe("FloatingChatWindow scroll contract", () => {
  it("jumps instantly on the first render of real content", () => {
    renderWindow();
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.at(-1)?.behavior).toBe("auto");
  });

  it("glides when a genuinely new message arrives", () => {
    const { rerender } = renderWindow();
    scrollCalls = [];

    // A new message is prepended — `results` is newest-first.
    listMessagesState.results = [message("m0"), ...listMessagesState.results];
    rerender(
      <FloatingChatWindow
        conversationId={CONVERSATION_ID}
        currentUserId={CURRENT_USER}
        index={0}
      />
    );

    expect(scrollCalls.at(-1)?.behavior).toBe("smooth");
  });

  it("does not yank the reader to the bottom when older messages load", () => {
    listMessagesState.status = "CanLoadMore";
    const { rerender } = renderWindow();
    scrollCalls = [];

    // loadMore appends OLDER pages at the end; the newest message is unchanged.
    listMessagesState.results = [...listMessagesState.results, message("m3"), message("m4")];
    rerender(
      <FloatingChatWindow
        conversationId={CONVERSATION_ID}
        currentUserId={CURRENT_USER}
        index={0}
      />
    );

    // Scrolling here would throw a user reading history back to the newest
    // message, making the "Load older" button useless.
    expect(scrollCalls).toHaveLength(0);
  });

  it("does not arm the initial-scroll flag before the pane exists", () => {
    // Conversation still loading: the component returns null, but the effect
    // above the early return still runs.
    conversation = undefined;
    listMessagesState.results = [];
    const { rerender } = renderWindow();
    expect(scrollCalls).toHaveLength(0);

    conversation = {
      type: "DM",
      members: [{ _id: "user2", name: "Other" }],
      isMuted: false,
      hasUnread: false,
      typingUsers: [],
    };
    listMessagesState.results = [message("m1")];
    rerender(
      <FloatingChatWindow
        conversationId={CONVERSATION_ID}
        currentUserId={CURRENT_USER}
        index={0}
      />
    );

    // The first sight of real content must still jump, not animate through
    // the whole thread.
    expect(scrollCalls.at(-1)?.behavior).toBe("auto");
  });
});
