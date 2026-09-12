/**
 * The zero-state verifier SHELL (`verifyZeroState.mjs`), executed for real.
 *
 * `zeroState.test.ts` proves the decisions; the disposable-deployment controls
 * prove the CLI's real shapes. Neither instruments the orchestration that runs
 * in the protected release job: which commands are issued, against which
 * target, in what order, and whether the REAL verdict reaches the exit status
 * and the step summary. This suite runs the actual `.mjs` in-process, with
 * only the process boundaries replaced — `child_process.spawnSync` (the Convex
 * CLI), `fetch` (`/instance_name`), `process.exit`, argv and env — and never
 * mocks the classifiers or `decideZeroState`. Every "CLI answer" below is a
 * shape captured from a real deployment (2026-09-12).
 *
 * `process.exit` is replaced by a throw so a refused path really stops: a
 * mocked exit that lets execution continue would certify the wrong branch.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { componentNames } from "./zeroState";

// ── the process boundaries ──────────────────────────────────────────────────
type Spawned = { file: string; cli: string; args: string[]; env: Record<string, string | undefined> };
type CliAnswer = { stdout?: string; stderr?: string; status?: number | null; error?: Error };
const spawned: Spawned[] = [];
let answer: (args: string[]) => CliAnswer = () => ({ stdout: "", stderr: "", status: 1 });

vi.mock("node:child_process", () => {
  // The shell runs `node <repo CLI path> <command…> <selector>`; the CLI path is
  // recorded (it must be the repository-local binary) and stripped for matching.
  const spawnSync = (file: string, rawArgs: string[], opts: { env: Record<string, string | undefined> }) => {
    const args = rawArgs.slice(1);
    spawned.push({ file, cli: rawArgs[0], args, env: opts.env });
    const a = answer(args);
    if (a.error) return { error: a.error, stdout: "", stderr: "", status: null };
    return { stdout: a.stdout ?? "", stderr: a.stderr ?? "", status: a.status ?? 0 };
  };
  return { spawnSync, default: { spawnSync } };
});

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const NOISE = "(node:123) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.\n(Use `node --trace-warnings ...` to show where the warning was created)\n";
const DEPLOYMENT = "clever-mockingbird-719";
const PROD_KEY = `prod:${DEPLOYMENT}|not-a-real-key-000`;
const SCHEMA_TABLES = (() => {
  const src = fs.readFileSync(path.join(process.cwd(), "convex", "schema.ts"), "utf8");
  return [...src.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*defineTable\(/gm)].map((m) => m[1]);
})();
// The components the repository actually mounts (the shell derives its scope
// from the same file); each aggregate component lists the two B-tree tables.
const COMPONENT_TABLES: Record<string, string[]> = Object.fromEntries(
  componentNames(fs.readFileSync(path.join(process.cwd(), "convex", "convex.config.ts"), "utf8")).map((name) => [
    name,
    name === "rateLimiter" ? ["rateLimits"] : ["btree", "btreeNode"],
  ])
);
const COMPONENT_TABLE_COUNT = Object.values(COMPONENT_TABLES).flat().length;
const HEARTBEAT_ROW =
  '{ "_creationTime": 1789207446757.7534, "_id": "nd788tqmdkdbnmzjp7e5t6remh8e92tx", "detail": "Triggered alarms for 0 tasks.", "jobName": "check-upcoming-tasks", "ranAt": 1789207446757, "success": true }';
const CRON_REPORT_ROW =
  '{ "_creationTime": 1789206846920.4004, "_id": "n17h3qfrveeh9d2vbt0wwm5g518e90eb", "createdAt": 1789206846920, "source": "social-auto-reply-retry", "status": "success", "summary": "Retried 0 pending auto-replies: 0 succeeded, 0 failed." }';
const CLERK_ROW =
  '{ "_creationTime": 1789206846921.1, "_id": "n17clerk000000000000000000000001", "createdAt": 1789206846921, "eventId": "evt_1", "payloadSha256": "ab", "receiveCount": 1, "lastReceivedAt": 1789206846921, "source": "clerk", "status": "received", "summary": "user.created" }';
const DOC_TABLE_HEADER = "_id                                | _creationTime\n---|---\n";

/** A deployment as the CLI would answer for it: empty unless overridden per table. */
function deploymentAnswers(over: {
  functionCount?: number;
  marker?: "absent" | "preview" | "fail" | "silent";
  nonEmpty?: Record<string, string[]>; // table → jsonl rows (root tables)
  nonEmptyComponent?: Record<string, string[]>; // "component/table" → rows
  storageNonEmpty?: boolean;
  listingFails?: boolean;
  specFails?: boolean;
  componentListingFails?: string;
  extraListed?: string[];
} = {}): (args: string[]) => CliAnswer {
  const marker = over.marker ?? "absent";
  const listed = [...SCHEMA_TABLES, ...(over.extraListed ?? [])];
  return (args) => {
    const cmd = args[0];
    if (cmd === "function-spec") {
      if (over.specFails) return { stdout: "", stderr: "✖ denied", status: 1 };
      const functions = Array.from({ length: over.functionCount ?? 908 }, (_, i) => ({ identifier: `f${i}` }));
      return { stdout: JSON.stringify({ functions, url: `https://${DEPLOYMENT}.convex.cloud` }), status: 0 };
    }
    if (cmd === "env" && args[1] === "get") {
      if (marker === "preview") return { stdout: `${NOISE}preview\n`, stderr: "", status: 0 };
      if (marker === "fail") return { stdout: "", stderr: "✖ Deployment not found", status: 1 };
      if (marker === "silent") return { stdout: NOISE, stderr: NOISE, status: 0 };
      return { stdout: NOISE, stderr: `${NOISE}✖ Environment variable "${args[2]}" not found (on prod deployment ${DEPLOYMENT})\n`, status: 0 };
    }
    if (cmd === "data") {
      const componentIdx = args.indexOf("--component");
      const component = componentIdx === -1 ? null : args[componentIdx + 1];
      const table = args[1] && !args[1].startsWith("--") ? args[1] : null;
      if (table === null) {
        // a listing
        if (component === null) {
          if (over.listingFails) return { stdout: "", stderr: "✖ denied", status: 1 };
          return { stdout: `${NOISE}${listed.join("\n")}\n`, stderr: "", status: 0 };
        }
        if (over.componentListingFails === component) return { stdout: "", stderr: "✖ denied", status: 1 };
        return { stdout: `${NOISE}${(COMPONENT_TABLES[component] ?? []).join("\n")}\n`, stderr: "", status: 0 };
      }
      const rows = component === null ? over.nonEmpty?.[table] : over.nonEmptyComponent?.[`${component}/${table}`];
      if (table === "_storage" && over.storageNonEmpty) return { stdout: `${DOC_TABLE_HEADER}"kg2..." | 1\n`, stderr: "", status: 0 };
      if (table === "_scheduled_functions") return { stdout: `${DOC_TABLE_HEADER}"s1" | 1\n`, stderr: "", status: 0 };
      if (!rows || rows.length === 0) return { stdout: NOISE, stderr: `${NOISE}There are no documents in this table.\n`, status: 0 };
      const limitIdx = args.indexOf("--limit");
      const limit = Number(args[limitIdx + 1]);
      if (args.includes("--format")) return { stdout: `${NOISE}${rows.slice(0, limit).join("\n")}\n`, stderr: "", status: 0 };
      return { stdout: `${DOC_TABLE_HEADER}${rows.slice(0, limit).map((r) => `${JSON.parse(r)._id} | 1`).join("\n")}\n`, stderr: "", status: 0 };
    }
    return { stdout: "", stderr: `unexpected command ${cmd}`, status: 1 };
  };
}

