import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
  type BrowserAttackMission,
  type BrowserSwarmRunManifest,
  type BrowserSwarmWorkerPlan,
} from "./browserAttackSwarm";
import { customersAr, customersEn } from "../../lib/i18n/domains/customers";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";

const mocks = vi.hoisted(() => ({
  chromiumLaunch: vi.fn(),
  authenticatedConvexClient: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("@playwright/test", () => ({
  chromium: { launch: mocks.chromiumLaunch },
}));

vi.mock("../../playwright/utils", () => ({
  USER_AUTH_FILE: "playwright/.auth/user.json",
  APPROVER_AUTH_FILE: "playwright/.auth/approver.json",
  authenticatedConvexClient: mocks.authenticatedConvexClient,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    default: {
      ...actual,
      mkdir: mocks.mkdir,
      writeFile: mocks.writeFile,
    },
  };
});

import { createInitialBrowserAttackHandlers, missionBrowserRuntime } from "./browserAttackSwarmHandlers";

type Scenario = {
  orgId: string;
  languageButtonVisible: boolean;
  initialLanguageButton: "en" | "ar";
  addCustomerVisible: boolean;
  // The Add Customer control only renders this long after /customers loads
  // (the app shows "Loading your workspace..." until then). Absent = instant.
  addCustomerVisibleAfterMs?: number;
  dialogVisible: boolean;
  // After page.reload() the search control only renders this long later.
  // Absent = instant.
  reloadVisibleAfterMs?: number;
  // After the search is typed, the customer result only renders this long
  // later. Absent = instant.
  resultVisibleAfterMs?: number;
  // The customer result renders only after this many settle polls
  // (page.waitForTimeout calls), i.e. after the first bounded wait gave up.
  resultVisibleAfterPolls?: number;
  // The results wrapper reports data-customers-status "CanLoadMore" (no busy marker, the
  // count line reads "0 loaded results") until this many settle polls, then "Exhausted".
  // "never" = the search never completes.
  exhaustedAfterPolls?: number | "never";
  // The first DOM text match is the hidden mobile card; only filter({ visible: true }) finds the
  // visible desktop row.
  hiddenMobileMatchFirst?: boolean;
  // How reading the status attribute behaves: resolves null (marker missing), rejects with a
  // Playwright TimeoutError, or rejects with this other error. Absent = the scripted status.
  statusRead?: "null" | "timeout" | Error;
  // The backend search returns no row for this many queries (the save has not committed yet).
  backendCommitAfterQueries?: number;
  // Exact-match count per backend search (the last entry repeats), e.g. [1, 2] = a second insert lands later.
  backendMatchesSequence?: number[];
  // The backend search never answers.
  backendQueryHangs?: boolean;
  // The dialog never closes after submit (validation or a failed save).
  dialogStaysOpen?: boolean;
  // The dialog closes but no success toast ever shows (it was removed without a save).
  noSuccessToast?: boolean;
  /** The toast auto-dismisses this long after submit (default: stays). */
  toastVisibleForMs?: number;
  // The dialog closes this many ms after submit. Absent = at once.
  dialogClosedAfterMs?: number;
  // The result row appears only DURING the final wait that follows an observed Exhausted status.
  resultOnlyDuringFinalWait?: boolean;
  searchControlVisible: boolean;
  resultVisibleAfterReload: boolean;
  backendOwnsOrg: boolean;
  backendCustomerMatches: number;
  backendQueryError?: Error;
  // When set, page.goto("/dashboard") lands on `landingUrl` (the app's entry
  // point, before its redirect) and, if `settledUrl` is non-null, the app then
  // redirects to it a moment later; the page's waitForURL honors RegExp and
  // predicate matchers like the real one. Absent = the legacy instant redirect
  // with a no-op waitForURL.
  routing?: { landingUrl: string; settledUrl: string | null };
};

function defaultScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    orgId: "org_preview_1",
    languageButtonVisible: true,
    initialLanguageButton: "en",
    addCustomerVisible: true,
    dialogVisible: true,
    searchControlVisible: true,
    resultVisibleAfterReload: true,
    backendOwnsOrg: true,
    backendCustomerMatches: 1,
    ...overrides,
  };
}

// A tracing fake with the state machine of the real Playwright server
// (playwright-core coreBundle Tracing.start/startChunk/stop), unlike the
// always-succeeding vi.fn() pair below. SCRUM-826 / SCRUM-824 G4: the
// Playwright TEST RUNNER starts tracing itself on every context created while
// a test runs (trace: "retain-on-failure"), so a handler's own tracing.start()
// threw "Tracing has been already started" and both attack workers died with
// HARNESS_ERROR. Mock-only tracing could never see that.
function makeStatefulTracing() {
  const machine = { started: false, recording: false };
  const writtenPaths: string[] = [];
  const startOptions: unknown[] = [];
  return {
    machine,
    writtenPaths,
    startOptions,
    start: vi.fn(async (options?: unknown) => {
      if (machine.started) {
        throw new Error("tracing.start: Tracing has been already started");
      }
      startOptions.push(options);
      machine.started = true;
      machine.recording = true;
    }),
    startChunk: vi.fn(async () => {
      // Server behavior: a running chunk is discarded, then a new one begins.
      if (!machine.started) {
        throw new Error(
          "tracing.startChunk: Must start tracing before starting a new chunk",
        );
      }
      machine.recording = true;
    }),
    stop: vi.fn(async (options?: { path?: string }) => {
      if (!machine.started) {
        throw new Error("tracing.stop: Must start tracing before stopping");
      }
      if (options?.path && machine.recording) writtenPaths.push(options.path);
      machine.started = false;
      machine.recording = false;
    }),
  };
}

type TracingMode = "mock" | "stateful" | "runner-started";

function makeBrowserFixture(
  scenario: Scenario,
  tracingMode: TracingMode = "mock",
) {
  const state = {
    currentUrl: "http://127.0.0.1:3000/" + scenario.orgId + "/dashboard",
    lang: scenario.initialLanguageButton === "ar" ? "ar" : "en",
    dir: scenario.initialLanguageButton === "ar" ? "rtl" : "ltr",
    dialogOpened: false,
    dialogClosed: false,
    submitted: false,
    submittedAt: 0,
    toastWaitStartedAfterClose: null as boolean | null,
    firstName: "",
    lastName: "",
    email: "",
    search: "",
    closed: false,
  };

  const languageToggle = {
    isVisible: vi.fn(async () => scenario.languageButtonVisible),
    textContent: vi.fn(async () => scenario.initialLanguageButton),
    click: vi.fn(async () => {
      state.lang = "ar";
      state.dir = "rtl";
    }),
  };

  // Real Playwright: isVisible() answers for this instant and ignores any
  // timeout; waitFor() is what waits, and rejects with a TimeoutError.
  let controlRevealed = scenario.addCustomerVisibleAfterMs === undefined;
  let reloadRevealed = true;
  let resultRevealed = true;
  let settlePolls = 0;
  const statusGetAttribute = vi.fn(async (name: string) => {
    const read = scenario.statusRead;
    if (read instanceof Error) throw read;
    if (read === "timeout") {
      const error = new Error("locator.getAttribute: Timeout 1000ms exceeded.");
      error.name = "TimeoutError";
      throw error;
    }
    if (read === "null") return null;
    const status = name === "data-customers-status" ? customersStatus() : null;
    if (status === "Exhausted" && exhaustedObservedAt === null) exhaustedObservedAt = Date.now();
    return status;
  });
  // When the handler first read Exhausted: the row of resultOnlyDuringFinalWait renders after it.
  let exhaustedObservedAt: number | null = null;
  let searchQueries = 0;
  const customersStatus = () => {
    if (scenario.exhaustedAfterPolls === "never") return "CanLoadMore";
    return settlePolls >= (scenario.exhaustedAfterPolls ?? 0) ? "Exhausted" : "CanLoadMore";
  };
  // A finite stand-in for the real timeout: 20 polls x 5ms = 100ms.
  const waitUntilVisible = async (visible: () => boolean) => {
    for (let poll = 0; poll < 20; poll += 1) {
      if (visible()) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const error = new Error("locator.waitFor: Timeout exceeded.");
    error.name = "TimeoutError";
    throw error;
  };

  const addCustomerButton = {
    isVisible: vi.fn(async () => scenario.addCustomerVisible && controlRevealed),
    waitFor: vi.fn(async () =>
      waitUntilVisible(() => scenario.addCustomerVisible && controlRevealed),
    ),
    click: vi.fn(async () => {
      state.dialogOpened = true;
    }),
  };

  const field = (name: "firstName" | "lastName" | "email") => ({
    fill: vi.fn(async (value: string) => {
      state[name] = value;
    }),
  });

  const dialog = {
    isVisible: vi.fn(
      async () => state.dialogOpened && !state.dialogClosed && scenario.dialogVisible,
    ),
    // Like Playwright: state "hidden" waits for the dialog to close, anything else for it to show.
    waitFor: vi.fn(async (options?: { state?: string }) =>
      options?.state === "hidden"
        ? waitUntilVisible(() => state.submitted && state.dialogClosed)
        : waitUntilVisible(() => state.dialogOpened && scenario.dialogVisible),
    ),
    getByLabel: vi.fn((label: string) => {
      if (label === "First Name") return field("firstName");
      if (label === "Last Name") return field("lastName");
      if (label === "Email") return field("email");
      throw new Error("Unexpected dialog label " + label);
    }),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => {
        state.submitted = true;
        state.submittedAt = Date.now();
        // CustomerDialog closes only after the create mutation resolved; a failed save leaves it open.
        if (scenario.dialogStaysOpen) return;
        const delay = scenario.dialogClosedAfterMs ?? 0;
        if (delay === 0) state.dialogClosed = true;
        else setTimeout(() => { state.dialogClosed = true; }, delay);
      }),
    })),
  };

  const searchInput = {
    isVisible: vi.fn(async () => reloadRevealed && scenario.searchControlVisible),
    waitFor: vi.fn(async () =>
      waitUntilVisible(() => reloadRevealed && scenario.searchControlVisible),
    ),
    fill: vi.fn(async (value: string) => {
      state.search = value;
      const delay = scenario.resultVisibleAfterMs;
      if (delay !== undefined) {
        resultRevealed = false;
        setTimeout(() => {
          resultRevealed = true;
        }, delay);
      }
    }),
  };

  // Redirects still to come after goto("/dashboard") resolved (routing mode).
  let pendingRedirects = 0;

  const urlMatches = (
    matcher: string | RegExp | ((url: URL) => boolean),
    current: string,
  ): boolean => {
    // Same contract as playwright-core: a string must equal the full URL, a
    // RegExp is tested against the full URL string, a predicate gets a URL.
    if (typeof matcher === "function") return matcher(new URL(current));
    if (matcher instanceof RegExp) return matcher.test(current);
    return matcher === current;
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      if (url === "/dashboard" && scenario.routing) {
        state.currentUrl = scenario.routing.landingUrl;
        const settledUrl = scenario.routing.settledUrl;
        if (settledUrl !== null) {
          pendingRedirects += 1;
          setTimeout(() => {
            state.currentUrl = settledUrl;
            pendingRedirects -= 1;
          }, 15);
        }
      } else if (url === "/dashboard") {
        state.currentUrl =
          "http://127.0.0.1:3000/" + scenario.orgId + "/dashboard";
      } else {
        state.currentUrl = "http://127.0.0.1:3000" + url;
        const delay = scenario.addCustomerVisibleAfterMs;
        if (url.endsWith("/customers") && delay !== undefined) {
          controlRevealed = false;
          setTimeout(() => {
            controlRevealed = true;
          }, delay);
        }
      }
    }),
    waitForURL: vi.fn(
      async (matcher: string | RegExp | ((url: URL) => boolean)) => {
        if (!scenario.routing) return undefined;
        // Resolve as soon as the current URL (now or after a later redirect)
        // matches. With no redirect left to wait for and no match, the real
        // 20s timeout is what would fire; model it as an immediate rejection.
        // The loop is bounded well below Vitest's per-test timeout instead:
        // 200 polls x 5ms = 1s, still far longer than any modeled redirect.
        for (let poll = 0; poll < 200; poll += 1) {
          if (urlMatches(matcher, state.currentUrl)) return undefined;
          if (pendingRedirects === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("page.waitForURL: Timeout 20000ms exceeded.");
      },
    ),
    url: vi.fn(() => state.currentUrl),
    getByRole: vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "dialog") return dialog;
      if (
        role === "button" &&
        options?.name instanceof RegExp
      ) {
        return languageToggle;
      }
      if (role === "button" && options?.name === "Add Customer") {
        return addCustomerButton;
      }
      throw new Error(
        "Unexpected role lookup " + role + " " + String(options?.name),
      );
    }),
    waitForTimeout: vi.fn(async () => {
      settlePolls += 1;
    }),
    locator: vi.fn((selector: string) => {
      if (selector === '[data-testid="customers-results"]') {
        return { getAttribute: statusGetAttribute };
      }
      if (selector === "html") {
        return {
          getAttribute: vi.fn(async (name: string) => {
            if (name === "lang") return state.lang;
            if (name === "dir") return state.dir;
            return null;
          }),
        };
      }
      return {
        first: vi.fn(() => searchInput),
      };
    }),
    reload: vi.fn(async () => {
      const delay = scenario.reloadVisibleAfterMs;
      if (delay !== undefined) {
        reloadRevealed = false;
        setTimeout(() => {
          reloadRevealed = true;
        }, delay);
      }
    }),
    getByText: vi.fn((text: string | RegExp) => {
      // The success toast ("Customer added successfully" / Arabic): shown with the closing dialog.
      if (text instanceof RegExp) {
        // Like sonner, it auto-dismisses: visible from submit until toastVisibleForMs later.
        const toastShown = () =>
          state.submitted &&
          !scenario.noSuccessToast &&
          (scenario.toastVisibleForMs === undefined ||
            Date.now() - state.submittedAt < scenario.toastVisibleForMs);
        const toast = {
          isVisible: vi.fn(async () => toastShown()),
          waitFor: vi.fn(async () => {
            // Records whether the toast wait began only after the dialog had already closed.
            state.toastWaitStartedAfterClose ??= state.dialogClosed;
            return waitUntilVisible(toastShown);
          }),
        };
        return { first: vi.fn(() => toast) };
      }
      const resultVisible = () =>
        resultRevealed &&
        settlePolls >= (scenario.resultVisibleAfterPolls ?? 0) &&
        (!scenario.resultOnlyDuringFinalWait ||
          (exhaustedObservedAt !== null && Date.now() - exhaustedObservedAt >= 25)) &&
        scenario.resultVisibleAfterReload &&
        state.submitted &&
        state.search === state.email;
      const visibleRow = {
        isVisible: vi.fn(async () => resultVisible()),
        waitFor: vi.fn(async () => waitUntilVisible(resultVisible)),
      };
      const hiddenMobileCard = {
        isVisible: vi.fn(async () => false),
        waitFor: vi.fn(async () => waitUntilVisible(() => false)),
      };
      return {
        first: vi.fn(() => (scenario.hiddenMobileMatchFirst ? hiddenMobileCard : visibleRow)),
        // Real semantics: filter({ visible: true }) keeps the visible text matches themselves.
        filter: vi.fn((options: { visible?: boolean }) => {
          if (options.visible !== true) throw new Error("Unexpected text filter " + JSON.stringify(options));
          return { first: vi.fn(() => visibleRow) };
        }),
        // Real semantics: locator() searches DESCENDANTS of each text match. The matched span
        // or button holds the name directly and has none, so this never finds the row.
        locator: vi.fn(() => ({ first: vi.fn(() => hiddenMobileCard) })),
      };
    }),
    isClosed: vi.fn(() => state.closed),
    screenshot: vi.fn(async () => undefined),
  };

  const tracing =
    tracingMode === "mock"
      ? {
          start: vi.fn(async () => undefined),
          startChunk: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        }
      : makeStatefulTracing();
  const browserContext = {
    tracing,
    newPage: vi.fn(async () => page),
  };
  const browser = {
    newContext: vi.fn(async () => {
      if (tracingMode === "runner-started") {
        // What the Playwright test runner does inside browser.newContext():
        // it starts tracing (with its own options) before handing the
        // context back to the spec.
        await tracing.start({ screenshots: true, snapshots: true });
      }
      return browserContext;
    }),
    close: vi.fn(async () => {
      state.closed = true;
    }),
  };

  mocks.chromiumLaunch.mockResolvedValue(browser);
  mocks.authenticatedConvexClient.mockResolvedValue({
    query: vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if (scenario.backendQueryError) throw scenario.backendQueryError;

      if ("search" in args) {
        searchQueries += 1;
        if (scenario.backendQueryHangs) return new Promise<never>(() => undefined);
        if (searchQueries <= (scenario.backendCommitAfterQueries ?? 0)) return [];
        const sequence = scenario.backendMatchesSequence;
        const count = sequence
          ? (sequence[searchQueries - 1] ?? sequence[sequence.length - 1])
          : scenario.backendCustomerMatches;
        return Array.from(
          { length: count },
          () => ({
            email: state.email,
            firstName: state.firstName,
            lastName: state.lastName,
          }),
        );
      }

      return scenario.backendOwnsOrg
        ? [{ _id: scenario.orgId }]
        : [{ _id: "org_somewhere_else" }];
    }),
  });

  return {
    state,
    page,
    browser,
    browserContext,
    tracing,
    addCustomerButton,
    searchInput,
    statusGetAttribute,
    searchQueryCount: () => searchQueries,
  };
}

