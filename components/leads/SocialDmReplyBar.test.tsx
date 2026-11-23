/**
 * Behaviour of the private-message reply bar and its AI draft against a stubbed
 * Convex client (the component's system boundary). Pins what is requested,
 * what lands in the box and what is sent; it is NOT a visual check (jsdom has
 * no layout), so RTL, spacing and phone widths still need a rendered pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { Id } from "@/convex/_generated/dataModel";

type DraftView = {
  status: "pending" | "ready" | "needs_person" | "failed";
  text?: string;
  handoverFallback?: boolean;
} | null;

const stubs = vi.hoisted(() => ({
  availability: undefined as { enabled: boolean } | undefined,
  draft: undefined as DraftView | undefined,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  requestDraft: undefined as unknown as ReturnType<typeof vi.fn>,
  sendInstagram: undefined as unknown as ReturnType<typeof vi.fn>,
  sendFacebook: undefined as unknown as ReturnType<typeof vi.fn>,
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryCalls.push({ name, args });
      if (args === "skip") return undefined;
      if (name === "aiDrafts:getAvailability") return stubs.availability;
      if (name === "aiDrafts:getDraft") return stubs.draft;
      return undefined;
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (name === "aiDrafts:requestDraft") return stubs.requestDraft;
      throw new Error(`unexpected mutation ${name}`);
    },
    useAction: (reference: never) => {
      const name = getFunctionName(reference);
      if (name === "instagramEngagement:sendInstagramDirectMessage") return stubs.sendInstagram;
      if (name === "facebookEngagement:sendFacebookDirectMessage") return stubs.sendFacebook;
      throw new Error(`unexpected action ${name}`);
    },
  };
});
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SocialDmReplyBar } from "./SocialDmReplyBar";
import type { SocialDmReplyBarProps } from "./SocialDmReplyBar";
import { toast } from "@/components/ui/sonner";

const en = dictionaries.en;
const ar = dictionaries.ar;
const ORG_ID = "org1" as Id<"organizations">;
const CUSTOMER_ID = "cust1" as Id<"customers">;
const DRAFT_ID = "draft1" as Id<"aiDrafts">;

function renderBar(overrides: Partial<SocialDmReplyBarProps> = {}) {
  const props: SocialDmReplyBarProps = {
    orgId: ORG_ID,
    customerId: CUSTOMER_ID,
    platform: "instagram",
    canEditLeads: true,
    ...overrides,
  };
  const view = render(<SocialDmReplyBar {...props} />);
  return { rerender: () => view.rerender(<SocialDmReplyBar {...props} />) };
}

function box(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(en.WriteAMessage) as HTMLTextAreaElement;
}

function suggestButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: en.SocialAiSuggestReply }) as HTMLButtonElement;
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: en.SendMessage }) as HTMLButtonElement;
}

/** Press Suggest and let the request resolve, leaving the draft subscription live. */
async function pressSuggest(rerender: () => void, draft: DraftView) {
  stubs.draft = draft;
  fireEvent.click(suggestButton());
  await waitFor(() => expect(stubs.requestDraft).toHaveBeenCalled());
  await act(async () => {});
  rerender();
}

