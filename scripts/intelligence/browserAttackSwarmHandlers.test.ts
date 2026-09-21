import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAttackMission,
  BrowserSwarmRunManifest,
  BrowserSwarmWorkerPlan,
} from "./browserAttackSwarm";
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

import { createInitialBrowserAttackHandlers } from "./browserAttackSwarmHandlers";

type Scenario = {
  orgId: string;
  languageButtonVisible: boolean;
  initialLanguageButton: "en" | "ar";
  addCustomerVisible: boolean;
  dialogVisible: boolean;
  searchVisibleAfterReload: boolean;
  backendOwnsOrg: boolean;
  backendCustomerMatches: number;
  backendQueryError?: Error;
};

function defaultScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    orgId: "org_preview_1",
    languageButtonVisible: true,
    initialLanguageButton: "en",
    addCustomerVisible: true,
    dialogVisible: true,
    searchVisibleAfterReload: true,
    backendOwnsOrg: true,
    backendCustomerMatches: 1,
    ...overrides,
  };
}

function makeBrowserFixture(scenario: Scenario) {
  const state = {
    currentUrl: "http://127.0.0.1:3000/" + scenario.orgId + "/dashboard",
    lang: scenario.initialLanguageButton === "ar" ? "ar" : "en",
    dir: scenario.initialLanguageButton === "ar" ? "rtl" : "ltr",
    dialogOpened: false,
    submitted: false,
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

  const addCustomerButton = {
    isVisible: vi.fn(async () => scenario.addCustomerVisible),
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
      async () => state.dialogOpened && scenario.dialogVisible,
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
      }),
    })),
  };

  const searchInput = {
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async (value: string) => {
      state.search = value;
    }),
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      if (url === "/dashboard") {
        state.currentUrl =
          "http://127.0.0.1:3000/" + scenario.orgId + "/dashboard";
      } else {
        state.currentUrl = "http://127.0.0.1:3000" + url;
      }
    }),
    waitForURL: vi.fn(async () => undefined),
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
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn((selector: string) => {
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
    reload: vi.fn(async () => undefined),
    getByText: vi.fn(() => ({
      first: vi.fn(() => ({
        isVisible: vi.fn(
          async () =>
            scenario.searchVisibleAfterReload &&
            state.submitted &&
            state.search === state.email,
        ),
      })),
    })),
    isClosed: vi.fn(() => state.closed),
    screenshot: vi.fn(async () => undefined),
  };

  const tracing = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const browserContext = {
    tracing,
    newPage: vi.fn(async () => page),
  };
  const browser = {
    newContext: vi.fn(async () => browserContext),
    close: vi.fn(async () => {
      state.closed = true;
    }),
  };

  mocks.chromiumLaunch.mockResolvedValue(browser);
  mocks.authenticatedConvexClient.mockResolvedValue({
    query: vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if (scenario.backendQueryError) throw scenario.backendQueryError;

      if ("search" in args) {
        return Array.from(
          { length: scenario.backendCustomerMatches },
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

  return { state, page, browser, browserContext, tracing };
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

  it("reports an RTL oracle failure when the authenticated organization is not backend-owned", async () => {
    makeBrowserFixture(defaultScenario({ backendOwnsOrg: false }));

    const evidence = await handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY"),
    );

    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/diverged/);
  });

  it("reports an RTL oracle failure when the language control is unavailable", async () => {
    makeBrowserFixture(
      defaultScenario({ languageButtonVisible: false }),
    );

    const evidence = await handlerFor("RTL_PARITY")(
      executionContext("RTL_PARITY"),
    );

    expect(evidence.oracle.passed).toBe(false);
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

  it("fails the UI/backend oracle when the dialog never opens", async () => {
    makeBrowserFixture(defaultScenario({ dialogVisible: false }));

    const evidence = await handlerFor("UI_BACKEND_MISMATCH")(
      executionContext("UI_BACKEND_MISMATCH"),
    );

    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/disagreed/);
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
});
