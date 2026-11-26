// SCRUM-1005: drives the whole runner in process with fake side effects, so every
// verdict path (and the exit code each one gives) is exercised without Chrome.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENTRY_POINTS,
  realDeps,
  run as runUntyped,
  scrubbedEnv,
} from "./runPublicSurface.mjs";

interface Verdict {
  verdict: string;
  reason: string;
  violations: string[];
  problems: string[];
  entries: { slug: string; states: number; paths: string[] }[];
}

/** The runner is plain .mjs; this gives its result and fake deps a shape. */
const run = (input: unknown, deps: unknown) =>
  runUntyped(input as never, deps as never) as Promise<{
    result: Verdict;
    exitCode: number;
  }>;

const BASE = "http://127.0.0.1:3000";
const ROOT = path.resolve("repo-root");

interface SpawnResult {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

/** One `bombadil trace --json` line for a state at `url`. */
const state = (url: string, violations: string[] = []) =>
  JSON.stringify({
    metadata: {
      state: { url },
      violations: violations.map((name) => ({ name })),
    },
  });
const dumpOf = (urls: string[], violations: string[] = []) =>
  urls.map((u, i) => state(u, i === 0 ? violations : [])).join("\n");
const healthyDump = dumpOf(
  Array.from({ length: 12 }, (_, i) => `${BASE}/${i % 2 ? "terms" : ""}`),
);

interface Plan {
  health?: number | undefined;
  binaryExists?: boolean;
  traceExists?: boolean;
  explore?: (slug: string) => SpawnResult;
  dump?: (slug: string) => SpawnResult;
}

function rig(plan: Plan = {}) {
  const calls: { bin: string; args: string[]; env?: unknown }[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  const slugOf = (arg: string) => /trace-(\w+)\.bin/.exec(arg)?.[1] ?? "";
  const deps = {
    spawn: (bin: string, args: string[], options: { env?: unknown }) => {
      calls.push({ bin, args, env: options.env });
      if (args[0] === "trace") {
        const slug = slugOf(args[1] ?? "");
        return plan.dump?.(slug) ?? { status: 0, stdout: healthyDump };
      }
      const slug = slugOf(args[args.indexOf("--output-path") + 1] ?? "");
      return plan.explore?.(slug) ?? { status: 0, stdout: "ok", stderr: "" };
    },
    fetchStatus: async () => ("health" in plan ? plan.health : 200),
    exists: (file: string) =>
      /trace-\w+\.bin$/.test(file)
        ? (plan.traceExists ?? true)
        : (plan.binaryExists ?? true),
    mkdir: () => undefined,
    write: (file: string, text: string) => {
      written[path.basename(file)] = text;
    },
    log: (line: string) => logs.push(line),
  };
  return { deps, calls, written, logs };
}

const input = (over: Record<string, unknown> = {}) => ({
  argv: ["--out-dir", "out", "--time-limit", "5m"],
  env: { PATH: "/bin", HOME: "/h", LANG: "C", CLERK_SECRET_KEY: "secret" },
  platform: "linux",
  arch: "x64",
  root: ROOT,
  ...over,
});

describe("run", () => {
  it("PASS: every entry explored, verdict.json written, exit 0", async () => {
    const r = rig();
    const { result, exitCode } = await run(input(), r.deps);
    expect(result.verdict).toBe("PASS");
    expect(exitCode).toBe(0);
    expect(result.entries).toHaveLength(ENTRY_POINTS.length);
    expect(result.entries[0]).toMatchObject({
      slug: "home",
      states: 12,
      paths: ["/", "/terms"],
    });
    expect(JSON.parse(r.written["verdict.json"] ?? "{}").verdict).toBe("PASS");
    expect(r.written["run-home.log"]).toBe("ok");
    expect(r.logs.join("\n")).toContain("bombadil verdict: PASS");
  });

  it("passes each entry URL, the spec path and 60s to Bombadil, without secrets", async () => {
    const r = rig();
    await run(input(), r.deps);
    const browser = r.calls.filter((c) => c.args[0] === "browser");
    expect(browser).toHaveLength(ENTRY_POINTS.length);
    const first = browser[0]!.args;
    expect(first).toContain("--headless");
    expect(first).not.toContain("--no-sandbox");
    expect(first[first.indexOf("--time-limit") + 1]).toBe("60s");
    expect(first).toContain(`${BASE}/`);
    expect(first.at(-1)).toBe(
      path.join(ROOT, "bombadil/public-surface.spec.ts"),
    );
    expect(browser[1]!.args).toContain(`${BASE}/marketplace/cars`);
    expect(browser[0]!.env).toEqual(
      scrubbedEnv({ PATH: "/bin", HOME: "/h", LANG: "C" }),
    );
    expect(JSON.stringify(r.calls)).not.toContain("secret");
  });

  it("adds --no-sandbox and --allow-url only when asked", async () => {
    const r = rig();
    await run(
      input({
        argv: ["--allow-url", "https://x.test", "--out-dir", "o"],
        env: { BOMBADIL_NO_SANDBOX: "1" },
      }),
      r.deps,
    );
    const args = r.calls.find((c) => c.args[0] === "browser")!.args;
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--allow-url");
    expect(args).toContain("https://x.test");
  });

  it("FAIL: exit 2 with a named violation, exit code 1", async () => {
    const r = rig({
      explore: (slug) => ({ status: slug === "contact" ? 2 : 0, stdout: "x" }),
      dump: (slug) => ({
        status: 0,
        stdout:
          slug === "contact"
            ? dumpOf(
                Array.from({ length: 12 }, () => `${BASE}/contact`),
                ["htmlDirectionMatchesLanguage"],
              )
            : healthyDump,
      }),
    });
    const { result, exitCode } = await run(input(), r.deps);
    expect(result.verdict).toBe("FAIL");
    expect(exitCode).toBe(1);
    expect(result.violations).toEqual([
      "contact: htmlDirectionMatchesLanguage",
    ]);
    expect(r.logs.join("\n")).toContain(
      "violated: contact: htmlDirectionMatchesLanguage",
    );
    // The non-zero exit also prints the tail of the failing run's log.
    expect(r.logs.join("\n")).toContain("x");
  });

  it("FAIL still lists the other problems as 'also'", async () => {
    const r = rig({
      explore: (slug) => ({
        status: slug === "home" ? 2 : slug === "terms" ? 1 : 0,
      }),
    });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("FAIL");
    expect(r.logs.join("\n")).toContain(
      "also: terms: Bombadil exited with code 1",
    );
  });

  it("CANNOT_RUN: unhealthy app (no response and wrong status)", async () => {
    for (const health of [undefined, 503]) {
      const r = rig({ health });
      const { result, exitCode } = await run(input(), r.deps);
      expect(result.verdict).toBe("CANNOT_RUN");
      expect(result.reason).toContain("/api/health");
      expect(exitCode).toBe(1);
      expect(r.calls).toHaveLength(0);
      expect(r.written["verdict.json"]).toContain("CANNOT_RUN");
    }
  });

  it("CANNOT_RUN: missing binary, and nothing is spawned", async () => {
    const r = rig({ binaryExists: false });
    const { result, exitCode } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("missing binary");
    expect(exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
  });

  it("uses --bombadil-bin instead of the bundled binary", async () => {
    const r = rig();
    await run(
      input({ argv: ["--bombadil-bin", "/opt/b", "--out-dir", "o"] }),
      r.deps,
    );
    expect(r.calls[0]!.bin).toBe("/opt/b");
  });

  it("CANNOT_RUN: bad time limit", async () => {
    for (const limit of ["soon", "5", ""]) {
      const r = rig();
      const { result, exitCode } = await run(
        input({ argv: ["--time-limit", limit, "--out-dir", "o"] }),
        r.deps,
      );
      expect(result.verdict).toBe("CANNOT_RUN");
      expect(result.reason).toBe(`bad time limit ${limit}`);
      expect(exitCode).toBe(1);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("CANNOT_RUN: a spawn error on one entry", async () => {
    const r = rig({
      explore: (slug) =>
        slug === "privacy"
          ? { error: new Error("spawn EACCES"), status: null }
          : { status: 0 },
    });
    const { result, exitCode } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain(
      "privacy: binary could not start: spawn EACCES",
    );
    expect(exitCode).toBe(1);
  });

  it("CANNOT_RUN: the trace dump fails, even if it printed states", async () => {
    for (const dump of [
      { status: 1, stdout: healthyDump },
      { status: null, stdout: healthyDump, error: new Error("boom") },
    ]) {
      const r = rig({ dump: () => dump });
      const { result, exitCode } = await run(input(), r.deps);
      expect(result.verdict).toBe("CANNOT_RUN");
      expect(result.reason).toContain("trace could not be read");
      expect(exitCode).toBe(1);
    }
  });

  it("CANNOT_RUN: no trace file was written", async () => {
    const r = rig({ traceExists: false });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("only 0 states");
    expect(r.calls.some((c) => c.args[0] === "trace")).toBe(false);
  });

  it("CANNOT_RUN: states exist but none on the target origin", async () => {
    const offOrigin = dumpOf([
      ...Array.from({ length: 12 }, () => "chrome-error://chromewebdata/"),
    ]);
    const r = rig({ dump: () => ({ status: 0, stdout: offOrigin }) });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("no state on the target origin");
  });

  it("CANNOT_RUN: too few states", async () => {
    const r = rig({
      dump: () => ({ status: 0, stdout: dumpOf([`${BASE}/`, `${BASE}/`]) }),
    });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("only 2 states");
  });

  it("CANNOT_RUN: non-loopback host and a bad minimum, before any I/O", async () => {
    const remote = rig();
    const a = await run(
      input({ argv: ["--base-url", "https://example.org", "--out-dir", "o"] }),
      remote.deps,
    );
    expect(a.result.reason).toContain("not loopback");
    const production = rig();
    const b = await run(
      input({
        argv: [
          "--base-url",
          "https://www.autoflowdealer.com",
          "--allow-host",
          "www.autoflowdealer.com",
        ],
      }),
      production.deps,
    );
    expect(b.result.reason).toContain("production host");
    const min = rig();
    const c = await run(input({ argv: ["--min-states", "0"] }), min.deps);
    expect(c.result.reason).toContain("bad minimum states");
    const win = rig();
    const d = await run(input({ platform: "win32" }), win.deps);
    expect(d.result.reason).toContain("win32-x64");
    for (const r of [remote, production, min, win])
      expect(r.calls).toHaveLength(0);
  });

  it("an unknown argument is an error, not a silent default", async () => {
    await expect(run(input({ argv: ["--nope"] }), rig().deps)).rejects.toThrow(
      "unknown argument --nope",
    );
  });

  it("only PASS gives exit 0", async () => {
    const outcomes = await Promise.all([
      run(input(), rig().deps),
      run(input(), rig({ health: 500 }).deps),
      run(input(), rig({ explore: () => ({ status: 2 }) }).deps),
    ]);
    expect(outcomes.map((o) => [o.result.verdict, o.exitCode])).toEqual([
      ["PASS", 0],
      ["CANNOT_RUN", 1],
      ["FAIL", 1],
    ]);
  });
});

describe("realDeps", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes through the real filesystem helpers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bombadil-run-"));
    dirs.push(dir);
    const nested = path.join(dir, "a", "b");
    realDeps.mkdir(nested);
    const file = path.join(nested, "verdict.json");
    realDeps.write(file, "{}\n");
    expect(realDeps.exists(file)).toBe(true);
    expect(realDeps.exists(path.join(nested, "missing"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });

  it("spawns a real process and captures its output", () => {
    const out = realDeps.spawn(process.execPath, ["-e", "console.log('hi')"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(String(out.stdout).trim()).toBe("hi");
  });

  it("reports health as the status code, or undefined when unreachable", async () => {
    const server = await import("node:http").then(
      (http) =>
        new Promise<import("node:http").Server>((resolve) => {
          const s = http.createServer((req, res) => {
            res.statusCode = req.url === "/api/health" ? 200 : 404;
            res.end();
          });
          s.listen(0, "127.0.0.1", () => resolve(s));
        }),
    );
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      expect(await realDeps.fetchStatus(`http://127.0.0.1:${port}`)).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await realDeps.fetchStatus("http://127.0.0.1:1")).toBeUndefined();
  });

  it("logs to the console", () => {
    const seen: unknown[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void seen.push(...a);
    try {
      realDeps.log("line");
    } finally {
      console.log = original;
    }
    expect(seen).toEqual(["line"]);
  });
});
