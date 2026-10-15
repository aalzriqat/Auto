import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  APPROVER_AUTH_FILE,
  USER_AUTH_FILE,
  authenticatedConvexClient,
} from "../../playwright/utils";
import type {
  BrowserAttackHandlerRegistry,
  BrowserMissionExecutionContext,
} from "./browserAttackSwarmExecutor";
import { browserSwarmLocalBaseUrl } from "./browserAttackSwarmRuntime";
import {
  EGRESS_CONTEXT_OPTIONS,
  browserEgressLaunchOptions,
} from "./browserEgressLaunch.mjs";
import type { BrowserMissionEvidence } from "./browserAttackSwarm";
import { createBoundaryAttackHandlers } from "./browserSwarmBoundaryAttacks";
import {
  createEconomicAttackHandlers,
  type MissionSeat,
} from "./browserSwarmEconomicAttacks";
import { createConsignmentAttackHandlers } from "./browserSwarmConsignmentAttack";
import { createMoneyBoundaryAttackHandlers } from "./browserSwarmMoneyBoundaryAttack";
import { createNetworkRecoveryHandler } from "./browserSwarmNetworkRecoveryAttack";
import { createAccountingDateAttackHandlers } from "./browserSwarmAccountingDateAttack";
import { createNavigationRaceAttackHandlers } from "./browserSwarmNavigationRaceAttack";
import { createStaleUiAttackHandlers } from "./browserSwarmStaleUiAttack";

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
  seat: MissionSeat = "primary",
): ArtifactWriter {
  const missionLeaf = safeLeaf(context.mission.id);
  // A second seat keeps its own trace and screenshot beside the primary's.
  const root =
    context.worker.artifactRoot +
    "/" +
    missionLeaf +
    (seat === "primary" ? "" : "/" + seat);
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

// SCRUM-826 / SCRUM-824 G4: the wait below must be decided by the PATHNAME,
// through the very same parse orgIdFromUrl uses. It used to be an unanchored
// RegExp tested against the FULL URL, so "http://localhost:3000/dashboard"
// matched as "/localhost:3000/dashboard" (host:port read as the org segment)
// before the app had redirected /dashboard to /<orgId>/dashboard; waitForURL
// returned at once, orgIdFromUrl("/dashboard") was null, and both attack
// workers died as HARNESS_ERROR in under a second. With one parser behind both
// the wait and the read, a URL that satisfies the wait always yields an org id.
// Fail closed: if no org-bearing URL appears within the timeout, waitForURL
// rejects and the harness error propagates; no org id is ever invented.
function isOrgRouteUrl(url: URL): boolean {
  return orgIdFromUrl(url.href) !== null;
}

async function resolveOrgRoute(page: Page): Promise<string | null> {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForURL(isOrgRouteUrl, { timeout: 20_000 });
  return orgIdFromUrl(page.url());
}

// playwright-core throws exactly this ("Tracing has been already started") from
// Tracing.start when the context already carries a trace.
const TRACING_ALREADY_STARTED = /tracing has been already started/i;

// SCRUM-826 / SCRUM-824 G4: this handler runs inside the Playwright test runner
// (playwright/tests/browser-swarm.spec.ts), and with `trace: "retain-on-failure"`
// the runner starts tracing on EVERY context created during the test, including
// ones from browser.newContext() on a browser we launched ourselves. A plain
// tracing.start() therefore threw and both attack workers ended HARNESS_ERROR.
//
// Start our own trace when none is running; when the runner already started
// one, begin a fresh chunk of it (startChunk discards the runner's empty chunk)
// so the later tracing.stop({ path }) still writes this mission's trace.zip.
// Any other start failure is a real harness error and is rethrown untouched.
async function startMissionTrace(browserContext: BrowserContext): Promise<void> {
  try {
    await browserContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
  } catch (error) {
    if (!(error instanceof Error) || !TRACING_ALREADY_STARTED.test(error.message)) {
      throw error;
    }
    await browserContext.tracing.startChunk();
  }
}

async function openMissionBrowser(
  context: BrowserMissionExecutionContext,
  seat: MissionSeat = "primary",
): Promise<{
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  paths: ArtifactWriter;
}> {
  const paths = artifactPaths(context, seat);
  await ensureArtifactRoot(paths);
  throwIfMissionAborted(context.signal);

  // SCRUM-784: the saved QA storageState must never be usable from a browser
  // with open egress. Required, so a missing proxy fails the mission instead of
  // silently launching an unconstrained browser.
  const egress = browserEgressLaunchOptions({
    ...process.env,
    BROWSER_EGRESS_REQUIRED: "1",
  });
  const browser = await chromium.launch({ headless: true, ...egress });
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
      storageState: seat === "approver" ? APPROVER_AUTH_FILE : USER_AUTH_FILE,
      ...EGRESS_CONTEXT_OPTIONS,
    });
    throwIfMissionAborted(context.signal);

    await startMissionTrace(browserContext);
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