// ── running the real shell ──────────────────────────────────────────────────
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT = process.exit;
let summaryFile: string;
let logs: string[];
let errors: string[];

async function runShell(argv: string[], env: Record<string, string | undefined>, opts: { instanceName?: string | null; fetchFails?: boolean } = {}) {
  spawned.length = 0;
  logs.length = 0;
  errors.length = 0;
  for (const key of ["CONVEX_DEPLOY_KEY", "CONVEX_PROD_DEPLOYMENT", "RELEASE_SHA", "GITHUB_STEP_SUMMARY"]) delete process.env[key];
  // The step summary goes to a temp file by default so every run can be read back; a test opts out with GITHUB_STEP_SUMMARY: undefined.
  const effective: Record<string, string | undefined> = { GITHUB_STEP_SUMMARY: summaryFile, ...env };
  for (const [key, value] of Object.entries(effective)) if (value !== undefined) process.env[key] = value;
  process.argv = ["node", "scripts/verifyZeroState.mjs", ...argv];
  vi.stubGlobal("fetch", async (url: string) => {
    if (opts.fetchFails) throw new Error("network down");
    const name = opts.instanceName === undefined ? DEPLOYMENT : opts.instanceName;
    if (name === null) return { ok: false, text: async () => "" };
    expect(url).toBe(`https://${(env.CONVEX_PROD_DEPLOYMENT ?? argv[argv.indexOf("--deployment") + 1]).trim()}.convex.cloud/instance_name`);
    return { ok: true, text: async () => `${name}\n` };
  });
  vi.resetModules();
  let exitCode = 0;
  try {
    await import("./verifyZeroState.mjs");
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else throw e;
  }
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "";
  return { exitCode, summary, stdout: logs.join("\n"), stderr: errors.join("\n"), commands: spawned.map((s) => s.args) };
}

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never;
  summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zero-state-")), "summary.md");
  answer = deploymentAnswers();
});