// The backend-state JSON the UI/backend attack wrote, from the faked writeFile.
function backendEvidenceBody(): string | undefined {
  return (mocks.writeFile.mock.calls as unknown[][])
    .map((call) => String(call[1]))
    .find((body) => body.includes("UI_BACKEND_MISMATCH"));
}

interface FakeRow {
  isVisible: () => Promise<boolean>;
  waitFor: (...args: unknown[]) => Promise<unknown>;
}
interface FakeTextLookup {
  first: () => FakeRow;
  filter: (options: { visible: boolean }) => { first: () => FakeRow };
  locator: (selector: string) => { first: () => FakeRow };
}

// Replaces only the customer-name text lookup; the success-toast lookup (a RegExp) keeps the fixture's fake.
function overrideResultLookup(
  fixture: ReturnType<typeof makeBrowserFixture>,
  make: (original: FakeTextLookup) => FakeTextLookup,
): void {
  const getByText = fixture.page.getByText as unknown as {
    getMockImplementation: () => (text: string | RegExp) => unknown;
    mockImplementation: (implementation: (text: string | RegExp) => unknown) => void;
  };
  const original = getByText.getMockImplementation();
  getByText.mockImplementation((text) =>
    text instanceof RegExp ? original(text) : make(original(text) as FakeTextLookup),
  );
}