async function rethrowAfterMissionCleanup(
  runtime: Awaited<ReturnType<typeof openMissionBrowser>>,
  error: unknown,
  cleanupStarted: boolean,
): Promise<never> {
  if (!cleanupStarted) {
    try {
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
      throw new TypeError(
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
    return rethrowAfterMissionCleanup(runtime, error, cleanupStarted);
  }
}

// Locator.isVisible() ignores its timeout option and answers for the instant it
// is called, so it reports false while the app still shows "Loading your
// workspace...". waitFor() is the bounded wait; a control that never appears is
// still false, which the caller turns into a HARNESS_ERROR.
const CONTROL_READY_TIMEOUT_MS = 15_000;
const DIALOG_READY_TIMEOUT_MS = 5_000;

const RELOAD_READY_TIMEOUT_MS = 15_000;
const RESULT_READY_TIMEOUT_MS = 5_000;

async function waitVisible(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return false;
    throw error;
  }
}

// The customers page exposes its paginated-query status on the results wrapper. A
// search is filtered on the client, so "the customer is absent" is a product answer
// only once every page is loaded ("Exhausted"). Until then (LoadingMore, CanLoadMore,
// or no status at all) the page is still searching, and a missing row is not evidence.
const CUSTOMERS_RESULTS_SELECTOR = '[data-testid="customers-results"]';
const CUSTOMERS_STATUS_ATTRIBUTE = "data-customers-status";
const CUSTOMERS_SEARCH_COMPLETE = "Exhausted";
const SEARCH_STATUS_POLL_MS = 250;
const SEARCH_STATUS_MAX_POLLS = 80;
const SEARCH_STATUS_READ_TIMEOUT_MS = 1_000;
// Wall-clock bound: a read can itself wait SEARCH_STATUS_READ_TIMEOUT_MS, so the poll count
// alone would let a missing marker run ~100s, near the 120s mission.
const SEARCH_STATUS_DEADLINE_MS = 20_000;
// An absent marker (no element/attribute) is not "still loading"; give up after a few reads.
const SEARCH_STATUS_MISSING_LIMIT = 3;

// CustomerDialog awaits createCustomer (and the custom fields), then shows the success
// toast and closes; a validation or save failure leaves it open. The UI's own success
// signal is BOTH together, awaited BEFORE any backend verdict: a dialog can also vanish
// without a save (page or RoleGuard removed it), and the toast auto-dismisses, so the two
// are awaited concurrently (either order). Anything less means the save outcome is unknown
// (harness error), never a confirmed breach. Texts: lib/i18n/domains/customers.ts.
const DIALOG_CLOSE_TIMEOUT_MS = 10_000;
const CUSTOMER_ADDED_TOAST = /Customer added successfully|تمت إضافة العميل بنجاح/;

// The create mutation resolved before the dialog closed, so this read should already see the
// committed write; the bounded re-reads are a defensive allowance only. A count that stays 0
// is therefore a real UI/backend mismatch.
const BACKEND_COMMIT_POLL_MS = 500;
const BACKEND_COMMIT_MAX_POLLS = 20;
const BACKEND_COMMIT_DEADLINE_MS = 10_000;
// One Convex read must not hang the mission: it gets its own deadline.
const BACKEND_READ_TIMEOUT_MS = 5_000;
// Time kept back from the mission budget for the screenshot, trace and browser close
// that follow the verdict.
const MISSION_CLEANUP_RESERVE_MS = 15_000;

/** Clamps a wait to what is left of the mission budget; no time left is a harness error. */
type MissionBudget = (wantedMs: number, before: string) => number;

function missionBudget(timeoutMs: number): MissionBudget {
  const deadline = Date.now() + timeoutMs - MISSION_CLEANUP_RESERVE_MS;
  return (wantedMs, before) => {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        "UI/backend authority harness ran out of mission time before " + before + ".",
      );
    }
    return Math.min(wantedMs, left);
  };
}

