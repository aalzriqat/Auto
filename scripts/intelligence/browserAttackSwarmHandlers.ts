import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  USER_AUTH_FILE,
  authenticatedConvexClient,
} from "../../playwright/utils";
import type {
  BrowserAttackHandlerRegistry,
  BrowserMissionExecutionContext,
} from "./browserAttackSwarmExecutor";
import { browserSwarmLocalBaseUrl } from "./browserAttackSwarmRuntime";
import type { BrowserMissionEvidence } from "./browserAttackSwarm";

type ArtifactWriter = {
  root: string;
  trace: string;
  screenshot: string;
  backendState: string;
};

function safeLeaf(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}

function artifactPaths(
  context: BrowserMissionExecutionContext,
): ArtifactWriter {
  const missionLeaf = safeLeaf(context.mission.id);
  const root = context.worker.artifactRoot + "/" + missionLeaf;
  return {
    root,
    trace: root + "/trace.zip",
    screenshot: root + "/final.png",
    backendState: root + "/backend-state.json",
  };
}

function absoluteArtifact(relativePath: string): string {
  return path.resolve(process.cwd(), relativePath);
}

function throwIfMissionAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Browser mission was aborted before the browser operation completed.");
}

async function ensureArtifactRoot(paths: ArtifactWriter): Promise<void> {
  await mkdir(absoluteArtifact(paths.root), { recursive: true });
}

function orgIdFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = /^\/([^/]+)\/(dashboard|sales|leads|accounting|vehicles|customers|expenses)/.exec(
      pathname,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function resolveOrgRoute(page: Page): Promise<string | null> {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForURL(
    /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/,
    { timeout: 20_000 },
  );
  return orgIdFromUrl(page.url());
}

async function openMissionBrowser(
  context: BrowserMissionExecutionContext,
): Promise<{
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  paths: ArtifactWriter;
}> {
  const paths = artifactPaths(context);
  await ensureArtifactRoot(paths);
  throwIfMissionAborted(context.signal);

  const browser = await chromium.launch({ headless: true });
  const abort = () => {
    void browser.close().catch((error: unknown) => {
      const kind = error instanceof Error ? error.name : typeof error;
      console.error("Browser swarm abort cleanup failed (" + kind + ").");
    });
  };
  context.signal.addEventListener("abort", abort, { once: true });

  try {
    // The timeout may have fired while chromium.launch() was still resolving.
    // addEventListener does not replay an abort that already happened, so the
    // explicit check here is load-bearing: without it a timed-out handler can
    // proceed into mutations after the executor has already decided to abort.
    throwIfMissionAborted(context.signal);

    const browserContext = await browser.newContext({
      baseURL: browserSwarmLocalBaseUrl(process.env),
      storageState: USER_AUTH_FILE,
    });
    throwIfMissionAborted(context.signal);

    await browserContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    throwIfMissionAborted(context.signal);

    const page = await browserContext.newPage();
    throwIfMissionAborted(context.signal);

    return { browser, browserContext, page, paths };
  } catch (error) {
    context.signal.removeEventListener("abort", abort);
    try {
      await browser.close();
    } catch (cleanupError) {
      if (
        error instanceof Error &&
        cleanupError instanceof Error &&
        error.cause === undefined
      ) {
        error.cause = cleanupError;
      }
    }
    throw error;
  }
}

async function finishMissionBrowser({
  browser,
  browserContext,
  page,
  paths,
}: {
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  paths: ArtifactWriter;
}): Promise<readonly string[]> {
  const artifacts: string[] = [];
  const failures: Error[] = [];

  if (!page.isClosed()) {
    try {
      await page.screenshot({
        path: absoluteArtifact(paths.screenshot),
        fullPage: true,
      });
      artifacts.push(paths.screenshot);
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("Browser swarm screenshot capture failed."),
      );
    }
  }

  try {
    await browserContext.tracing.stop({ path: absoluteArtifact(paths.trace) });
    artifacts.push(paths.trace);
  } catch (error) {
    failures.push(
      error instanceof Error
        ? error
        : new Error("Browser swarm trace capture failed."),
    );
  }

  try {
    await browser.close();
  } catch (error) {
    failures.push(
      error instanceof Error
        ? error
        : new Error("Browser swarm browser close failed."),
    );
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Browser swarm evidence cleanup did not complete successfully.",
    );
  }

  return artifacts;
}

