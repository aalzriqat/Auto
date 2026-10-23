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

/** One original screenshot request; no awaited observation before it starts. */
export async function captureWithDiagnostics(
  page: Page,
  options: Parameters<Page["screenshot"]>[0],
  diagnosticPath: () => string,
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
  try {
    return await page.screenshot(options);
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
    readSafely(() => page.off("crash", onCrash));
    readSafely(() => {
      if (browser.status === "AVAILABLE") browser.value?.off("disconnected", onDisconnect);
    });
  }
}
