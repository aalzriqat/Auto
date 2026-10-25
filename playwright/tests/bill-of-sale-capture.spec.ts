import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { captureWithDiagnostics } from "../visual/browserCaptureDiagnostics";

for (const outcome of ["success", "rejection"] as const) {
  test(`document receipt preserves one full-page capture and ${outcome}`, async ({ page }, testInfo) => {
    await page.setContent("<main>private-text-must-not-appear-in-receipt</main>");
    const original = page.screenshot;
    const sentinel = new Error("private-error-must-not-appear-in-receipt");
    const expected = Buffer.from("synthetic-sdk-bytes");
    let calls = 0;
    page.screenshot = async options => {
      calls += 1;
      expect(options?.fullPage).toBe(true);
      if (outcome === "rejection") throw sentinel;
      return expected;
    };
    const receipt = testInfo.outputPath("document-receipt.json");
    let result: unknown;
    try {
      result = await captureWithDiagnostics(page, { fullPage: true },
        () => testInfo.outputPath("failure.json"), () => receipt).catch((error: unknown) => error);
    } finally { page.screenshot = original; }
    expect(calls).toBe(1);
    expect(result).toBe(outcome === "rejection" ? sentinel : expected);
    const raw = readFileSync(receipt, "utf8");
    expect(raw).not.toContain("private-");
    const evidence = JSON.parse(raw);
    expect(evidence.status).toBe(outcome === "rejection" ? "CAPTURE_FAILED" : "CAPTURE_SUCCEEDED");
    expect(evidence.before.document.status).toBe("AVAILABLE");
    expect(evidence.after.document.status).toBe("AVAILABLE");
    expect(existsSync(testInfo.outputPath("failure.json"))).toBe(outcome === "rejection");
  });
}

for (const fault of ["invalid", "null-dimensions", "unresponsive"] as const) {
  test(`document receipt marks ${fault} SDK facts unavailable without preventing capture`, async ({ page }, testInfo) => {
    test.setTimeout(5_000);
    const evaluate = page.evaluate, screenshot = page.screenshot;
    page.evaluate = fault === "unresponsive" ? () => new Promise<never>(() => {}) :
      fault === "null-dimensions" ? async () => ({
        observedAt: 0, documentComplete: 1, visible: 1, fontsLoaded: null, fontCount: null,
        width: null, height: null, documentWidth: null, documentHeight: null, devicePixelRatio: null,
        firstPaint: null, firstContentfulPaint: null,
      }) as never : async () => ({ width: "private-sdk-marker" }) as never;
    let calls = 0;
    const image = Buffer.from("synthetic-sdk-bytes");
    page.screenshot = async () => { calls += 1; return image; };
    const output = testInfo.outputPath("unavailable-document.json");
    let result: Buffer;
    try {
      result = await captureWithDiagnostics(page, { fullPage: true },
        () => testInfo.outputPath("unused-failure.json"), () => output);
    } finally { page.evaluate = evaluate; page.screenshot = screenshot; }
    expect(result).toBe(image);
    expect(calls).toBe(1);
    const raw = readFileSync(output, "utf8");
    expect(raw).not.toContain("private-sdk-marker");
    expect(raw.length).toBeLessThan(16_384);
    const receipt = JSON.parse(raw);
    expect(receipt.status).toBe("CAPTURE_SUCCEEDED");
    expect(receipt.before.document.status).toBe("UNAVAILABLE");
    expect(receipt.after.document.status).toBe("UNAVAILABLE");
  });
}

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
  try { await captureWithDiagnostics(page, { fullPage: true }, () => join(blocker, "failure.json"),
    () => join(blocker, "document.json")); }
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
  expect(evidence.after.status).toBe("AVAILABLE");
  expect(evidence.after.value.document.status).toBe("UNAVAILABLE");
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
    const evidence = JSON.parse(readFileSync(testInfo.outputPath("getter.json"), "utf8"));
    expect(evidence.before.status).toBe(failureAt === "before" ? "UNAVAILABLE" : "AVAILABLE");
    expect(evidence.after.status).toBe("UNAVAILABLE");
  });
}
test("oversize SDK metadata cannot publish a diagnostic or replace the capture rejection", async ({ page }, testInfo) => {
  const browser = page.context().browser()!;
  const version = browser.version;
  const screenshot = page.screenshot;
  const sentinel = new Error("Original capture rejection");
  const output = testInfo.outputPath("oversize.json");
  let destinationCalls = 0;
  browser.version = () => "x".repeat(20_000);
  page.screenshot = async () => { throw sentinel; };
  let rejection: unknown;
  try {
    rejection = await captureWithDiagnostics(page, { fullPage: true }, () => {
      destinationCalls += 1;
      return output;
    }).catch((error: unknown) => error);
  } finally { browser.version = version; page.screenshot = screenshot; }
  expect(rejection).toBe(sentinel);
  expect(destinationCalls).toBe(0);
  expect(existsSync(output)).toBe(false);
});
test("diagnostic destination is resolved only after the original capture rejects", async ({ page }) => {
  test.setTimeout(5_000);
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
    // Keep capture pending past both 250 ms observations. This detects an
    // early destination lookup even when it runs on a later timer or I/O turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
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
