import { statfs, writeFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import type { Page } from "@playwright/test";

type Observation<T> = { status: "AVAILABLE"; value: T } | { status: "UNAVAILABLE" };

// Diagnostics must not hold a failing browser open or replace its capture error.
async function observe<T>(operation: () => Promise<T>): Promise<Observation<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation().then((value): Observation<T> => ({ status: "AVAILABLE", value })),
      new Promise<Observation<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "UNAVAILABLE" }), 250);
      }),
    ]);
  } catch {
    return { status: "UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

async function captureState(page: Page) {
  const [documentState, sharedMemory] = await Promise.all([
    observe(() => page.evaluate(() => ({
      visibility: document.visibilityState,
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      devicePixelRatio,
    }))),
    observe(async () => {
      const value = await statfs("/dev/shm");
      return { totalBytes: value.blocks * value.bsize, freeBytes: value.bavail * value.bsize };
    }),
  ]);
  return {
    pageClosed: page.isClosed(),
    browserConnected: page.context().browser()?.isConnected() ?? false,
    viewport: page.viewportSize(),
    document: documentState,
    sharedMemory,
    hostMemory: { totalBytes: totalmem(), freeBytes: freemem() },
    nodeMemory: process.memoryUsage(),
  };
}

function readSafely<T>(operation: () => T): Observation<T> {
  try { return { status: "AVAILABLE", value: operation() }; }
  catch { return { status: "UNAVAILABLE" }; }
}

/** Anonymous document facts, not a compositor acknowledgement or readiness guarantee. */
async function documentFacts(page: Page) {
  return observe(async () => {
    const raw: unknown = await page.evaluate(() => {
      const paints = performance.getEntriesByType("paint");
      return {
        observedAt: performance.now(),
        documentComplete: document.readyState === "complete" ? 1 : 0,
        visible: document.visibilityState === "visible" ? 1 : 0,
        fontsLoaded: document.fonts ? (document.fonts.status === "loaded" ? 1 : 0) : null,
        fontCount: document.fonts?.size ?? null,
        width: innerWidth, height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        devicePixelRatio,
        firstPaint: paints.find(entry => entry.name === "first-paint")?.startTime ?? null,
        firstContentfulPaint: paints.find(entry => entry.name === "first-contentful-paint")?.startTime ?? null,
      };
    });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unavailable document facts");
    const record = raw as Record<string, unknown>;
    const safe: Record<string, number | null> = {};
    for (const key of ["observedAt", "documentComplete", "visible", "fontsLoaded", "fontCount", "width", "height",
      "documentWidth", "documentHeight", "devicePixelRatio", "firstPaint", "firstContentfulPaint"]) {
      const value = record[key];
      const nullable = ["fontsLoaded", "fontCount", "firstPaint", "firstContentfulPaint"].includes(key);
      if ((value === null && !nullable) ||
        (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e15)))
        throw new Error("Unavailable document fact");
      safe[key] = value;
    }
    return safe;
  });
}

/** One original screenshot request. Optional document observations yield before it;
 * their timing can perturb capture and is not evidence of a causal repair. */
export async function captureWithDiagnostics(
  page: Page,
  options: Parameters<Page["screenshot"]>[0],
  diagnosticPath: () => string,
  documentReceiptPath?: () => string,
): Promise<Buffer> {
  const before = readSafely(() => ({ pageClosed: page.isClosed(), viewport: page.viewportSize() }));
  const browser = readSafely(() => page.context().browser());
  let pageCrashed = false;
  let browserDisconnected = false;
  const onCrash = () => { pageCrashed = true; };
  const onDisconnect = () => { browserDisconnected = true; };
  const pageListener = readSafely(() => { page.on("crash", onCrash); return true; });
  const browserListener = readSafely(() => {
    if (browser.status !== "AVAILABLE" || !browser.value) throw new Error("Browser unavailable");
    browser.value.on("disconnected", onDisconnect);
    return true;
  });
  let documentBefore: Awaited<ReturnType<typeof documentFacts>> | undefined;
  let captureStatus: "CAPTURE_FAILED" | "CAPTURE_SUCCEEDED" = "CAPTURE_FAILED";
  try {
    if (documentReceiptPath) documentBefore = await documentFacts(page);
    const image = await page.screenshot(options);
    captureStatus = "CAPTURE_SUCCEEDED";
    return image;
  } catch (error) {
    // Every diagnostic operation, including synchronous SDK getters and JSON
    // serialization, is subordinate to the original capture rejection.
    try {
      const after = await captureState(page).then(
        (value): Observation<Awaited<ReturnType<typeof captureState>>> => ({ status: "AVAILABLE", value }),
        (): Observation<Awaited<ReturnType<typeof captureState>>> => ({ status: "UNAVAILABLE" }),
      );
      const browserVersion = readSafely(() => {
        if (browser.status !== "AVAILABLE" || !browser.value) throw new Error("Browser unavailable");
        return browser.value.version();
      });
      const evidence = JSON.stringify({
        status: "CAPTURE_FAILED", before, after, browserVersion,
        lifecycle: {
          pageCrash: pageListener.status === "AVAILABLE" ? { status: "AVAILABLE", occurred: pageCrashed } : { status: "UNAVAILABLE" },
          browserDisconnect: browserListener.status === "AVAILABLE" ? { status: "AVAILABLE", occurred: browserDisconnected } : { status: "UNAVAILABLE" },
        },
      });
      const publication = await observe(async () => {
        if (Buffer.byteLength(evidence) > 16_384) throw new Error("Diagnostic exceeds bound");
        await writeFile(diagnosticPath(), evidence, { flag: "wx" });
      });
      if (publication.status === "UNAVAILABLE") console.error("BROWSER_CAPTURE_DIAGNOSTIC_UNAVAILABLE");
    } catch {
      // Fixed metadata only; even a broken diagnostic sink cannot replace error.
      readSafely(() => console.error("BROWSER_CAPTURE_DIAGNOSTIC_UNAVAILABLE"));
    }
    throw error;
  } finally {
    if (documentReceiptPath) {
      // Failure-only diagnostics above remain intact. This separate receipt also
      // records successful attempts; no error messages, URLs or page text enter it.
      try {
        const after = await documentFacts(page);
        const publication = await observe(async () => {
          const evidence = JSON.stringify({
            status: captureStatus,
            before: { document: documentBefore ?? { status: "UNAVAILABLE" } },
            after: { document: after },
            lifecycle: {
              pageCrash: pageListener.status === "AVAILABLE" ? { status: "AVAILABLE", occurred: pageCrashed } : { status: "UNAVAILABLE" },
              browserDisconnect: browserListener.status === "AVAILABLE" ? { status: "AVAILABLE", occurred: browserDisconnected } : { status: "UNAVAILABLE" },
            },
          });
          if (Buffer.byteLength(evidence) > 16_384) throw new Error("Diagnostic exceeds bound");
          await writeFile(documentReceiptPath(), evidence, { flag: "wx" });
        });
        if (publication.status === "UNAVAILABLE") readSafely(() => console.error("BROWSER_DOCUMENT_RECEIPT_UNAVAILABLE"));
      } catch { readSafely(() => console.error("BROWSER_DOCUMENT_RECEIPT_UNAVAILABLE")); }
    }
    readSafely(() => page.off("crash", onCrash));
    readSafely(() => {
      if (browser.status === "AVAILABLE") browser.value?.off("disconnected", onDisconnect);
    });
  }
}