function mission(
  family: BrowserAttackMission["family"],
): BrowserAttackMission {
  return {
    id: "det::UI-1::" + family,
    family,
    source: "DETERMINISTIC",
    invariantIds: ["UI-1"],
    invariantSeverity: "HIGH",
    oracle: "UI_BACKEND_AUTHORITY",
    timeoutMs: 45_000,
    estimatedCostUnits: 4,
    evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  };
}

function executionContext(
  family: BrowserAttackMission["family"],
  signal = new AbortController().signal,
): BrowserMissionExecutionContext {
  const attack = mission(family);
  const worker: BrowserSwarmWorkerPlan = {
    workerId: "worker-1",
    artifactRoot: "swarm/run-1/worker-1",
    missions: [attack],
  };
  const manifest: BrowserSwarmRunManifest = {
    version: 1,
    runId: "run-1",
    previewName: "e2e-pr-350-test",
    expectedCloudUrl: "https://example-preview.convex.cloud",
    requiresPreviewMarker: true,
    workers: [worker],
  };

  return {
    manifest,
    worker,
    mission: attack,
    signal,
  };
}

function handlerFor(family: BrowserAttackMission["family"]) {
  const handler = createInitialBrowserAttackHandlers()[family];
  if (!handler) throw new Error("Expected handler for " + family);
  return handler;
}