async function writeBackendEvidence(
  paths: ArtifactWriter,
  value: unknown,
): Promise<string> {
  await writeFile(
    absoluteArtifact(paths.backendState),
    JSON.stringify(value, null, 2),
    "utf8",
  );
  return paths.backendState;
}

async function runRtlParityAttack(
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await openMissionBrowser(context);
  let cleanupStarted = false;

  try {
    const orgIdBefore = await resolveOrgRoute(runtime.page);
    if (!orgIdBefore) {
      throw new Error(
        "RTL parity harness could not resolve the authenticated organization route.",
      );
    }

    const client = await authenticatedConvexClient(runtime.page);
    const orgs = await client.query(api.organizations.listMine, {});
    if (!Array.isArray(orgs)) {
      throw new Error(
        "RTL parity harness received a non-array organization authority response.",
      );
    }
    const backendOwnsOrg = orgs.some(
      (entry) => entry !== null && String(entry._id) === orgIdBefore,
    );

    const toggle = runtime.page.getByRole("button", { name: /^(en|ar)$/i });
    const toggleVisible = await toggle.isVisible({ timeout: 5_000 });

    if (!toggleVisible) {
      throw new Error(
        "RTL parity harness could not locate the EN/AR language control.",
      );
    }

    const label = ((await toggle.textContent()) ?? "").trim().toLowerCase();
    if (label === "en") {
      await toggle.click();
    } else if (label !== "ar") {
      throw new Error(
        "RTL parity harness could not operate the EN/AR language control.",
      );
    }

    await runtime.page.waitForTimeout(250);

    const html = runtime.page.locator("html");
    const dir = await html.getAttribute("dir");
    const lang = await html.getAttribute("lang");
    const orgIdAfter = orgIdFromUrl(runtime.page.url());
    const passed =
      backendOwnsOrg &&
      dir === "rtl" &&
      lang === "ar" &&
      orgIdAfter === orgIdBefore;

    const backendArtifact = await writeBackendEvidence(runtime.paths, {
      attack: "RTL_PARITY",
      backendOwnsOrg,
      orgIdBefore,
      orgIdAfter,
      dir,
      lang,
      toggleVisible,
      switched: true,
    });
    cleanupStarted = true;
    cleanupStarted = true;
    const artifacts = [
      ...(await finishMissionBrowser(runtime)),
      backendArtifact,
    ];

    return {
      missionId: context.mission.id,
      workerId: context.worker.workerId,
      startedAt,
      completedAt: new Date().toISOString(),
      oracle: {
        kind: "UI_BACKEND_AUTHORITY",
        passed,
        summary: passed
          ? "Arabic mode preserved the authenticated organization while flipping the document to ar/rtl."
          : "RTL parity diverged from the authenticated backend organization or failed to reach ar/rtl.",
      },
      artifacts,
    };
  } catch (error) {
    if (!cleanupStarted) {
      try {
        cleanupStarted = true;
        await finishMissionBrowser(runtime);
      } catch (cleanupError) {
        if (
          error instanceof Error &&
          cleanupError instanceof Error &&
          error.cause === undefined
        ) {
          error.cause = cleanupError;
        }
      }
    }
    throw error;
  }
}

async function safeVisible(
  page: Page,
  role: "button" | "dialog",
  name: string | RegExp,
): Promise<boolean> {
  return await page.getByRole(role, { name }).isVisible({ timeout: 3_000 });
}