async function boundedBackendQuery<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              "UI/backend authority harness: the backend customer query did not answer within " +
                timeoutMs +
                "ms.",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitHidden(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "hidden", timeout });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return false;
    throw error;
  }
}

type ResultSettleOutcome = "VISIBLE" | "SETTLED_ABSENT" | "UNSETTLED";
interface ResultSettle {
  outcome: ResultSettleOutcome;
  /** The last status actually read: null when the marker was missing or timed out. */
  lastStatus: string | null;
}

async function readCustomersStatus(page: Page): Promise<string | null> {
  try {
    return await page
      .locator(CUSTOMERS_RESULTS_SELECTOR)
      .getAttribute(CUSTOMERS_STATUS_ATTRIBUTE, { timeout: SEARCH_STATUS_READ_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return null;
    throw error;
  }
}

// Polls (bounded) until a visible matching row appears or the search is complete.
// A complete search is judged by one more bounded wait for the row, so the render that
// follows the final page cannot be mistaken for absence. Worst case: the deadline, plus
// the status read in flight (1s), plus that final wait (5s) — all clamped to the mission budget.
async function settleCustomerResult(
  page: Page,
  result: Locator,
  budget: MissionBudget,
): Promise<ResultSettle> {
  const deadline = Date.now() + budget(SEARCH_STATUS_DEADLINE_MS, "the customers search completed");
  let lastStatus: string | null = null;
  let missingReads = 0;
  for (let poll = 0; poll < SEARCH_STATUS_MAX_POLLS && Date.now() < deadline; poll += 1) {
    if (await result.isVisible()) return { outcome: "VISIBLE", lastStatus };
    lastStatus = await readCustomersStatus(page);
    if (lastStatus === CUSTOMERS_SEARCH_COMPLETE) {
      const found = await waitVisible(result, budget(RESULT_READY_TIMEOUT_MS, "the final result wait"));
      return { outcome: found ? "VISIBLE" : "SETTLED_ABSENT", lastStatus };
    }
    missingReads = lastStatus === null ? missingReads + 1 : 0;
    if (missingReads >= SEARCH_STATUS_MISSING_LIMIT) break;
    await page.waitForTimeout(SEARCH_STATUS_POLL_MS);
  }
  return { outcome: (await result.isVisible()) ? "VISIBLE" : "UNSETTLED", lastStatus };
}

async function safeVisible(
  page: Page,
  role: "button" | "dialog",
  name: string | RegExp,
  timeout: number,
): Promise<boolean> {
  return await waitVisible(page.getByRole(role, { name }), timeout);
}

async function runUiBackendMismatchAttack(
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const budget = missionBudget(context.mission.timeoutMs);
  const runtime = await openMissionBrowser(context);
  let cleanupStarted = false;

  try {
    const orgId = await resolveOrgRoute(runtime.page);
    if (!orgId) {
      throw new Error("Authenticated browser did not resolve an organization route.");
    }

    await runtime.page.goto("/" + orgId + "/customers", {
      waitUntil: "domcontentloaded",
      timeout: budget(30_000, "the customers page loaded"),
    });

    const suffix = Date.now().toString(36) + "-" + safeLeaf(context.worker.workerId);
    const firstName = "Swarm";
    const lastName = "Authority-" + suffix;
    const email = "swarm-" + suffix + "@example.test";

    const addVisible = await safeVisible(
      runtime.page,
      "button",
      "Add Customer",
      budget(CONTROL_READY_TIMEOUT_MS, "the Add Customer control appeared"),
    );
    if (!addVisible) {
      throw new Error(
        "UI/backend authority harness could not locate the Add Customer control within " +
          CONTROL_READY_TIMEOUT_MS +
          "ms at " +
          new URL(runtime.page.url()).pathname +
          ".",
      );
    }

    await runtime.page
      .getByRole("button", { name: "Add Customer", exact: true })
      .click();

    const dialogVisible = await safeVisible(
      runtime.page,
      "dialog",
      /Add Customer/,
      budget(DIALOG_READY_TIMEOUT_MS, "the Add Customer dialog opened"),
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

    // The UI's own success signal comes first: the success toast AND the closed dialog (both
    // come only after the create and custom-field mutations resolved). Awaited together so
    // the toast's auto-dismiss cannot race the dialog wait.
    const saveSignalTimeout = budget(DIALOG_CLOSE_TIMEOUT_MS, "the Add Customer save completed");
    const [dialogClosed, successToastSeen] = await Promise.all([
      waitHidden(dialog, saveSignalTimeout),
      waitVisible(runtime.page.getByText(CUSTOMER_ADDED_TOAST).first(), saveSignalTimeout),
    ]);
    if (!dialogClosed) {
      throw new Error(
        "UI/backend authority harness: the Add Customer dialog stayed open after submit (a validation or save failure), so the save outcome is unknown.",
      );
    }
    if (!successToastSeen) {
      throw new Error(
        "UI/backend authority harness: the Add Customer dialog closed without the success toast, so the save outcome is unknown.",
      );
    }

    const client = await authenticatedConvexClient(runtime.page);
    let backendReads = 0;
    const queryExactBackendMatches = async () => {
      backendReads += 1;
      const backendMatches = await boundedBackendQuery(
        () =>
          client.query(api.customers.search, {
            orgId: orgId as Id<"organizations">,
            search: email,
          }),
        budget(BACKEND_READ_TIMEOUT_MS, "the backend customer query"),
      );
      if (!Array.isArray(backendMatches)) {
        throw new TypeError(
          "UI/backend authority harness received a non-array customer authority response.",
        );
      }
      return backendMatches.filter(
        (customer: { email?: string; firstName?: string; lastName?: string }) =>
          customer.email === email &&
          customer.firstName === firstName &&
          customer.lastName === lastName,
      );
    };
    // The UI reported success (toast and closed dialog). A count of 0 stays 0 through the
    // bounded re-reads only on a real UI/backend mismatch. One or more stops the wait; more
    // than 1 is a breach.
    const backendReadStartedAt = Date.now();
    let exactBackendMatches = await queryExactBackendMatches();
    const commitDeadline = backendReadStartedAt + BACKEND_COMMIT_DEADLINE_MS;
    for (
      let poll = 0;
      exactBackendMatches.length === 0 && poll < BACKEND_COMMIT_MAX_POLLS && Date.now() < commitDeadline;
      poll += 1
    ) {
      await runtime.page.waitForTimeout(BACKEND_COMMIT_POLL_MS);
      exactBackendMatches = await queryExactBackendMatches();
    }
    const backendReadElapsedMs = Date.now() - backendReadStartedAt;
    const initialBackendMatchCount = exactBackendMatches.length;

    await runtime.page.reload({
      waitUntil: "domcontentloaded",
      timeout: budget(30_000, "the customers page reloaded"),
    });
    const searchInput = runtime.page
      .locator('main input[placeholder^="Search"]:not([readonly])')
      .first();
    const searchVisible = await waitVisible(
      searchInput,
      budget(RELOAD_READY_TIMEOUT_MS, "the customer search control appeared"),
    );
    if (!searchVisible) {
      throw new Error(
        "UI/backend authority harness could not locate the customer search control after reload.",
      );
    }
    await searchInput.fill(email);

    // The page renders each customer twice (mobile cards, desktop table) and hides one by
    // viewport, so the first DOM match can be the hidden copy: match a VISIBLE one.
    const resultLocator = runtime.page
      .getByText(lastName, { exact: false })
      .filter({ visible: true })
      .first();
    let visibleAfterReload = await waitVisible(
      resultLocator,
      budget(RESULT_READY_TIMEOUT_MS, "the customer result appeared"),
    );
    let resultSettle: ResultSettleOutcome | "NOT_NEEDED" = "NOT_NEEDED";
    // Only a backend count of exactly 1 makes a missing UI row a candidate breach; any
    // other count already fails the oracle, so there is nothing for the UI to settle.
    if (!visibleAfterReload && initialBackendMatchCount === 1) {
      const settled = await settleCustomerResult(runtime.page, resultLocator, budget);
      resultSettle = settled.outcome;
      if (settled.outcome === "UNSETTLED") {
        throw new Error(
          "UI/backend authority harness could not tell whether the customer result was absent or still loading: the customers search did not complete (last status " +
            String(settled.lastStatus) +
            ", needed " +
            CUSTOMERS_SEARCH_COMPLETE +
            ") after the search.",
        );
      }
      visibleAfterReload = settled.outcome === "VISIBLE";
    }

    // Re-read the count right before the verdict: a second insert that landed while the UI
    // was settling would otherwise be missed by the single early read.
    const finalBackendMatchCount =
      initialBackendMatchCount === 1
        ? (await queryExactBackendMatches()).length
        : initialBackendMatchCount;

    const passed =
      initialBackendMatchCount === 1 &&
      finalBackendMatchCount === 1 &&
      visibleAfterReload;

    const backendArtifact = await writeBackendEvidence(runtime.paths, {
      attack: "UI_BACKEND_MISMATCH",
      orgId,
      addVisible,
      dialogVisible,
      formFilled: true,
      submitted: true,
      uiSaveSucceeded: dialogClosed && successToastSeen,
      exactBackendMatchCount: initialBackendMatchCount,
      finalBackendMatchCount,
      backendReads,
      backendReadElapsedMs,
      visibleAfterReload,
      resultSettle,
      syntheticIdentity: { firstName, lastName, email },
    });
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
          ? "The customer created through the UI existed exactly once in backend authority and remained visible after reload."
          : "UI mutation state disagreed with backend authority or disappeared after reload.",
      },
      artifacts,
    };
  } catch (error) {
    return rethrowAfterMissionCleanup(runtime, error, cleanupStarted);
  }
}

export const missionBrowserRuntime = {
  open: openMissionBrowser,
  finish: finishMissionBrowser,
  rethrowAfterCleanup: rethrowAfterMissionCleanup,
  writeBackendEvidence,
  resolveOrgRoute,
  authenticatedClient: authenticatedConvexClient,
};

export function createInitialBrowserAttackHandlers(): BrowserAttackHandlerRegistry {
  return {
    RTL_PARITY: runRtlParityAttack,
    UI_BACKEND_MISMATCH: runUiBackendMismatchAttack,
    // SCRUM-826: the economic attacks reuse this module's egress-contained
    // browser lifecycle and evidence writer; they never launch their own.
    ...createEconomicAttackHandlers(missionBrowserRuntime),
    // SCRUM-350: boundary attacks (tenant, authorization, completeness,
    // reversal) and network recovery, on the same contained lifecycle.
    ...createBoundaryAttackHandlers(missionBrowserRuntime),
    NETWORK_RECOVERY: createNetworkRecoveryHandler(missionBrowserRuntime),
    // SCRUM-350 CONS-1: a financed consigned sale, judged against independent figures.
    ...createConsignmentAttackHandlers(missionBrowserRuntime),
    // SCRUM-350 ACC-1: a financed sale of owned stock, judged account by account against independent figures.
    ...createMoneyBoundaryAttackHandlers(missionBrowserRuntime),
    // SCRUM-350 LIFE-1: a stale screen's action, judged against backend authority.
    ...createStaleUiAttackHandlers(missionBrowserRuntime),
    // SCRUM-350 LIFE-1: a lifecycle transition interrupted by history back/forward, judged against the ledger.
    ...createNavigationRaceAttackHandlers(missionBrowserRuntime),
    // SCRUM-849 ACC-3: a manual journal's declared accounting date and the closed-period boundary, judged on backend state.
    ...createAccountingDateAttackHandlers(missionBrowserRuntime),
  };
}