describe("SCRUM-350 initial browser attack handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chromiumLaunch.mockReset();
    mocks.authenticatedConvexClient.mockReset();
    mocks.mkdir.mockReset().mockResolvedValue(undefined);
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    process.env.PLAYWRIGHT_BASE_URL = "http://127.0.0.1:3000";
    process.env.BROWSER_EGRESS_PROXY_SERVER = "http://127.0.0.1:3129";
  });

  afterEach(() => {
    delete process.env.BROWSER_EGRESS_PROXY_SERVER;
  });

  it("launches Chromium only through the trusted egress proxy and blocks service workers (SCRUM-784)", async () => {
    const fixture = makeBrowserFixture(defaultScenario());

    await handlerFor("RTL_PARITY")(executionContext("RTL_PARITY"));

    const launchOptions = mocks.chromiumLaunch.mock.calls[0]?.[0];
    expect(launchOptions.proxy).toEqual({ server: "http://127.0.0.1:3129" });
    expect(launchOptions.args).toContain(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
    expect(fixture.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        storageState: expect.any(String),
      }),
    );
  });

  it("opens the primary seat as the OWNER and the approver seat as the MANAGER, each with its own artifacts (SCRUM-350)", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    const context = executionContext("TENANT_ESCAPE");

    const primary = await missionBrowserRuntime.open(context);
    const approver = await missionBrowserRuntime.open(context, "approver");

    const states = (
      fixture.browser.newContext.mock.calls as unknown as [{ storageState: string }][]
    ).map(([options]) => options.storageState);
    expect(states).toEqual(["playwright/.auth/user.json", "playwright/.auth/approver.json"]);
    expect(primary.paths.root).not.toBe(approver.paths.root);
    expect(approver.paths.root.startsWith(primary.paths.root + "/")).toBe(true);
    expect(approver.paths.trace).not.toBe(primary.paths.trace);
    // Every seat still goes through the egress proxy.
    for (const [options] of mocks.chromiumLaunch.mock.calls) {
      expect(options.proxy).toEqual({ server: "http://127.0.0.1:3129" });
    }
  });

  it("refuses to launch a browser with saved QA state when the egress proxy is missing (SCRUM-784)", async () => {
    delete process.env.BROWSER_EGRESS_PROXY_SERVER;
    makeBrowserFixture(defaultScenario());

    await expect(
      handlerFor("RTL_PARITY")(executionContext("RTL_PARITY")),
    ).rejects.toThrow(/open egress/);

    expect(mocks.chromiumLaunch).not.toHaveBeenCalled();
  });

  it("keeps the executable Phase A family set identical to the handler registry", () => {
    expect(Object.keys(createInitialBrowserAttackHandlers()).sort()).toEqual(
      [...PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES].sort(),
    );
  });

  it("refuses an already-aborted mission before launching Chromium", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY", controller.signal),
      ),
    ).rejects.toThrow(/mission timed out/);

    expect(mocks.chromiumLaunch).not.toHaveBeenCalled();
  });

  it("closes Chromium when timeout fires while launch is still resolving", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    const controller = new AbortController();
    let releaseLaunch!: () => void;
    let markLaunchStarted!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launchStarted = new Promise<void>((resolve) => {
      markLaunchStarted = resolve;
    });

    mocks.chromiumLaunch.mockImplementationOnce(async () => {
      markLaunchStarted();
      await launchGate;
      return fixture.browser;
    });

    const pending = handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY", controller.signal),
    );

    await launchStarted;
    controller.abort(new Error("mission timed out during launch"));
    releaseLaunch();

    await expect(pending).rejects.toThrow(/mission timed out during launch/);
    expect(fixture.browser.close).toHaveBeenCalled();
    expect(fixture.browser.newContext).not.toHaveBeenCalled();
  });

  it("closes Chromium when browser-context setup fails", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.browser.newContext.mockRejectedValueOnce(
      new Error("context setup failed"),
    );

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      ),
    ).rejects.toThrow(/context setup failed/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("propagates route-wait failures instead of treating them as missing org state", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.waitForURL.mockRejectedValueOnce(new Error("route timeout"));

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      ),
    ).rejects.toThrow(/route timeout/);

    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("attempts all evidence cleanup once and rejects when screenshot capture fails", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.screenshot.mockRejectedValueOnce(
      new Error("screenshot capture failed"),
    );

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      ),
    ).rejects.toThrow(/evidence cleanup did not complete/);

    expect(fixture.page.screenshot).toHaveBeenCalledTimes(1);
    expect(fixture.tracing.stop).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("preserves the primary mission error and attaches cleanup failure as its cause", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.waitForURL.mockRejectedValueOnce(
      new Error("primary route failure"),
    );
    fixture.page.screenshot.mockRejectedValueOnce(
      new Error("cleanup screenshot failure"),
    );

    let caught: unknown;
    try {
      await handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const primary = caught as Error;
    expect(primary.message).toMatch(/primary route failure/);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect(fixture.tracing.stop).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("proves RTL parity against backend organization authority", async () => {
    const fixture = makeBrowserFixture(defaultScenario());

    const evidence = await handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY"),
    );

    expect(evidence.oracle).toMatchObject({
      kind: "UI_BACKEND_AUTHORITY",
      passed: true,
    });
    expect(fixture.state.lang).toBe("ar");
    expect(fixture.state.dir).toBe("rtl");
    expect(evidence.artifacts).toHaveLength(3);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  describe("tracing under the Playwright test runner (SCRUM-826, SCRUM-824 G4)", () => {
    function statefulTracing(
      fixture: ReturnType<typeof makeBrowserFixture>,
    ): ReturnType<typeof makeStatefulTracing> {
      return fixture.tracing as ReturnType<typeof makeStatefulTracing>;
    }

    it("control: starts tracing itself and writes the trace when the runner has not started it", async () => {
      const fixture = makeBrowserFixture(defaultScenario(), "stateful");
      const tracing = statefulTracing(fixture);

      const evidence = await handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      );

      expect(evidence.oracle.passed).toBe(true);
      expect(tracing.start).toHaveBeenCalledTimes(1);
      expect(tracing.startOptions).toEqual([
        { screenshots: true, snapshots: true, sources: false },
      ]);
      expect(tracing.startChunk).not.toHaveBeenCalled();
      expect(tracing.writtenPaths).toHaveLength(1);
      expect(tracing.writtenPaths[0]).toMatch(/trace\.zip$/);
      expect(evidence.artifacts.some((a) => a.endsWith("/trace.zip"))).toBe(
        true,
      );
      expect(tracing.machine.started).toBe(false);
    });

    it("tolerates tracing the runner already started and still writes the trace artifact", async () => {
      const fixture = makeBrowserFixture(defaultScenario(), "runner-started");
      const tracing = statefulTracing(fixture);

      const evidence = await handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      );

      expect(evidence.oracle.passed).toBe(true);
      // The handler adopts the running trace with its own chunk instead of
      // starting a second trace.
      expect(tracing.startChunk).toHaveBeenCalledTimes(1);
      expect(tracing.writtenPaths).toHaveLength(1);
      expect(tracing.writtenPaths[0]).toMatch(/trace\.zip$/);
      expect(evidence.artifacts.some((a) => a.endsWith("/trace.zip"))).toBe(
        true,
      );
      expect(tracing.machine.started).toBe(false);
      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    });

    it("does not swallow other tracing.start failures and still closes the browser", async () => {
      const fixture = makeBrowserFixture(defaultScenario(), "stateful");
      const tracing = statefulTracing(fixture);
      tracing.start.mockRejectedValueOnce(
        new Error("tracing.start: Target page, context or browser has been closed"),
      );

      await expect(
        handlerFor("RTL_PARITY")(executionContext("RTL_PARITY")),
      ).rejects.toThrow(/has been closed/);

      expect(tracing.startChunk).not.toHaveBeenCalled();
      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    });

    it("surfaces a startChunk failure instead of masking it when adopting a runner trace", async () => {
      const fixture = makeBrowserFixture(defaultScenario(), "runner-started");
      const tracing = statefulTracing(fixture);
      tracing.startChunk.mockRejectedValueOnce(
        new Error("tracing.startChunk: Cannot start a trace chunk while stopping"),
      );

      await expect(
        handlerFor("RTL_PARITY")(executionContext("RTL_PARITY")),
      ).rejects.toThrow(/Cannot start a trace chunk/);

      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts a page that is already in Arabic without clicking the language toggle", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ initialLanguageButton: "ar" }),
    );

    const evidence = await handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY"),
    );

    expect(evidence.oracle.passed).toBe(true);
    const toggle = fixture.page.getByRole.mock.results.find(
      (result) => result.value?.textContent,
    )?.value;
    expect(toggle.click).not.toHaveBeenCalled();
  });

  it("propagates a DOM oracle read failure as a harness error", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.locator.mockImplementationOnce(() => ({
      getAttribute: vi.fn(async () => {
        throw new Error("dom unavailable");
      }),
    }));

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      ),
    ).rejects.toThrow(/dom unavailable/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("reports an RTL oracle failure when the authenticated organization is not backend-owned", async () => {
    makeBrowserFixture(defaultScenario({ backendOwnsOrg: false }));

    const evidence = await handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY"),
    );

    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/diverged/);
  });

  it("treats a missing language control as a harness failure, not a product breach", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ languageButtonVisible: false }),
    );

    await expect(
      handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      ),
    ).rejects.toThrow(/could not locate the EN\/AR language control/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("proves a UI customer mutation against backend authority and reload persistence", async () => {
    const fixture = makeBrowserFixture(defaultScenario());

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle).toMatchObject({
      kind: "UI_BACKEND_AUTHORITY",
      passed: true,
    });
    expect(fixture.state.submitted).toBe(true);
    expect(fixture.state.email).toMatch(/^swarm-.*@example\.test$/);
    expect(fixture.state.search).toBe(fixture.state.email);
    expect(evidence.artifacts).toHaveLength(3);
  });

  it("attempts UI/backend evidence cleanup only once when screenshot capture fails", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.screenshot.mockRejectedValueOnce(
      new Error("ui screenshot capture failed"),
    );

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/evidence cleanup did not complete/);

    expect(fixture.page.screenshot).toHaveBeenCalledTimes(1);
    expect(fixture.tracing.stop).toHaveBeenCalledTimes(1);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("propagates an Add Customer click failure as a harness error", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.addCustomerButton.click.mockRejectedValueOnce(
      new Error("button detached"),
    );

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/button detached/);

    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("waits for the Add Customer control while the workspace is still loading", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ addCustomerVisibleAfterMs: 40 }),
    );

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(fixture.state.submitted).toBe(true);
  });

  it("treats an Add Customer control that never appears as a harness failure with the route", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ addCustomerVisible: false }),
    );

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(
      /could not locate the Add Customer control within 15000ms at \/org_preview_1\/customers/,
    );

    expect(fixture.addCustomerButton.click).not.toHaveBeenCalled();
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("treats a dialog that never opens as a harness failure, not a product breach", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ dialogVisible: false }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/could not open the Add Customer dialog/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("waits for the search control while the page reloads", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ reloadVisibleAfterMs: 40 }),
    );

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(fixture.state.search).toBe(fixture.state.email);
    expect(fixture.addCustomerButton.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 15_000,
    });
    expect(fixture.searchInput.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 15_000,
    });
  });

  it("waits for the customer result that renders after the search is typed", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ resultVisibleAfterMs: 40 }),
    );

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(fixture.searchInput.fill).toHaveBeenCalledTimes(1);
  });

  it("treats a search control that never reappears after reload as a harness failure", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ searchControlVisible: false }),
    );

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/could not locate the customer search control after reload/);

    expect(fixture.state.search).toBe("");
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("fails the oracle, never passes, when the customer never shows after reload", async () => {
    makeBrowserFixture(defaultScenario({ resultVisibleAfterReload: false }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle.passed).toBe(false);
  });

  it("passes a customer that arrives while the search is still paging, long past the first wait (no busy marker, 0 loaded results)", async () => {
    makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: 12, resultVisibleAfterPolls: 9 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(backendEvidenceBody()).toContain('"resultSettle": "VISIBLE"');
  });

  it("passes a customer whose row renders only after the status reaches Exhausted", async () => {
    makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: 6, resultVisibleAfterPolls: 6 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
  });

  it("matches the visible desktop row, not the hidden mobile card that comes first in the DOM", async () => {
    makeBrowserFixture(defaultScenario({ hiddenMobileMatchFirst: true }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
  });

  it("is a harness error, never a breach, when the customers search never completes", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: "never", resultVisibleAfterReload: false }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/customers search did not complete/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("confirms the breach only on a complete (Exhausted) search that still lacks the customer, backend count 1", async () => {
    makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: 5, resultVisibleAfterReload: false }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: false });
    expect(backendEvidenceBody()).toContain('"resultSettle": "SETTLED_ABSENT"');
  });

  it("does not poll the UI status when the backend count is not 1", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ backendCustomerMatches: 0, resultVisibleAfterReload: false }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: false });
    expect(fixture.statusGetAttribute).not.toHaveBeenCalled();
  });

  it("is a harness error with the last status null when the status marker reads null, after a few reads", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ statusRead: "null", resultVisibleAfterReload: false }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/last status null/);

    expect(fixture.statusGetAttribute).toHaveBeenCalledTimes(3);
  });

  it("treats a status read that times out as a missing marker, never as a complete search", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ statusRead: "timeout", resultVisibleAfterReload: false }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/last status null/);

    expect(fixture.statusGetAttribute).toHaveBeenCalledTimes(3);
  });

  it("propagates a non-timeout status read failure instead of swallowing it", async () => {
    makeBrowserFixture(defaultScenario({ statusRead: new Error("page crashed"), resultVisibleAfterReload: false }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/page crashed/);
  });

  it("stops polling a never-complete status at the wall-clock deadline and reports the last status", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: "never", resultVisibleAfterReload: false }));
    // Each status read burns one second of wall clock: 80 polls would be ~80s without the deadline.
    let clock = 1_700_000_000_000;
    const real = fixture.statusGetAttribute.getMockImplementation();
    fixture.statusGetAttribute.mockImplementation(async (name: string) => {
      clock += 1_000;
      return real ? real(name) : null;
    });
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await expect(
        handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
      ).rejects.toThrow(/last status CanLoadMore/);
    } finally {
      spy.mockRestore();
    }

    expect(fixture.statusGetAttribute.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it("waits for a save that commits after the click: count 0 before commit is not a breach", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ backendCommitAfterQueries: 3 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
    // 3 reads before the commit, the first read that sees it, and the re-read just before the verdict.
    expect(fixture.searchQueryCount()).toBe(5);
    const body = backendEvidenceBody() ?? "";
    expect(body).toContain('"exactBackendMatchCount": 1');
    expect(body).toContain('"finalBackendMatchCount": 1');
    expect(body).toContain('"backendReads": 5');
    expect(body).toMatch(/"backendReadElapsedMs": \d+/);
    expect(body).toContain('"uiSaveSucceeded": true');
  });

  it("is a harness error, never a breach, when the dialog stays open after submit, and reads no backend count", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ dialogStaysOpen: true, backendCustomerMatches: 0 }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/dialog stayed open after submit/);

    expect(fixture.searchQueryCount()).toBe(0);
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("reads the backend only after the dialog has closed", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ dialogClosedAfterMs: 40 }));
    const closedWhenRead: boolean[] = [];
    const client = await mocks.authenticatedConvexClient();
    const query = client.query;
    client.query = vi.fn(async (...args: unknown[]) => {
      closedWhenRead.push(fixture.state.dialogClosed);
      return query(...args);
    });

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(closedWhenRead.length).toBeGreaterThan(0);
    expect(closedWhenRead.every(Boolean)).toBe(true);
  });

  it("fails the oracle when a second insert lands after the first read: 1 then 2", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ backendMatchesSequence: [1, 2] }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: false });
    expect(fixture.searchQueryCount()).toBe(2);
    const body = backendEvidenceBody() ?? "";
    expect(body).toContain('"exactBackendMatchCount": 1');
    expect(body).toContain('"finalBackendMatchCount": 2');
  });

  it("confirms a mismatch when the UI saved (dialog closed) but the backend still has no customer after the bounded reads", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ backendCustomerMatches: 0 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: false });
    expect(fixture.searchQueryCount()).toBe(21);
    const body = backendEvidenceBody() ?? "";
    expect(body).toContain('"uiSaveSucceeded": true');
    expect(body).toContain('"finalBackendMatchCount": 0');
    expect(body).toContain('"backendReads": 21');
  });

  it("passes a row that becomes visible only DURING the final wait after Exhausted was observed", async () => {
    makeBrowserFixture(defaultScenario({ resultOnlyDuringFinalWait: true, exhaustedAfterPolls: 2 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(backendEvidenceBody()).toContain('"resultSettle": "VISIBLE"');
  });

  it("falls back to one last isVisible when the settle polls run out and passes a row visible by then", async () => {
    makeBrowserFixture(defaultScenario({ exhaustedAfterPolls: "never", resultVisibleAfterPolls: 80 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
  });

  it("does not let a backend query that never answers hang the mission", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      makeBrowserFixture(defaultScenario({ backendQueryHangs: true }));
      const run = handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));
      const settled = expect(run).rejects.toThrow(/backend customer query did not answer within 5000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops with a harness error when the mission budget is already spent", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    const context = executionContext("UI_BACKEND_MISMATCH");

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")({ ...context, mission: { ...context.mission, timeoutMs: 15_000 } }),
    ).rejects.toThrow(/ran out of mission time before the customers page loaded/);

    expect(fixture.searchQueryCount()).toBe(0);
  });

  it("fails a count above 1 at the first read, without waiting or re-reading", async () => {
    const duplicate = makeBrowserFixture(defaultScenario({ backendCustomerMatches: 2 }));
    const duplicated = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));
    expect(duplicated.oracle).toMatchObject({ passed: false });
    expect(duplicate.searchQueryCount()).toBe(1);
  });

  it("is a harness error with zero backend reads when the dialog vanishes without the success toast", async () => {
    const fixture = makeBrowserFixture(defaultScenario({ noSuccessToast: true, backendCustomerMatches: 0 }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
    ).rejects.toThrow(/closed without the success toast/);

    expect(fixture.state.dialogClosed).toBe(true);
    expect(fixture.searchQueryCount()).toBe(0);
  });

  it("waits for the toast and the dialog concurrently: a short-lived toast is still seen before a slower close", async () => {
    // Toast gone 20ms after submit, dialog closes at 40ms: only a wait begun alongside the
    // dialog wait can see the toast; one begun after the close would time out.
    const fixture = makeBrowserFixture(
      defaultScenario({ toastVisibleForMs: 20, dialogClosedAfterMs: 40 }),
    );

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    expect(evidence.oracle).toMatchObject({ passed: true });
    expect(fixture.state.toastWaitStartedAfterClose).toBe(false);
    expect(backendEvidenceBody()).toContain('"uiSaveSucceeded": true');
  });

  it("matches the success toast against the real English and Arabic catalog strings", async () => {
    const fixture = makeBrowserFixture(defaultScenario());

    await handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH"));

    const toastPattern = fixture.page.getByText.mock.calls
      .map(([text]) => text)
      .find((text): text is RegExp => text instanceof RegExp);
    expect(toastPattern?.test(customersEn.CustomerAddedSuccess)).toBe(true);
    expect(toastPattern?.test(customersAr.CustomerAddedSuccess)).toBe(true);
    expect(toastPattern?.test("Customer removed")).toBe(false);
  });

  describe("mission budget exhausted midway", () => {
    // Moves the handler's clock forward at a chosen step, as if that step had used up the budget.
    const spendBudget = () => {
      const real = Date.now.bind(Date);
      let offset = 0;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
      return { spend: () => { offset += 31_000; }, restore: () => spy.mockRestore() };
    };

    it("is a harness error when the budget runs out during the result search", async () => {
      const clock = spendBudget();
      try {
        const fixture = makeBrowserFixture(defaultScenario());
        const fill = fixture.searchInput.fill.getMockImplementation();
        fixture.searchInput.fill.mockImplementation(async (value: string) => {
          await fill?.(value);
          clock.spend();
        });

        await expect(
          handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
        ).rejects.toThrow(/ran out of mission time before the customer result appeared/);
      } finally {
        clock.restore();
      }
    });

    it("is a harness error when the budget runs out before the final backend read, never a verdict", async () => {
      const clock = spendBudget();
      try {
        const fixture = makeBrowserFixture(defaultScenario());
        overrideResultLookup(fixture, (found) => {
          const row = found.filter({ visible: true }).first();
          const spent: FakeRow = {
            ...row,
            waitFor: async (...args) => {
              await row.waitFor(...args);
              clock.spend();
            },
          };
          return { ...found, filter: () => ({ first: () => spent }) };
        });

        await expect(
          handlerFor("UI_BACKEND_MISMATCH")(executionContext("UI_BACKEND_MISMATCH")),
        ).rejects.toThrow(/ran out of mission time before the backend customer query/);

        // Only the first read happened; the final one was refused, so no verdict was written.
        expect(fixture.searchQueryCount()).toBe(1);
        expect(backendEvidenceBody()).toBeUndefined();
      } finally {
        clock.restore();
      }
    });
  });

  it("propagates a post-reload visibility probe failure as a harness error", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    const closedRow = {
      isVisible: vi.fn(async () => false),
      waitFor: vi.fn(async () => {
        throw new Error("page closed during oracle");
      }),
    };
    overrideResultLookup(fixture, () => ({
      first: () => closedRow,
      filter: () => ({ first: () => closedRow }),
      locator: () => ({ first: () => closedRow }),
    }));

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/page closed during oracle/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("fails the UI/backend oracle on duplicate authoritative records", async () => {
    makeBrowserFixture(defaultScenario({ backendCustomerMatches: 2 }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle.passed).toBe(false);
  });

  it("propagates an unavailable backend oracle so the executor can classify HARNESS_ERROR", async () => {
    const fixture = makeBrowserFixture(
      defaultScenario({ backendQueryError: new Error("backend unavailable") }),
    );

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/backend unavailable/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("propagates an unresolved organization route as a harness failure", async () => {
    const fixture = makeBrowserFixture(defaultScenario());
    fixture.page.url.mockReturnValue("http://127.0.0.1:3000/sign-in");

    await expect(
      handlerFor("UI_BACKEND_MISMATCH")(
        executionContext("UI_BACKEND_MISMATCH"),
      ),
    ).rejects.toThrow(/did not resolve an organization route/);

    expect(fixture.browser.close).toHaveBeenCalled();
  });

  // SCRUM-826 / SCRUM-824 G4: the org route is read from the URL PATHNAME. The
  // old unanchored RegExp matched the host:port of
  // "http://localhost:3000/dashboard" as if it were an org segment, so the wait
  // returned before the app's redirect and both attack workers died with
  // "could not resolve the authenticated organization route".
  describe("organization route resolution (SCRUM-826, SCRUM-824 G4)", () => {
    it("waits through the /dashboard entry URL until the redirect carries the org segment", async () => {
      const fixture = makeBrowserFixture(
        defaultScenario({
          orgId: "org123",
          routing: {
            landingUrl: "http://localhost:3000/dashboard",
            settledUrl: "http://localhost:3000/org123/dashboard",
          },
        }),
      );

      const evidence = await handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      );

      // The org id came from the redirected URL, and the backend oracle that
      // consumed it agrees (listMine returns org123).
      expect(evidence.oracle.passed).toBe(true);
      expect(fixture.page.url()).toBe("http://localhost:3000/org123/dashboard");
      expect(mocks.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/backend-state\.json$/),
        expect.stringContaining('"orgIdBefore": "org123"'),
        "utf8",
      );
    });

    it("resolves an org route that carries a query string", async () => {
      makeBrowserFixture(
        defaultScenario({
          orgId: "org123",
          routing: {
            landingUrl: "http://localhost:3000/dashboard",
            settledUrl: "http://localhost:3000/org123/sales?x=1",
          },
        }),
      );

      const evidence = await handlerFor("RTL_PARITY")(
        executionContext("RTL_PARITY"),
      );

      expect(evidence.oracle.passed).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/backend-state\.json$/),
        expect.stringContaining('"orgIdBefore": "org123"'),
        "utf8",
      );
    });

    it("fails closed and never invents an org id when the app never leaves /dashboard", async () => {
      const fixture = makeBrowserFixture(
        defaultScenario({
          orgId: "org123",
          routing: {
            landingUrl: "http://localhost:3000/dashboard",
            settledUrl: null,
          },
        }),
      );

      await expect(
        handlerFor("RTL_PARITY")(executionContext("RTL_PARITY")),
      ).rejects.toThrow(/waitForURL: Timeout|organization route/);

      // No backend authority query ran against a guessed organization, and the
      // browser was still cleaned up.
      expect(mocks.authenticatedConvexClient).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    });
  });
});
