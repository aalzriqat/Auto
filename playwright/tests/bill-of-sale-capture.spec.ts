import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { captureWithDiagnostics } from "../visual/browserCaptureDiagnostics";

// Playwright's runtime emitter exposes this Node diagnostic capability, but its
// public Page/Browser types omit it. Validate rather than casting those types.
function countListeners(emitter: object, event: string): number {
  if (!("listenerCount" in emitter) || typeof emitter.listenerCount !== "function") {
    throw new Error("Listener inspection unavailable");
  }
  const count: unknown = Reflect.apply(emitter.listenerCount, emitter, [event]);
  if (typeof count !== "number") throw new Error("Invalid listener count");
  return count;
}

test("failed capture preserves the original rejection and leaves sanitized diagnostic evidence", async ({ page }, testInfo) => {
  await page.setContent("<main>Anonymous capture control</main>");
  const original = page.screenshot;
  const sentinel = new Error("secret-marker-do-not-publish");
  let calls = 0;
  // Playwright SDK boundary: simulate Chromium refusing the one capture request.
  page.screenshot = async () => { calls += 1; throw sentinel; };
  const output = testInfo.outputPath("failure.json");
  let rejected: unknown;
  try {
    const result = captureWithDiagnostics(page, { fullPage: true }, () => output).catch((error: unknown) => error);
    expect(calls, "capture begins before any asynchronous telemetry wait").toBe(1);
    rejected = await result;
  }
  finally { page.screenshot = original; }
  expect(rejected).toBe(sentinel);
  expect(calls).toBe(1);
  expect(existsSync(output)).toBe(true);
  const raw = readFileSync(output, "utf8");
  expect(raw).not.toContain("secret-marker");
  expect(raw.length).toBeLessThan(16_384);
  const evidence = JSON.parse(raw);
  expect(evidence.status).toBe("CAPTURE_FAILED");
  expect(evidence.before.value.pageClosed).toBe(false);
  expect(evidence.after.value.document.status).toBe("AVAILABLE");
  expect(evidence.after.value.document.value.visibility).toBe("visible");
});
test("diagnostic publication failure cannot replace Chromium capture rejection", async ({ page }, testInfo) => {
  const original = page.screenshot;
  const sentinel = new Error("Capture rejected");
  page.screenshot = async () => { throw sentinel; };
  const blocker = testInfo.outputPath("diagnostic-blocker");
  writeFileSync(blocker, "not a directory");
  let rejected: unknown;
  try { await captureWithDiagnostics(page, { fullPage: true }, () => join(blocker, "failure.json")); }
  catch (error) { rejected = error; }
  finally { page.screenshot = original; }
  expect(rejected).toBe(sentinel);
  expect(statSync(blocker).isFile()).toBe(true);
  expect(existsSync(join(blocker, "failure.json"))).toBe(false);
});

test("closed browser page leaves failure state and no lifecycle listener leak", async ({ page }, testInfo) => {
  const browser = page.context().browser()!;
  const pageListeners = countListeners(page, "crash");
  const browserListeners = countListeners(browser, "disconnected");
  await page.close();
  const output = testInfo.outputPath("closed.json");
  await expect(captureWithDiagnostics(page, { fullPage: true }, () => output)).rejects.toThrow(/closed/);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  expect(evidence.before.value.pageClosed).toBe(true);
  expect(evidence.after.value.pageClosed).toBe(true);
  expect(evidence.after.value.document.status).toBe("UNAVAILABLE");
  expect(countListeners(page, "crash")).toBe(pageListeners);
  expect(countListeners(browser, "disconnected")).toBe(browserListeners);
});

