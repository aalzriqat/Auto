import {
  MAX_BROWSER_SWARM_WORKERS,
  buildBrowserSwarmRunManifest,
  planBrowserAttackSwarm,
  type BrowserAttackFamily,
  type BrowserSwarmRunManifest,
  type JevBrowserMissionSuggestion,
} from "./browserAttackSwarm";
import type { InvariantSeverity } from "../autoflowInvariantCatalog";

type Env = Record<string, string | undefined>;

const KNOWN_FAMILIES = new Set<BrowserAttackFamily>([
  "TENANT_ESCAPE",
  "AUTHORIZATION_ABUSE",
  "DUPLICATE_SUBMIT",
  "STALE_UI",
  "LIFECYCLE_REVERSAL",
  "CONSIGNMENT_ECONOMICS",
  "FINANCE_REORDERING",
  "MONEY_BOUNDARY",
  "NAVIGATION_RACE",
  "NETWORK_RECOVERY",
  "MULTI_TAB_RACE",
  "COMPLETENESS_BOUNDARY",
  "RTL_PARITY",
  "UI_BACKEND_MISMATCH",
]);

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error("Browser swarm runtime requires " + key);
  return value;
}

export function browserSwarmLocalBaseUrl(env: Env): string {
  const raw = env.PLAYWRIGHT_BASE_URL?.trim() || "http://127.0.0.1:3000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PLAYWRIGHT_BASE_URL must be a valid local HTTP origin");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    parsed.protocol !== "http:" ||
    !localHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "PLAYWRIGHT_BASE_URL must be a bare localhost/loopback HTTP origin for the preview swarm",
    );
  }

  return parsed.origin;
}

export function assertBrowserSwarmExecutionEnvironment(env: Env): void {
  if (env.BROWSER_SWARM_ENABLED !== "1") {
    throw new Error(
      "Browser swarm execution requires BROWSER_SWARM_ENABLED=1",
    );
  }
  if (env.CI !== "true") {
    throw new Error(
      "Browser swarm execution requires CI=true so Playwright cannot reuse an existing local server",
    );
  }
  const skipWebServer = Boolean(env.PLAYWRIGHT_SKIP_WEBSERVER?.trim());
  const trustedExternalServer =
    env.BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER === "1";

  if (skipWebServer && !trustedExternalServer) {
    throw new Error(
      "Browser swarm execution refuses PLAYWRIGHT_SKIP_WEBSERVER unless the trusted main workflow attests BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER=1",
    );
  }
  if (trustedExternalServer && !skipWebServer) {
    throw new Error(
      "BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER=1 requires PLAYWRIGHT_SKIP_WEBSERVER so Playwright cannot start a second frontend",
    );
  }

  browserSwarmLocalBaseUrl(env);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(label + " must be valid JSON");
  }
}

function parseImpactedInvariants(raw: string): {
  id: string;
  severity: InvariantSeverity;
}[] {
  const value = parseJson(raw, "BROWSER_SWARM_IMPACTED_INVARIANTS_JSON");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "BROWSER_SWARM_IMPACTED_INVARIANTS_JSON must be a non-empty array",
    );
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Impacted invariant " + index + " must be an object");
    }
    const candidate = entry as { id?: unknown; severity?: unknown };
    if (
      typeof candidate.id !== "string" ||
      !candidate.id.trim() ||
      (candidate.severity !== "HIGH" && candidate.severity !== "CRITICAL")
    ) {
      throw new Error(
        "Impacted invariant " +
          index +
          " must contain a non-blank id and HIGH/CRITICAL severity",
      );
    }
    return {
      id: candidate.id.trim(),
      severity: candidate.severity,
    };
  });
}

function parseJevSuggestions(raw: string | undefined): JevBrowserMissionSuggestion[] {
  if (!raw?.trim()) return [];
  const value = parseJson(raw, "BROWSER_SWARM_JEV_SUGGESTIONS_JSON");
  if (!Array.isArray(value)) {
    throw new Error("BROWSER_SWARM_JEV_SUGGESTIONS_JSON must be an array");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Jev suggestion " + index + " must be an object");
    }
    const candidate = entry as { family?: unknown; probability?: unknown };
    if (
      typeof candidate.family !== "string" ||
      !KNOWN_FAMILIES.has(candidate.family as BrowserAttackFamily) ||
      typeof candidate.probability !== "number"
    ) {
      throw new Error(
        "Jev suggestion " +
          index +
          " must contain a known family and numeric probability",
      );
    }
    return {
      family: candidate.family as BrowserAttackFamily,
      probability: candidate.probability,
    };
  });
}

function parseWorkerCount(raw: string): number {
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_BROWSER_SWARM_WORKERS
  ) {
    throw new Error(
      "BROWSER_SWARM_WORKER_COUNT must be an integer from 1 to " +
        MAX_BROWSER_SWARM_WORKERS,
    );
  }
  return value;
}

export function browserSwarmManifestFromEnv(env: Env): {
  manifest: BrowserSwarmRunManifest;
  workerId: string;
} {
  const impactedInvariants = parseImpactedInvariants(
    required(env, "BROWSER_SWARM_IMPACTED_INVARIANTS_JSON"),
  );
  const workerCount = parseWorkerCount(
    required(env, "BROWSER_SWARM_WORKER_COUNT"),
  );
  const workerId = required(env, "BROWSER_SWARM_WORKER_ID");
  if (!/^worker-[1-8]$/.test(workerId)) {
    throw new Error("BROWSER_SWARM_WORKER_ID must be worker-1 through worker-8");
  }

  const plan = planBrowserAttackSwarm({
    impactedInvariants,
    jevSuggestions: parseJevSuggestions(
      env.BROWSER_SWARM_JEV_SUGGESTIONS_JSON,
    ),
  });

  const manifest = buildBrowserSwarmRunManifest({
    plan,
    workerCount,
    runId: required(env, "BROWSER_SWARM_RUN_ID"),
    previewName: required(env, "CONVEX_PREVIEW_NAME"),
    expectedCloudUrl: required(env, "NEXT_PUBLIC_CONVEX_URL"),
  });

  if (!manifest.workers.some((worker) => worker.workerId === workerId)) {
    throw new Error(
      "BROWSER_SWARM_WORKER_ID " +
        workerId +
        " is outside the configured worker count " +
        workerCount,
    );
  }

  return { manifest, workerId };
}