afterEach(() => {
  process.exit = ORIGINAL_EXIT;
  process.argv = ORIGINAL_ARGV;
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(path.dirname(summaryFile), { recursive: true, force: true });
});

const accountLogin = (phase = "post-deploy") => runShell(["--phase", phase, "--deployment", DEPLOYMENT], {});

describe("target selection and refusals — nothing is issued before the target is bound", () => {
  test("deploy-key mode: the key must address CONVEX_PROD_DEPLOYMENT; every command is then selected by --prod, and the key never reaches the output", async () => {
    const r = await runShell(["--phase", "post-deploy", "--release-sha", "abc123"], { CONVEX_DEPLOY_KEY: PROD_KEY, CONVEX_PROD_DEPLOYMENT: DEPLOYMENT });
    expect(r.exitCode).toBe(0);
    expect(r.commands.length).toBeGreaterThan(0);
    for (const c of r.commands) {
      expect(c.at(-1)).toBe("--prod");
      expect(c).not.toContain("--deployment");
    }
    expect(r.stdout).toMatch(/deploy-key/);
    expect(r.stdout + r.stderr + r.summary).not.toMatch(/not-a-real-key/);
    expect(spawned.every((s) => s.env.CONVEX_AGENT_MODE === "anonymous")).toBe(true);
    expect(spawned.every((s) => s.file === process.execPath && s.cli.endsWith(path.join("node_modules", "convex", "bin", "main.js")))).toBe(true);
  });

  test("deploy-key mode: a key bound to another deployment is refused before any command", async () => {
    const r = await runShell(["--phase", "post-deploy"], { CONVEX_DEPLOY_KEY: "prod:kindly-hound-172|not-a-real-key-000", CONVEX_PROD_DEPLOYMENT: DEPLOYMENT });
    expect(r.exitCode).toBe(1);
    expect(r.commands).toEqual([]);
    expect(r.stderr).toMatch(/kindly-hound-172|not the expected/i);
    // The mocked exit really stopped the module: nothing after the refusal ran.
    expect(r.stdout).not.toMatch(/Zero-state verification:|✔/);
    expect(r.summary).toBe("");
  });

  test("deploy-key mode: a preview key, a malformed key, or a missing CONVEX_PROD_DEPLOYMENT is refused before any command", async () => {
    for (const env of [
      { CONVEX_DEPLOY_KEY: "preview:acme:proj|x", CONVEX_PROD_DEPLOYMENT: DEPLOYMENT },
      { CONVEX_DEPLOY_KEY: "prod:|x", CONVEX_PROD_DEPLOYMENT: DEPLOYMENT },
      { CONVEX_DEPLOY_KEY: PROD_KEY },
    ]) {
      const r = await runShell(["--phase", "post-deploy"], env);
      expect(r.exitCode).toBe(1);
      expect(r.commands).toEqual([]);
    }
  });

  test("account-login mode: --deployment selects every command; no key, no --prod", async () => {
    const r = await accountLogin();
    expect(r.exitCode).toBe(0);
    for (const c of r.commands) {
      expect(c.slice(-2)).toEqual(["--deployment", DEPLOYMENT]);
      expect(c).not.toContain("--prod");
    }
    expect(r.stdout).toMatch(/account-login/);
  });

  test("account-login mode: a missing or malformed deployment name is refused before any command", async () => {
    expect((await runShell(["--phase", "post-deploy"], {})).exitCode).toBe(1);
    const bad = await runShell(["--phase", "post-deploy", "--deployment", "Bad Name;rm"], {});
    expect(bad.exitCode).toBe(1);
    expect(bad.commands).toEqual([]);
  });

  test("an invalid or missing phase is refused before any command", async () => {
    const phase = await runShell(["--phase", "sometime", "--deployment", DEPLOYMENT], {});
    expect(phase.exitCode).toBe(1);
    expect(phase.commands).toEqual([]);
    expect(phase.stderr).toMatch(/--phase must be pre-deploy or post-deploy/);
    const none = await runShell(["--deployment", DEPLOYMENT], {});
    expect(none.exitCode).toBe(1);
    expect(none.commands).toEqual([]);
    // The repository-local CLI presence check (`existsSync` on node_modules) is
    // the one guard this suite does not drive: `node:fs` is not interceptable
    // for the shell under this harness, and removing the CLI is not a test.
    // Every run here proves the positive side — the binary it spawns is that one.
  });
});