beforeEach(() => {
  stubs.availability = { enabled: true };
  stubs.draft = undefined;
  stubs.queryCalls = [];
  stubs.locale = "en";
  stubs.requestDraft = vi.fn().mockResolvedValue({ draftId: DRAFT_ID });
  stubs.sendInstagram = vi.fn().mockResolvedValue(null);
  stubs.sendFacebook = vi.fn().mockResolvedValue(null);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => cleanup());

describe("SocialDmReplyBar without AI drafts", () => {
  test.each([
    ["off", { enabled: false }],
    ["loading", undefined],
  ])("availability %s: no suggest button, and the send call is today's call with no aiDraftId", async (_label, availability) => {
    stubs.availability = availability;
    renderBar();

    expect(screen.queryByRole("button", { name: en.SocialAiSuggestReply })).toBeNull();
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();

    fireEvent.change(box(), { target: { value: "Hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });

    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
    const sent = stubs.sendInstagram.mock.calls[0]![0];
    expect(sent).toEqual({ orgId: ORG_ID, customerId: CUSTOMER_ID, message: "Hello" });
    expect(Object.keys(sent)).not.toContain("aiDraftId");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.MessageSentSuccess));
    expect(box().value).toBe("");
  });

  test("a member without lead-edit permission never subscribes to availability", () => {
    renderBar({ canEditLeads: false });
    const availabilityCalls = stubs.queryCalls.filter((call) => call.name === "aiDrafts:getAvailability");
    expect(availabilityCalls.length).toBeGreaterThan(0);
    expect(availabilityCalls.every((call) => call.args === "skip")).toBe(true);
    expect(screen.queryByRole("button", { name: en.SocialAiSuggestReply })).toBeNull();
  });

  test("the box is a multi-line textarea: Shift+Enter does not send, Enter does", async () => {
    renderBar();
    expect(box().tagName).toBe("TEXTAREA");
    expect(box().getAttribute("dir")).toBe("auto");

    fireEvent.change(box(), { target: { value: "Line one" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(stubs.sendInstagram).not.toHaveBeenCalled();

    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
  });

  test("a draft is never subscribed to before Suggest is pressed", () => {
    renderBar();
    const draftCalls = stubs.queryCalls.filter((call) => call.name === "aiDrafts:getDraft");
    expect(draftCalls.every((call) => call.args === "skip")).toBe(true);
  });
});

describe("SocialDmReplyBar with AI drafts", () => {
  test("pressing Suggest requests one draft and shows progress while it is pending", async () => {
    const { rerender } = renderBar();
    await pressSuggest(rerender, { status: "pending" });

    expect(stubs.requestDraft).toHaveBeenCalledTimes(1);
    expect(stubs.requestDraft).toHaveBeenCalledWith({ orgId: ORG_ID, customerId: CUSTOMER_ID, platform: "instagram" });
    expect(stubs.queryCalls).toContainEqual({ name: "aiDrafts:getDraft", args: { orgId: ORG_ID, draftId: DRAFT_ID } });
    expect(suggestButton().disabled).toBe(true);
    expect(suggestButton().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain(en.SocialAiDraftWriting);
    expect(box().disabled).toBe(false);
  });

  test.each([
    ["instagram", "ready", false],
    ["facebook", "ready", true],
  ] as const)("%s: a %s draft lands in the box, is editable, and is sent only on Send with its id", async (platform, status, handoverFallback) => {
    const { rerender } = renderBar({ platform });
    box().focus();
    await pressSuggest(rerender, { status: "pending" });
    stubs.draft = { status, text: "Hello, the car is available.", handoverFallback };
    rerender();

    expect(box().value).toBe("Hello, the car is available.");
    expect(screen.getByText(en.SocialAiDraftLabel)).toBeTruthy();
    expect(document.activeElement).toBe(box());
    expect(stubs.sendInstagram).not.toHaveBeenCalled();
    expect(stubs.sendFacebook).not.toHaveBeenCalled();

    fireEvent.change(box(), { target: { value: "Hello, the car is available. Visit us today." } });
    expect(screen.getByText(en.SocialAiDraftLabel)).toBeTruthy();
    fireEvent.click(sendButton());

    const send = platform === "facebook" ? stubs.sendFacebook : stubs.sendInstagram;
    const other = platform === "facebook" ? stubs.sendInstagram : stubs.sendFacebook;
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      message: "Hello, the car is available. Visit us today.",
      aiDraftId: DRAFT_ID,
    });
    expect(other).not.toHaveBeenCalled();
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();
  });

  test("text the staff member typed is never overwritten", async () => {
    const { rerender } = renderBar();

    fireEvent.change(box(), { target: { value: "My own words" } });
    expect(suggestButton().disabled).toBe(true);
    fireEvent.click(suggestButton());
    expect(stubs.requestDraft).not.toHaveBeenCalled();

    // Typed while a draft was being written: the draft waits, the text stays.
    fireEvent.change(box(), { target: { value: "" } });
    await pressSuggest(rerender, { status: "pending" });
    fireEvent.change(box(), { target: { value: "Typed meanwhile" } });
    stubs.draft = { status: "ready", text: "AI text" };
    rerender();

    expect(box().value).toBe("Typed meanwhile");
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(en.SocialAiDraftKeptText);

    // Only the staff member's own action brings the waiting draft in.
    fireEvent.change(box(), { target: { value: "" } });
    rerender();
    expect(box().value).toBe("");
    fireEvent.click(suggestButton());
    expect(box().value).toBe("AI text");
    expect(stubs.requestDraft).toHaveBeenCalledTimes(1);
  });

  test("clearing the box drops the label and the next send carries no aiDraftId", async () => {
    const { rerender } = renderBar();
    await pressSuggest(rerender, { status: "ready", text: "AI text" });
    expect(box().value).toBe("AI text");

    fireEvent.change(box(), { target: { value: "" } });
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();

    fireEvent.change(box(), { target: { value: "Written by me" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
    const sent = stubs.sendInstagram.mock.calls[0]![0];
    expect(sent).toEqual({ orgId: ORG_ID, customerId: CUSTOMER_ID, message: "Written by me" });
    expect(Object.keys(sent)).not.toContain("aiDraftId");
  });

  test.each([
    ["needs_person", en.SocialAiDraftNeedsPerson],
    ["failed", en.SocialAiDraftFailed],
  ] as const)("%s: a note is shown, nothing is inserted, and the box still sends", async (status, note) => {
    const { rerender } = renderBar();
    await pressSuggest(rerender, { status });

    expect(screen.getByRole("status").textContent).toContain(note);
    expect(box().value).toBe("");
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();
    expect(suggestButton().disabled).toBe(false);

    fireEvent.change(box(), { target: { value: "I will answer" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
    expect(Object.keys(stubs.sendInstagram.mock.calls[0]![0])).not.toContain("aiDraftId");
  });

  test("sending own text while a draft is pending discards the draft", async () => {
    const { rerender } = renderBar();
    await pressSuggest(rerender, { status: "pending" });

    fireEvent.change(box(), { target: { value: "Quick answer" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
    expect(Object.keys(stubs.sendInstagram.mock.calls[0]![0])).not.toContain("aiDraftId");
    await waitFor(() => expect(box().value).toBe(""));

    stubs.draft = { status: "ready", text: "Late AI text" };
    rerender();
    expect(box().value).toBe("");
    expect(screen.queryByText(en.SocialAiDraftLabel)).toBeNull();
  });

  test.each([
    ["a coded refusal in the user's language", new ConvexError({ code: "AI_DRAFT_RATE_LIMITED", message: "Too many." }), en.ServerError_AI_DRAFT_RATE_LIMITED],
    ["an untranslated refusal as the bar's own message", new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" }), en.SocialAiDraftRequestFailed],
  ])("a refusal shows %s and leaves the bar usable", async (_label, refusal, message) => {
    stubs.requestDraft = vi.fn().mockRejectedValue(refusal);
    renderBar();

    fireEvent.click(suggestButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(vi.mocked(toast.error).mock.calls.every(([text]) => typeof text === "string")).toBe(true);
    await waitFor(() => expect(suggestButton().disabled).toBe(false));

    fireEvent.change(box(), { target: { value: "Still works" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stubs.sendInstagram).toHaveBeenCalledTimes(1));
  });

  test("Arabic: the button and the label read in Arabic", async () => {
    stubs.locale = "ar";
    const { rerender } = renderBar();
    const button = screen.getByRole("button", { name: ar.SocialAiSuggestReply });
    expect(ar.SocialAiSuggestReply).toBe("اقترح ردًا");

    stubs.draft = { status: "ready", text: "مرحباً، السيارة متوفرة." };
    fireEvent.click(button);
    await waitFor(() => expect(stubs.requestDraft).toHaveBeenCalled());
    await act(async () => {});
    rerender();

    expect(screen.getByText("مسودة ذكية")).toBeTruthy();
    expect((screen.getByPlaceholderText(ar.WriteAMessage) as HTMLTextAreaElement).value).toBe("مرحباً، السيارة متوفرة.");
  });
});