async function runUiBackendMismatchAttack(
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await openMissionBrowser(context);
  let cleanupStarted = false;

  try {
    const orgId = await resolveOrgRoute(runtime.page);
    if (!orgId) {
      throw new Error("Authenticated browser did not resolve an organization route.");
    }

    await runtime.page.goto("/" + orgId + "/customers", {
      waitUntil: "domcontentloaded",
    });

    const suffix = Date.now().toString(36) + "-" + safeLeaf(context.worker.workerId);
    const firstName = "Swarm";
    const lastName = "Authority-" + suffix;
    const email = "swarm-" + suffix + "@example.test";

    const addVisible = await safeVisible(
      runtime.page,
      "button",
      "Add Customer",
    );
    if (!addVisible) {
      throw new Error(
        "UI/backend authority harness could not locate the Add Customer control.",
      );
    }

    await runtime.page
      .getByRole("button", { name: "Add Customer", exact: true })
      .click();

    const dialogVisible = await safeVisible(
      runtime.page,
      "dialog",
      /Add Customer/,
    );
    if (!dialogVisible) {
      throw new Error(
        "UI/backend authority harness could not open the Add Customer dialog.",
      );
    }

    const dialog = runtime.page.getByRole("dialog");
    const first = dialog.getByLabel("First Name");
    const last = dialog.getByLabel("Last Name");
    const emailField = dialog.getByLabel("Email");
    await first.fill(firstName);
    await last.fill(lastName);
    await emailField.fill(email);

    await dialog
      .getByRole("button", { name: "Add Customer", exact: true })
      .click();

    const client = await authenticatedConvexClient(runtime.page);
    const backendMatches = await client.query(api.customers.search, {
      orgId: orgId as Id<"organizations">,
      search: email,
    });

    if (!Array.isArray(backendMatches)) {
      throw new Error(
        "UI/backend authority harness received a non-array customer authority response.",
      );
    }
    const exactBackendMatches = backendMatches.filter(
      (customer: { email?: string; firstName?: string; lastName?: string }) =>
        customer.email === email &&
        customer.firstName === firstName &&
        customer.lastName === lastName,
    );

    await runtime.page.reload({ waitUntil: "domcontentloaded" });
    const searchInput = runtime.page
      .locator('main input[placeholder^="Search"]:not([readonly])')
      .first();
    const searchVisible = await searchInput.isVisible({ timeout: 3_000 });
    if (!searchVisible) {
      throw new Error(
        "UI/backend authority harness could not locate the customer search control after reload.",
      );
    }
    await searchInput.fill(email);

    const visibleAfterReload = await runtime.page
      .getByText(lastName, { exact: false })
      .first()
      .isVisible({ timeout: 5_000 });

    const passed =
      exactBackendMatches.length === 1 &&
      visibleAfterReload;

    const backendArtifact = await writeBackendEvidence(runtime.paths, {
      attack: "UI_BACKEND_MISMATCH",
      orgId,
      addVisible,
      dialogVisible,
      formFilled: true,
      submitted: true,
      exactBackendMatchCount: exactBackendMatches.length,
      visibleAfterReload,
      syntheticIdentity: { firstName, lastName, email },
    });
    const artifacts = [
      ...(await finishMissionBrowser(runtime)),
      backendArtifact,
    ];

    return {
      missionId: context.mission.id,
      workerId: context.worker.workerId,
      startedAt,
      completedAt: new Date().toISOString(),
      oracle: {
        kind: "UI_BACKEND_AUTHORITY",
        passed,
        summary: passed
          ? "The customer created through the UI existed exactly once in backend authority and remained visible after reload."
          : "UI mutation state disagreed with backend authority or disappeared after reload.",
      },
      artifacts,
    };
  } catch (error) {
    if (!cleanupStarted) {
      try {
        cleanupStarted = true;
        await finishMissionBrowser(runtime);
      } catch (cleanupError) {
        if (
          error instanceof Error &&
          cleanupError instanceof Error &&
          error.cause === undefined
        ) {
          error.cause = cleanupError;
        }
      }
    }
    throw error;
  }
}

export function createInitialBrowserAttackHandlers(): BrowserAttackHandlerRegistry {
  return {
    RTL_PARITY: runRtlParityAttack,
    UI_BACKEND_MISMATCH: runUiBackendMismatchAttack,
  };
}