describe("the commands issued are read-only and complete", () => {
  test("post-deploy on an empty deployment: function-spec, one env read, the listing, one limit-one read per listed and component table, storage and scheduled functions — and nothing that writes", async () => {
    const r = await accountLogin();
    expect(r.exitCode).toBe(0);
    const heads = r.commands.map((c) => c.slice(0, 2).join(" "));
    expect(heads.filter((h) => h === "function-spec --deployment")).toHaveLength(1);
    expect(heads.filter((h) => h === "env get")).toHaveLength(1);
    expect(r.commands.filter((c) => c[0] === "data" && c[1] === "--deployment")).toHaveLength(1); // the root listing
    expect(r.commands.filter((c) => c[0] === "data" && c[1] === "--component")).toHaveLength(Object.keys(COMPONENT_TABLES).length);
    const rootReads = r.commands.filter((c) => c[0] === "data" && c[2] === "--limit" && !c.includes("--component"));
    expect(rootReads.map((c) => c[1]).sort()).toEqual([...SCHEMA_TABLES, "_storage", "_scheduled_functions"].sort());
    expect(rootReads.every((c) => c[3] === "1")).toBe(true);
    const componentReads = r.commands.filter((c) => c[0] === "data" && c[2] === "--limit" && c.includes("--component"));
    expect(componentReads).toHaveLength(COMPONENT_TABLE_COUNT);
    for (const c of r.commands) {
      expect(["function-spec", "env", "data"]).toContain(c[0]);
      expect(c).not.toContain("set");
      expect(c).not.toContain("deploy");
      expect(c).not.toContain("run");
      expect(c).not.toContain("import");
    }
    expect(r.summary).toMatch(/Zero-state verified/);
    expect(r.summary).toMatch(new RegExp(`listed tables: ${SCHEMA_TABLES.length} · schema tables: ${SCHEMA_TABLES.length} · component tables: ${COMPONENT_TABLE_COUNT}`));
    expect(COMPONENT_TABLE_COUNT).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/marker AUTOFLOW_DEPLOYMENT_CLASS: VERIFIED_ABSENT/);
  });

  test("pre-deploy issues no per-table reads; on an untouched deployment it is ABSENT_INFRASTRUCTURE, not ZERO", async () => {
    answer = (args) => {
      if (args[0] === "function-spec") return { stdout: JSON.stringify({ functions: [], url: `https://${DEPLOYMENT}.convex.cloud` }), status: 0 };
      if (args[0] === "env") return { stdout: NOISE, stderr: `✖ Environment variable "AUTOFLOW_DEPLOYMENT_CLASS" not found (on prod deployment ${DEPLOYMENT})\n`, status: 0 };
      if (args[0] === "data" && args[1] === "--deployment") return { stdout: NOISE, stderr: `There are no tables in the ${DEPLOYMENT} deployment's database.\n`, status: 0 };
      if (args[0] === "data") return { stdout: NOISE, stderr: "There are no documents in this table.\n", status: 0 };
      return { status: 1 };
    };
    const r = await accountLogin("pre-deploy");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/ABSENT_INFRASTRUCTURE/);
    expect(r.commands.filter((c) => c[0] === "data" && c[2] === "--limit").map((c) => c[1]).sort()).toEqual(["_scheduled_functions", "_storage"]);
    expect(r.commands.some((c) => c.includes("--component"))).toBe(false);
  });
});

