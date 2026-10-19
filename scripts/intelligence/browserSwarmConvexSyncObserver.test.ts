import type { Page, WebSocketRoute } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { ConvexSyncObserver } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-826 F2 — the race barrier. A fake Playwright WebSocketRoute stands in
 * for each tab's Convex sync socket so the observer's forwarding order can be
 * asserted frame by frame: what the page sent, what reached the backend, and
 * in which order.
 */

type Frame = string | Buffer;

interface FakeTab {
  /** The page writes a frame onto its socket. */
  pageSends(frame: Frame): void;
  /** The backend answers on this tab's socket. */
  serverReplies(frame: Frame): void;
  /** Frames the backend has received, in order. */
  toServer: Frame[];
  /** Frames the page has received, in order. */
  toPage: Frame[];
}

const UPDATE = /^expenses(\.js)?:update$/;

async function attachFakeTab(observer: ConvexSyncObserver, label: string): Promise<FakeTab> {
  const toServer: Frame[] = [];
  const toPage: Frame[] = [];
  let fromPage: ((frame: Frame) => void) | undefined;
  let fromServer: ((frame: Frame) => void) | undefined;
  const server = {
    send: (frame: Frame) => toServer.push(frame),
    onMessage: (handler: (frame: Frame) => void) => {
      fromServer = handler;
    },
    close: async () => undefined,
  };
  const route = {
    connectToServer: () => server,
    onMessage: (handler: (frame: Frame) => void) => {
      fromPage = handler;
    },
    send: (frame: Frame) => toPage.push(frame),
    close: async () => undefined,
  } as unknown as WebSocketRoute;
  const page = {
    routeWebSocket: async (
      _matcher: unknown,
      handler: (socket: WebSocketRoute) => void,
    ) => handler(route),
  } as unknown as Page;
  await observer.attach(page, label);
  return {
    pageSends: (frame) => fromPage?.(frame),
    serverReplies: (frame) => fromServer?.(frame),
    toServer,
    toPage,
  };
}

function updateFrame(requestId: number, title: string, amount: number): string {
  return JSON.stringify({
    type: "Mutation",
    requestId,
    udfPath: "expenses:update",
    args: [{ title, amount }],
  });
}

function response(requestId: number, success: boolean): string {
  return JSON.stringify({
    type: "MutationResponse",
    requestId,
    success,
    result: success ? null : "Posted expenses are locked.",
  });
}

describe("SCRUM-826 Convex sync observer race barrier", () => {
  it("holds the first tab's save until the second tab's save exists, then forwards both", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const a = await attachFakeTab(observer, "tab-a");
    const b = await attachFakeTab(observer, "tab-b");
    observer.armRaceBarrier("race-1", ["tab-a", "tab-b"]);

    a.pageSends(updateFrame(7, "race-1", 50));
    expect(a.toServer).toEqual([]);
    expect(observer.raceBarrierSatisfied).toBe(false);

    b.pageSends(updateFrame(9, "race-1", 80));
    expect(observer.raceBarrierSatisfied).toBe(true);
    expect(a.toServer).toHaveLength(1);
    expect(b.toServer).toHaveLength(1);

    a.serverReplies(response(7, true));
    b.serverReplies(response(9, false));
    const sent = observer.mutationsFor("race-1").map((m) => m.sentSeq ?? Infinity);
    const answered = observer.responses.map((r) => r.receivedSeq);
    expect(Math.max(...sent)).toBeLessThan(Math.min(...answered));
    expect(a.toPage).toHaveLength(1);
    expect(b.toPage).toHaveLength(1);
  });

  it("preserves the held tab's socket order for frames sent while it is held", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const a = await attachFakeTab(observer, "tab-a");
    const b = await attachFakeTab(observer, "tab-b");
    observer.armRaceBarrier("race-2", ["tab-a", "tab-b"]);

    a.pageSends(updateFrame(1, "race-2", 50));
    a.pageSends('{"type":"ModifyQuerySet"}');
    expect(a.toServer).toEqual([]);
    b.pageSends(updateFrame(2, "race-2", 80));
    expect(a.toServer).toEqual([updateFrame(1, "race-2", 50), '{"type":"ModifyQuerySet"}']);

    a.pageSends('{"type":"Authenticate"}');
    expect(a.toServer.at(-1)).toBe('{"type":"Authenticate"}');
  });

  it("releases held frames unchanged on timeout and stays unsatisfied (never a fabricated overlap)", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const a = await attachFakeTab(observer, "tab-a");
    await attachFakeTab(observer, "tab-b");
    observer.armRaceBarrier("race-3", ["tab-a", "tab-b"]);

    a.pageSends(updateFrame(1, "race-3", 50));
    expect(a.toServer).toEqual([]);
    observer.releaseRaceBarrier();
    expect(a.toServer).toEqual([updateFrame(1, "race-3", 50)]);
    expect(observer.raceBarrierSatisfied).toBe(false);

    // Once released, later saves pass straight through.
    a.pageSends(updateFrame(2, "race-3", 50));
    expect(a.toServer).toHaveLength(2);
  });

  it("forwards unrelated frames and other titles without holding them", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const a = await attachFakeTab(observer, "tab-a");
    observer.armRaceBarrier("race-4", ["tab-a", "tab-b"]);
    a.pageSends(updateFrame(1, "some-other-title", 10));
    a.pageSends('{"type":"Connect"}');
    expect(a.toServer).toHaveLength(2);
  });

  it("records no send order for a frame that is still held", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const a = await attachFakeTab(observer, "tab-a");
    await attachFakeTab(observer, "tab-b");
    observer.armRaceBarrier("race-5", ["tab-a", "tab-b"]);
    a.pageSends(updateFrame(1, "race-5", 50));
    expect(observer.mutationsFor("race-5")[0].sentSeq).toBeNull();
  });
});

describe("SCRUM-826 O1/O2 Convex sync observer replies per intent", () => {
  it("joins every reply to its intent and marks the withheld lost response", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const tab = await attachFakeTab(observer, "tab-1");
    observer.armLostResponse("lost-1");

    tab.pageSends(updateFrame(3, "lost-1", 43));
    tab.serverReplies(response(3, true));
    // The committed reply was withheld: the page never saw it.
    expect(tab.toPage).toEqual([]);

    // The client reconnects and resends; this reply is client-visible.
    tab.pageSends(updateFrame(3, "lost-1", 43));
    tab.serverReplies(response(3, true));
    tab.pageSends(updateFrame(4, "other", 1));
    tab.serverReplies(response(4, false));

    expect(observer.repliesFor("lost-1")).toEqual([
      { requestId: 3, success: true, withheld: true },
      { requestId: 3, success: true, withheld: false },
    ]);
    expect(observer.repliesFor("other")).toEqual([
      { requestId: 4, success: false, withheld: false, errorText: "Posted expenses are locked." },
    ]);
  });

  it("never withholds a refusal, so a refused lost intent stays visible to the oracle", async () => {
    const observer = new ConvexSyncObserver(UPDATE);
    const tab = await attachFakeTab(observer, "tab-1");
    observer.armLostResponse("lost-2");
    tab.pageSends(updateFrame(8, "lost-2", 43));
    tab.serverReplies(response(8, false));
    expect(observer.withheld).toEqual([]);
    expect(observer.repliesFor("lost-2")).toEqual([
      { requestId: 8, success: false, withheld: false, errorText: "Posted expenses are locked." },
    ]);
  });
});
