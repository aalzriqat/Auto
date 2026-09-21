import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import {
  USER_AUTH_FILE,
  authenticatedConvexClient,
} from "../../playwright/utils";
import type {
  BrowserAttackHandlerRegistry,
  BrowserMissionExecutionContext,
} from "./browserAttackSwarmExecutor";
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

async function ensureArtifactRoot(paths: ArtifactWriter): Promise<void> {
  await mkdir(absoluteArtifact(paths.root), { recursive: true });
}

function baseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
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
  await page
    .waitForURL(/\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/, {
      timeout: 20_000,
    })
    .catch(() => {});
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

  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext({
    baseURL: baseUrl(),
    storageState: USER_AUTH_FILE,
  });

  const abort = () => {
    void browser.close();
  };
  context.signal.addEventListener("abort", abort, { once: true });

  await browserContext.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: false,
  });
  const page = await browserContext.newPage();

  return { browser, browserContext, page, paths };
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

  if (!page.isClosed()) {
    await page
      .screenshot({
        path: absoluteArtifact(paths.screenshot),
        fullPage: true,
      })
      .then(() => artifacts.push(paths.screenshot))
      .catch(() => {});
  }

  await browserContext.tracing
    .stop({ path: absoluteArtifact(paths.trace) })
    .then(() => artifacts.push(paths.trace))
    .catch(() => {});

  await browser.close().catch(() => {});
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

  try {
    const orgIdBefore = await resolveOrgRoute(runtime.page);
    const client = await authenticatedConvexClient(runtime.page);
    const orgs = await client.query(api.organizations.listMine, {});
    const backendOwnsOrg =
      Boolean(orgIdBefore) &&
      Array.isArray(orgs) &&
      orgs.some(
        (entry: { _id?: string }) => String(entry?._id ?? "") === orgIdBefore,
      );

    const toggle = runtime.page.getByRole("button", { name: /^(en|ar)$/i });
    const toggleVisible = await toggle
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    let switched = false;
    if (toggleVisible) {
      const label = ((await toggle.textContent().catch(() => "")) ?? "")
        .trim()
        .toLowerCase();
      if (label === "en") {
        switched = await toggle
          .click()
          .then(() => true)
          .catch(() => false);
      } else if (label === "ar") {
        switched = true;
      }
    }

    if (switched) {
      await runtime.page.waitForTimeout(250);
    }

    const html = runtime.page.locator("html");
    const dir = await html.getAttribute("dir").catch(() => null);
    const lang = await html.getAttribute("lang").catch(() => null);
    const orgIdAfter = orgIdFromUrl(runtime.page.url());
    const passed =
      backendOwnsOrg &&
      toggleVisible &&
      switched &&
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
      switched,
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
          ? "Arabic mode preserved the authenticated organization while flipping the document to ar/rtl."
          : "RTL parity diverged from the authenticated backend organization or failed to reach ar/rtl.",
      },
      artifacts,
    };
  } catch (error) {
    await finishMissionBrowser(runtime);
    throw error;
  }
}

async function safeVisible(
  page: Page,
  role: "button" | "dialog",
  name: string | RegExp,
): Promise<boolean> {
  return await page
    .getByRole(role, { name })
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
}

async function runUiBackendMismatchAttack(
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await openMissionBrowser(context);

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
    let dialogVisible = false;
    let formFilled = false;
    let submitted = false;

    if (addVisible) {
      await runtime.page
        .getByRole("button", { name: "Add Customer", exact: true })
        .click()
        .catch(() => {});
      dialogVisible = await safeVisible(runtime.page, "dialog", /Add Customer/);
    }

    if (dialogVisible) {
      const dialog = runtime.page.getByRole("dialog");
      const first = dialog.getByLabel("First Name");
      const last = dialog.getByLabel("Last Name");
      const emailField = dialog.getByLabel("Email");
      formFilled =
        (await first.fill(firstName).then(() => true).catch(() => false)) &&
        (await last.fill(lastName).then(() => true).catch(() => false)) &&
        (await emailField.fill(email).then(() => true).catch(() => false));

      if (formFilled) {
        submitted = await dialog
          .getByRole("button", { name: "Add Customer", exact: true })
          .click()
          .then(() => true)
          .catch(() => false);
      }
    }

    const client = await authenticatedConvexClient(runtime.page);
    const backendMatches = await client
      .query(api.customers.search, {
        orgId: orgId as never,
        search: email,
      })
      .catch(() => []);

    const exactBackendMatches = Array.isArray(backendMatches)
      ? backendMatches.filter(
          (customer: { email?: string; firstName?: string; lastName?: string }) =>
            customer.email === email &&
            customer.firstName === firstName &&
            customer.lastName === lastName,
        )
      : [];

    await runtime.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    const searchInput = runtime.page
      .locator('main input[placeholder^="Search"]:not([readonly])')
      .first();
    if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await searchInput.fill(email).catch(() => {});
    }
    const visibleAfterReload = await runtime.page
      .getByText(lastName, { exact: false })
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    const passed =
      addVisible &&
      dialogVisible &&
      formFilled &&
      submitted &&
      exactBackendMatches.length === 1 &&
      visibleAfterReload;

    const backendArtifact = await writeBackendEvidence(runtime.paths, {
      attack: "UI_BACKEND_MISMATCH",
      orgId,
      addVisible,
      dialogVisible,
      formFilled,
      submitted,
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
    await finishMissionBrowser(runtime);
    throw error;
  }
}

export function createInitialBrowserAttackHandlers(): BrowserAttackHandlerRegistry {
  return {
    RTL_PARITY: runRtlParityAttack,
    UI_BACKEND_MISMATCH: runUiBackendMismatchAttack,
  };
}