describe("the REAL verdict reaches the exit status and the sanitized summary", () => {
  test("unreadable function metadata stops the run at exit 1 before any table read", async () => {
    answer = deploymentAnswers({ specFails: true });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Function metadata could not be read/);
    expect(r.commands.some((c) => c[0] === "data")).toBe(false);
  });

  test("an unreadable table listing stops the run at exit 1", async () => {
    answer = deploymentAnswers({ listingFails: true });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/table listing could not be read/);
  });

  test("the preview marker fails it; a FAILED marker read fails it; silence fails it — none of them passes as absent", async () => {
    for (const [marker, reason] of [
      ["preview", /AUTOFLOW_DEPLOYMENT_CLASS=preview/],
      ["fail", /marker could not be read \(env get exited 1\)/],
      ["silent", /silence is not a verified absence/],
    ] as const) {
      answer = deploymentAnswers({ marker });
      const r = await accountLogin();
      expect(r.exitCode).toBe(1);
      expect(r.summary).toMatch(/Zero-state NOT verified/);
      expect(r.summary).toMatch(reason);
      expect(r.stderr).toMatch(/NOT verified .* Nothing has been changed; do not proceed to bootstrap/);
    }
  });

  test("a document in a business table, a component table, or the file store fails it and names the table — never the document", async () => {
    answer = deploymentAnswers({ nonEmpty: { organizations: ['{ "_id": "j57secret-org-id", "name": "Acme Motors" }'] } });
    const org = await accountLogin();
    expect(org.exitCode).toBe(1);
    expect(org.summary).toMatch(/1 table\(s\) hold documents: organizations/);
    expect(org.summary + org.stdout + org.stderr).not.toMatch(/Acme Motors|secret-org-id/);

    answer = deploymentAnswers({ nonEmptyComponent: { "rateLimiter/rateLimits": ['{ "_id": "r1" }'] } });
    const comp = await accountLogin();
    expect(comp.exitCode).toBe(1);
    expect(comp.summary).toMatch(/rateLimiter\/rateLimits/);

    answer = deploymentAnswers({ storageNonEmpty: true });
    const store = await accountLogin();
    expect(store.exitCode).toBe(1);
    expect(store.summary).toMatch(/_storage\) holds files/);
  });

  test("an unreadable component listing fails it", async () => {
    answer = deploymentAnswers({ componentListingFails: "vehiclesByOrg" });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/component vehiclesByOrg's table listing could not be read/);
  });

  test("zero functions after a push, and a listed table the schema does not declare, both fail post-deploy", async () => {
    answer = deploymentAnswers({ functionCount: 0 });
    expect((await accountLogin()).summary).toMatch(/no functions are deployed/);
    answer = deploymentAnswers({ extraListed: ["strayTable"], nonEmpty: { strayTable: ['{ "_id": "x" }'] } });
    const stray = await accountLogin();
    expect(stray.exitCode).toBe(1);
    expect(stray.summary).toMatch(/hold documents: strayTable/);
  });

  test("identity: the deployment answering to another name, or an unreachable /instance_name with the other read-backs agreeing", async () => {
    const other = await runShell(["--phase", "post-deploy", "--deployment", DEPLOYMENT], {}, { instanceName: "kindly-hound-172" });
    expect(other.exitCode).toBe(1);
    expect(other.summary).toMatch(/answers to kindly-hound-172/);
    const unreachable = await runShell(["--phase", "post-deploy", "--deployment", DEPLOYMENT], {}, { fetchFails: true });
    expect(unreachable.exitCode).toBe(0);
    const notOk = await runShell(["--phase", "post-deploy", "--deployment", DEPLOYMENT], {}, { instanceName: null });
    expect(notOk.exitCode).toBe(0);
  });
});