test("successful capture returns the real PNG and releases listeners without failure evidence", async ({ page }, testInfo) => {
  await page.setContent("<main>Anonymous successful capture</main>");
  const browser = page.context().browser()!;
  const pageListeners = countListeners(page, "crash");
  const browserListeners = countListeners(browser, "disconnected");
  const output = testInfo.outputPath("unexpected.json");
  const image = await captureWithDiagnostics(page, { fullPage: true }, () => output);
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(existsSync(output)).toBe(false);
  expect(countListeners(page, "crash")).toBe(pageListeners);
  expect(countListeners(browser, "disconnected")).toBe(browserListeners);
});
test("unresponsive browser telemetry cannot hold the capture rejection open", async ({ page }, testInfo) => {
  test.setTimeout(5_000);
  const evaluate = page.evaluate;
  const screenshot = page.screenshot;
  const sentinel = new Error("Capture refused while telemetry is unresponsive");
  // SDK boundary: a disconnected renderer can leave its telemetry request pending.
  page.evaluate = () => new Promise<never>(() => {});
  let calls = 0;
  page.screenshot = async () => { calls += 1; throw sentinel; };
  const output = testInfo.outputPath("unresponsive.json");
  let rejection: unknown;
  try {
    const result = captureWithDiagnostics(page, { fullPage: true }, () => output).catch((error: unknown) => error);
    expect(calls, "capture begins before any asynchronous telemetry wait").toBe(1);
    rejection = await result;
  }
  finally { page.evaluate = evaluate; page.screenshot = screenshot; }
  expect(rejection).toBe(sentinel);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  expect(evidence.before.status).toBe("AVAILABLE");
  // The timed-out document is unavailable; synchronous metadata faults can
  // also make the whole post-capture observation unavailable.
  if (evidence.after.status === "AVAILABLE") {
    expect(evidence.after.value.document.status).toBe("UNAVAILABLE");
  } else {
    expect(evidence.after.status).toBe("UNAVAILABLE");
  }
});
for (const failureAt of ["before", "after"] as const) {
  test(`SDK metadata fault ${failureAt} capture preserves the sole capture and its rejection`, async ({ page }, testInfo) => {
    const viewportSize = page.viewportSize;
    const screenshot = page.screenshot;
    const sentinel = new Error("Original capture rejection");
    let calls = 0;
    let reads = 0;
    page.viewportSize = () => {
      reads += 1;
      if (failureAt === "before" || reads > 1) throw new Error("Metadata getter fault");
      return viewportSize.call(page);
    };
    page.screenshot = async () => { calls += 1; throw sentinel; };
    let rejection: unknown;
    try { await captureWithDiagnostics(page, { fullPage: true }, () => testInfo.outputPath("getter.json")); }
    catch (error) { rejection = error; }
    finally { page.viewportSize = viewportSize; page.screenshot = screenshot; }
    expect(calls).toBe(1);
    expect(rejection).toBe(sentinel);
  });
}
test("diagnostic destination is resolved only after the original capture rejects", async ({ page }) => {
  const screenshot = page.screenshot;
  const sentinel = new Error("Original capture rejection");
  let captures = 0;
  let destinations = 0;
  const order: string[] = [];
  let rejectCapture: (reason: Error) => void = () => { throw new Error("Pending capture not initialized"); };
  const pendingCapture = new Promise<Buffer>((_resolve, reject) => { rejectCapture = reject; });
  page.screenshot = () => { order.push("capture"); captures += 1; return pendingCapture; };
  let result: Promise<unknown> | undefined;
  let rejection: unknown;
  try {
    result = captureWithDiagnostics(page, { fullPage: true }, () => {
      order.push("destination");
      destinations += 1;
      throw new Error("Diagnostic output directory unavailable");
    }).catch((error: unknown) => error);
    expect(captures).toBe(1);
    // Let a premature microtask resolve the destination while capture is pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(destinations, "pending capture has not rejected").toBe(0);
    order.push("reject");
    rejectCapture(sentinel);
    rejection = await result;
  } finally {
    rejectCapture(sentinel);
    await result;
    page.screenshot = screenshot;
  }
  expect(captures).toBe(1);
  expect(destinations).toBe(1);
  expect(order).toEqual(["capture", "reject", "destination"]);
  expect(rejection).toBe(sentinel);
});
