// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { scrollAuditContent } from "./scroll";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function screenRoot(target: "main" | "page", height = 1_600) {
  const main = document.createElement("main");
  main.style.overflowY = target === "main" ? "auto" : "visible";
  document.body.append(main);
  const root = target === "main" ? main : document.documentElement;
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: document.documentElement });
  let scrollHeight = height;
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => scrollHeight });
  const positions: number[] = [];
  root.scrollTop = 0;
  root.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    root.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    positions.push(root.scrollTop);
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  return { main, root, positions, grow: () => { scrollHeight += 400; } };
}

test.each(["main", "page"] as const)("audit traverses %s in overlapping steps and returns to the top", async (target) => {
  const { main, root, positions } = screenRoot(target);
  await scrollAuditContent(main);
  expect(positions).toEqual([0, 200, 400, 600, 800, 1_000, 1_200, 0]);
  expect(root.scrollTop).toBe(0);
});

test("audit follows content that grows during the traversal", async () => {
  const { main, positions, grow } = screenRoot("main");
  const frames = vi.fn((callback: FrameRequestCallback) => {
    queueMicrotask(() => {
      if (frames.mock.calls.length === 4) grow();
      callback(0);
    });
    return 1;
  });
  vi.stubGlobal("requestAnimationFrame", frames);
  await scrollAuditContent(main);
  expect(positions).toEqual([0, 200, 400, 600, 800, 1_000, 1_200, 1_400, 1_600, 0]);
});

test("audit leaves a screen without overflow at the top", async () => {
  const { main, positions } = screenRoot("main", 400);
  await scrollAuditContent(main);
  expect(positions).toEqual([0, 0]);
});

test("audit fails if scrolling cannot progress and still restores the top", async () => {
  const { main, root } = screenRoot("main");
  root.scrollTo = () => {};
  await expect(scrollAuditContent(main)).rejects.toThrow("Audit could not advance");
  expect(root.scrollTop).toBe(0);
});

test("audit refuses a list that keeps growing beyond its traversal bound", async () => {
  const { main, grow } = screenRoot("main");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => { grow(); callback(0); });
    return 1;
  });
  await expect(scrollAuditContent(main)).rejects.toThrow("within the scroll bound");
});

test("audit refuses an unavailable page scroll container", async () => {
  const { main } = screenRoot("page");
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: null });
  await expect(scrollAuditContent(main)).rejects.toThrow("Audit scroll container is unavailable");
});