describe("diagnostic tables are read back in full and validated — the shell issues the bounded jsonl read only for them", () => {
  test("cron self-report rows: a second bounded jsonl read is issued, every row validated, provenance disclosed, verdict ZERO", async () => {
    answer = deploymentAnswers({ nonEmpty: { cronHeartbeats: [HEARTBEAT_ROW, HEARTBEAT_ROW], webhookLogs: [CRON_REPORT_ROW] } });
    const r = await accountLogin();
    expect(r.exitCode).toBe(0);
    const bounded = r.commands.filter((c) => c[0] === "data" && c.includes("--format"));
    expect(bounded.map((c) => c[1]).sort()).toEqual(["cronHeartbeats", "webhookLogs"]);
    for (const c of bounded) {
      expect(c.slice(2, 6)).toEqual(["--limit", "501", "--format", "jsonl"]);
      expect(c.slice(-2)).toEqual(["--deployment", DEPLOYMENT]);
    }
    expect(r.summary).toMatch(/cronHeartbeats: 2 row\(s\) VERIFIED as cron self-reports — heartbeat:check-upcoming-tasks ×2/);
    expect(r.summary).toMatch(/webhookLogs: 1 row\(s\) VERIFIED .* cron-report:social-auto-reply-retry ×1/);
    expect(r.summary).toMatch(/2 operational-diagnostic \(3 row\(s\) verified\)/);
    expect(r.stdout).toMatch(/NONEMPTY: webhookLogs — VERIFIED, 1 row\(s\)/);
    expect(r.summary + r.stdout).not.toMatch(/Retried 0 pending/); // summaries are values; never printed
  });

  test("a provider row after valid cron rows fails it at exit 1, naming the row and the rule, never the value", async () => {
    answer = deploymentAnswers({ nonEmpty: { webhookLogs: [CRON_REPORT_ROW, CRON_REPORT_ROW, CLERK_ROW] } });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/webhookLogs holds 3 row\(s\) that were NOT verified as cron diagnostics \(REJECTED\): webhookLogs row 3: unexpected field/);
    expect(r.summary + r.stdout + r.stderr).not.toMatch(/user\.created|evt_1/);
  });

  test("more rows than the bound: the read asks for bound + 1, sees it exceeded, and fails without sampling", async () => {
    answer = deploymentAnswers({ nonEmpty: { cronHeartbeats: Array.from({ length: 800 }, () => HEARTBEAT_ROW) } });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/cronHeartbeats holds 501 row\(s\) that were NOT verified .*more than 500 rows/);
  });

  test("a failed bounded read is UNREADABLE and fails it", async () => {
    const base = deploymentAnswers({ nonEmpty: { webhookLogs: [CRON_REPORT_ROW] } });
    answer = (args) => (args[0] === "data" && args.includes("--format") ? { stdout: "", stderr: "✖ timeout", status: 1 } : base(args));
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/webhookLogs holds 0 row\(s\) that were NOT verified .*\(UNREADABLE\): the bounded read of webhookLogs exited 1/);
  });

  test("a same-named table inside a component gets no bounded read and fails as a component document", async () => {
    answer = deploymentAnswers({ nonEmptyComponent: { "rateLimiter/cronHeartbeats": [HEARTBEAT_ROW] } });
    // The component listing must advertise the table for it to be read at all.
    const base = answer;
    answer = (args) => {
      if (args[0] === "data" && args[1] === "--component" && args[2] === "rateLimiter") return { stdout: "rateLimits\ncronHeartbeats\n", stderr: "", status: 0 };
      return base(args);
    };
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.commands.some((c) => c.includes("--format"))).toBe(false);
    expect(r.summary).toMatch(/rateLimiter\/cronHeartbeats/);
  });
});

describe("a CLI that fails to start, and a step summary that is written only when GitHub asks for one", () => {
  test("spawn failure (timeout / ENOENT) is a non-status result: function-spec unreadable → exit 1", async () => {
    answer = () => ({ error: new Error("ETIMEDOUT") });
    const r = await accountLogin();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Function metadata could not be read/);
  });

  test("the summary reaches GITHUB_STEP_SUMMARY when set, carries the release SHA and the READ-ONLY / WRITE-CAPABLE label, and nothing is written otherwise", async () => {
    const withFile = await runShell(["--phase", "post-deploy", "--deployment", DEPLOYMENT], { GITHUB_STEP_SUMMARY: summaryFile, RELEASE_SHA: "da309407a" });
    expect(withFile.exitCode).toBe(0);
    expect(withFile.summary).toMatch(/Commit: `da309407a`/);
    expect(withFile.summary).toMatch(/READ-ONLY COMMANDS \/ WRITE-CAPABLE CREDENTIAL/);
    expect(withFile.summary).toMatch(/ONE-TIME LAUNCH CHECKPOINT/);
    fs.rmSync(summaryFile);
    const without = await runShell(["--phase", "post-deploy", "--deployment", DEPLOYMENT], { GITHUB_STEP_SUMMARY: undefined });
    expect(without.exitCode).toBe(0);
    expect(fs.existsSync(summaryFile)).toBe(false);
  });
});
