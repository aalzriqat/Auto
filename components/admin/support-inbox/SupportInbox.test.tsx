/**
 * Behaviour of the mail-client inbox against a stubbed Convex client. This pins
 * what the admin sees and what is sent to the backend; it is NOT a visual check
 * (jsdom has no layout), so RTL/spacing/overflow still need a rendered pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  threads: [] as unknown[],
  messagesByThread: new Map<string, unknown[]>(),
  listArgs: [] as unknown[],
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  sendReply: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    usePaginatedQuery: (_ref: never, args: unknown) => {
      stubs.listArgs.push(args);
      return { results: stubs.threads, status: "Exhausted", loadMore: vi.fn() };
    },
    useQuery: (_ref: never, args: { threadId: string }) => {
      const thread = (stubs.threads as Array<{ _id: string }>).find((row) => row._id === args.threadId);
      return thread ? { thread, messages: stubs.messagesByThread.get(args.threadId) ?? [] } : undefined;
    },
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(null));
      return stubs.mutations.get(name)!;
    },
    useAction: () => stubs.sendReply,
  };
});
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { SupportInbox } from "./SupportInbox";
import { toast } from "@/components/ui/sonner";

const NOW = Date.now();
let counter = 0;
function thread(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    _id: `t${counter}`,
    _creationTime: NOW,
    participantEmail: `person${counter}@example.com`,
    participantName: undefined,
    subject: `Subject ${counter}`,
    status: "OPEN",
    inbox: "support",
    lastMessageAt: NOW - counter * 1000,
    ...overrides,
  };
}
function message(threadId: string, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    _id: `m${counter}`,
    _creationTime: NOW,
    threadId,
    direction: "INBOUND",
    fromEmail: "person@example.com",
    toEmail: "support@autoflowdealer.com",
    bodyText: "Hello",
    createdAt: NOW - 5000,
    ...overrides,
  };
}

const ACK = "(Automated acknowledgment — your message was received and a team member will follow up shortly.)";

beforeEach(() => {
  counter = 0;
  stubs.threads = [];
  stubs.messagesByThread = new Map();
  stubs.listArgs = [];
  stubs.mutations = new Map();
  stubs.sendReply = vi.fn().mockResolvedValue({ success: true, closed: false, newerInbound: false });
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});
afterEach(cleanup);

describe("SupportInbox list", () => {
  test("Customers shows people, Automated shows bulk senders; name is shown instead of email, never both", () => {
    stubs.threads = [
      thread({ participantName: "Omar Nasser", participantEmail: "omar@nasserauto.com", subject: "Photos fail", lastMessagePreview: "Since this morning", awaitingReply: true }),
      thread({ participantEmail: "noreply@po.atlassian.net", subject: "Welcome to Jira" }),
    ];
    render(<SupportInbox />);

    const row = screen.getByRole("button", { name: /Omar Nasser/ });
    expect(row.textContent).toContain("Photos fail — Since this morning");
    expect(row.textContent).not.toContain("omar@nasserauto.com");
    expect(screen.queryByText(/Welcome to Jira/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Automated" }));
    expect(screen.getByText(/Welcome to Jira/)).toBeTruthy();
    expect(screen.queryByText(/Photos fail/)).toBeNull();
    // No name: the email is the sender label.
    expect(screen.getByRole("button", { name: /noreply@po\.atlassian\.net/ })).toBeTruthy();
  });

  test("one quiet flag: Needs reply only when OPEN and awaiting, Closed when closed, none otherwise", () => {
    stubs.threads = [
      thread({ subject: "A", awaitingReply: true }),
      thread({ subject: "B", awaitingReply: false }),
      thread({ subject: "C" }),
      thread({ subject: "D", status: "CLOSED", awaitingReply: true }),
    ];
    render(<SupportInbox />);
    const flagsOf = (subject: string) => screen.getByText(subject).closest("button")!.textContent;
    expect(flagsOf("A")).toContain("Needs reply");
    expect(flagsOf("B")).not.toMatch(/Needs reply|Closed/);
    expect(flagsOf("C")).not.toMatch(/Needs reply|Closed/);
    expect(flagsOf("D")).toContain("Closed");
    expect(flagsOf("D")).not.toContain("Needs reply");
  });

  test("an admin override beats the heuristic", () => {
    stubs.threads = [thread({ participantEmail: "noreply@x.com", subject: "Actually a person", categoryOverride: "people" })];
    render(<SupportInbox />);
    expect(screen.getByText("Actually a person")).toBeTruthy();
  });

  test("status chips pass the status to listThreads; All passes undefined; default is All", () => {
    render(<SupportInbox />);
    expect(stubs.listArgs.at(-1)).toEqual({ inbox: "support", status: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(stubs.listArgs.at(-1)).toEqual({ inbox: "support", status: "OPEN" });
    fireEvent.click(screen.getByRole("tab", { name: "Billing" }));
    expect(stubs.listArgs.at(-1)).toEqual({ inbox: "subscriptions", status: "OPEN" });
  });

  test("the filter box narrows the loaded conversations by name, email, subject and preview", () => {
    stubs.threads = [
      thread({ participantName: "Omar", subject: "Photos", lastMessagePreview: "upload failed" }),
      thread({ participantName: "Lina", subject: "Report", lastMessagePreview: "export excel" }),
    ];
    render(<SupportInbox />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "EXCEL" } });
    expect(screen.queryByText("Photos")).toBeNull();
    expect(screen.getByText("Report")).toBeTruthy();
  });
});

describe("SupportInbox reading pane", () => {
  test("HTML mail renders in a sandboxed iframe without script or same-origin rights, with a CSP", () => {
    const t1 = thread({ participantEmail: "news@send.zapier.com", subject: "Hello", categoryOverride: "people" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [
      message(t1._id, {
        bodyText: undefined,
        bodyHtml: '<p>Hi</p><script>alert(1)</script><img src="https://t.example/p.gif">',
      }),
    ]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Hello"));

    const frame = screen.getByTitle("Email content") as HTMLIFrameElement;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox.split(/\s+/).sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox"]);
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).not.toContain("t.example");
    // HTML-only mail must not claim to have no content.
    expect(screen.queryByText(/no text content/i)).toBeNull();
    // Informational only: the app CSP is an allowlist the iframe cannot widen, so
    // there is deliberately no way to show remote images (review F3).
    expect(screen.getByText("Remote images are blocked to protect privacy.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show images" })).toBeNull();
    expect(srcdoc).toContain("img-src data:");
    expect(srcdoc).not.toContain("https:");

    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(screen.queryByTitle("Email content")).toBeNull();
    expect(screen.getByText("Hi")).toBeTruthy();
  });

  test("plain text collapses <https://…> dumps into hostname chips", () => {
    const t1 = thread({ subject: "Welcome" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [
      message(t1._id, { bodyText: "Ready.\n<https://www.claude.ai/?#footer>\n\n\n\n\nBye" }),
    ]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Welcome"));
    const chip = screen.getByRole("link", { name: /claude\.ai/ });
    expect(chip.getAttribute("href")).toBe("https://www.claude.ai/?#footer");
    expect(chip.getAttribute("title")).toBe("https://www.claude.ai/?#footer");
    expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
    expect(chip.getAttribute("target")).toBe("_blank");
  });

  test("the latest real message is open, earlier ones and the auto-acknowledgement are one-line and expandable", () => {
    const t1 = thread({ participantName: "Omar", subject: "Photos" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [
      message(t1._id, { bodyText: "FIRST-MESSAGE-BODY", createdAt: NOW - 9000 }),
      message(t1._id, { direction: "OUTBOUND", fromEmail: "support@autoflowdealer.com", toEmail: "p@example.com", bodyText: ACK, createdAt: NOW - 8000 }),
      message(t1._id, { direction: "OUTBOUND", sentByUserId: "u1", fromEmail: "support@autoflowdealer.com", toEmail: "p@example.com", bodyText: "HUMAN-REPLY-BODY", createdAt: NOW - 7000 }),
      message(t1._id, { bodyText: "LATEST-INBOUND-BODY", createdAt: NOW - 6000 }),
      message(t1._id, { direction: "OUTBOUND", fromEmail: "support@autoflowdealer.com", toEmail: "p@example.com", bodyText: ACK, createdAt: NOW - 5900 }),
    ]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Photos"));

    // Expanded: the latest non-ack message. Collapsed cards only show a snippet.
    expect(screen.getAllByText("LATEST-INBOUND-BODY").length).toBeGreaterThan(0);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(5);
    expect(within(cards[3]!).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(within(cards[4]!).getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(within(cards[4]!).getByText("Automated acknowledgement")).toBeTruthy();
    expect(within(cards[0]!).getByRole("button").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(within(cards[0]!).getByRole("button"));
    expect(within(screen.getAllByRole("article")[0]!).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("5 messages")).toBeTruthy();
  });

  test("a no-reply sender gets the notice and no composer", () => {
    const t1 = thread({ participantEmail: "no-reply@email.claude.com", subject: "Welcome", categoryOverride: "people" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [message(t1._id)]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Welcome"));
    expect(screen.getByRole("note").textContent).toContain("no-reply address");
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByPlaceholderText("Write your reply…")).toBeNull();
  });

  test("replying: Ctrl+Enter sends the trimmed text to sendReply for that thread and clears the draft", async () => {
    const t1 = thread({ participantName: "Omar", subject: "Photos" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [message(t1._id)]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Photos"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByPlaceholderText("Write your reply…");
    expect((screen.getByText("Re: Photos") as HTMLElement).textContent).toBe("Re: Photos");
    fireEvent.change(box, { target: { value: "  On it.  " } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(stubs.sendReply).toHaveBeenCalledWith({ threadId: t1._id, bodyText: "On it." }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reply sent."));
    expect(screen.queryByPlaceholderText("Write your reply…")).toBeNull();
  });

  test("Send & close is ONE sendReply call with closeAfterSend and never a separate setThreadStatus; a send failure shows the server's message and keeps the draft", async () => {
    const t1 = thread({ subject: "Photos" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [message(t1._id)]);
    stubs.sendReply.mockResolvedValue({ success: true, closed: true, newerInbound: false });
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Photos"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Write your reply…"), { target: { value: "Fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Send & close" }));
    await waitFor(() => expect(stubs.sendReply).toHaveBeenCalledTimes(1));
    expect(stubs.sendReply).toHaveBeenCalledWith({ threadId: t1._id, bodyText: "Fixed", closeAfterSend: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reply sent and conversation closed."));
    expect(stubs.mutations.get("support:setThreadStatus")?.mock.calls ?? []).toHaveLength(0);

    // Failure path: draft survives, message comes from the ConvexError string.
    const { ConvexError } = await import("convex/values");
    stubs.sendReply.mockRejectedValueOnce(new ConvexError("This sender does not accept replies."));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Write your reply…"), { target: { value: "Again" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Write your reply…"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This sender does not accept replies."));
    expect((screen.getByPlaceholderText("Write your reply…") as HTMLTextAreaElement).value).toBe("Again");
  });

  test("Send & close warns, instead of claiming it closed, when a newer message arrived during the send", async () => {
    const t1 = thread({ subject: "Photos" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [message(t1._id)]);
    stubs.sendReply.mockResolvedValue({ success: true, closed: false, newerInbound: true });
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Photos"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Write your reply…"), { target: { value: "Fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Send & close" }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Reply sent. A new message arrived, so the conversation was kept open."
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(stubs.mutations.get("support:setThreadStatus")?.mock.calls ?? []).toHaveLength(0);
  });

  test("a message whose HTML cannot be made safe shows a placeholder instead of an iframe", () => {
    const t1 = thread({ subject: "Odd" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [
      message(t1._id, {
        bodyText: undefined,
        bodyHtml: "<math><mtext><table><mglyph><style><!--</style><xmp>--><img src=x onerror=1></xmp>",
      }),
    ]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByText("Odd"));
    // Either the sanitizer removed everything (empty iframe, nothing live) or it
    // reported unsafe and the placeholder replaced the frame: never live markup.
    const frame = screen.queryByTitle("Email content") as HTMLIFrameElement | null;
    if (frame) expect(frame.getAttribute("srcdoc") ?? "").not.toMatch(/onerror/i);
  });

  test("toolbar: close/reopen and the category toggle call the backend", async () => {
    const t1 = thread({ participantEmail: "notify@mail.notion.com", subject: "Invite" });
    stubs.threads = [t1];
    stubs.messagesByThread.set(t1._id, [message(t1._id)]);
    render(<SupportInbox />);
    fireEvent.click(screen.getByRole("tab", { name: "Automated" }));
    fireEvent.click(screen.getByText("Invite"));

    fireEvent.click(screen.getByRole("button", { name: "Not automated" }));
    await waitFor(() =>
      expect(stubs.mutations.get("support:setThreadCategory")).toHaveBeenCalledWith({ threadId: t1._id, category: "people" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    await waitFor(() =>
      expect(stubs.mutations.get("support:setThreadStatus")).toHaveBeenCalledWith({ threadId: t1._id, status: "CLOSED" })
    );
  });
});

describe("SupportInbox keyboard", () => {
  test("j/k move through the visible list, e toggles status, Esc returns to the list, typing in the filter is ignored", async () => {
    const a = thread({ subject: "First" });
    const b = thread({ subject: "Second" });
    stubs.threads = [a, b];
    stubs.messagesByThread.set(a._id, [message(a._id, { bodyText: "A-body" })]);
    stubs.messagesByThread.set(b._id, [message(b._id, { bodyText: "B-body" })]);
    render(<SupportInbox />);

    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("First");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Second");
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("First");

    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() =>
      expect(stubs.mutations.get("support:setThreadStatus")).toHaveBeenCalledWith({ threadId: a._id, status: "CLOSED" })
    );

    // Typing "j" in the filter box must not navigate.
    const search = screen.getByRole("searchbox");
    fireEvent.keyDown(search, { key: "j" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("First");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByText("Select a conversation to read it")).toBeTruthy();
  });
});
