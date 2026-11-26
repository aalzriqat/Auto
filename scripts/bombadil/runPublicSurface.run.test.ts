// SCRUM-1005: drives the whole runner in process with fake side effects, so every
// verdict path (and the exit code each one gives) is exercised without Chrome.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_POINTS,
  run as runUntyped,
  scrubbedEnv,
} from "./runner.mjs";

interface Verdict {
  verdict: string;
  reason: string;
  violations: string[];
  problems: string[];
  entries: {
    slug: string;
    states: number;
    offOriginStates: number;
    paths: string[];
  }[];
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
  /** Whether a Bombadil run leaves a trace file behind (default true). */
  traceExists?: boolean;
  /** Trace files already on disk from an earlier run. */
  stale?: boolean;
  explore?: (slug: string) => SpawnResult;
  dump?: (slug: string) => SpawnResult;
}

function rig(plan: Plan = {}) {
  const calls: { bin: string; args: string[]; env?: unknown }[] = [];
  const events: string[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  const files = new Set<string>();
  const slugOf = (arg: string) => /trace-(\w+)\.bin/.exec(arg)?.[1] ?? "";
  if (plan.stale) {
    for (const e of ENTRY_POINTS)
      files.add(path.join("out", `trace-${e.slug}.bin`));
  }
  const deps = {
    spawn: (bin: string, args: string[], options: { env?: unknown }) => {
      calls.push({ bin, args, env: options.env });
      if (args[0] === "trace") {
        const slug = slugOf(args[1] ?? "");
        return plan.dump?.(slug) ?? { status: 0, stdout: healthyDump };
      }
      const traceFile = args[args.indexOf("--output-path") + 1] ?? "";
      events.push(`spawn:${slugOf(traceFile)}`);
      if (plan.traceExists !== false) files.add(traceFile);
      return (
        plan.explore?.(slugOf(traceFile)) ?? {
          status: 0,
          stdout: "ok",
          stderr: "",
        }
      );
    },
    fetchStatus: async () => ("health" in plan ? plan.health : 200),
    exists: (file: string) =>
      /trace-\w+\.bin$/.test(file)
        ? files.has(file)
        : (plan.binaryExists ?? true),
    remove: (file: string) => {
      events.push(`remove:${slugOf(file)}`);
      files.delete(file);
    },
    mkdir: () => undefined,
    write: (file: string, text: string) => {
      written[path.basename(file)] = text;
    },
    log: (line: string) => logs.push(line),
  };
  return { deps, calls, written, logs, events };
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

  it("adds --no-sandbox only when asked, and never forwards --allow-url", async () => {
    const r = rig();
    await run(
      input({
        argv: ["--out-dir", "o"],
        env: { BOMBADIL_NO_SANDBOX: "1" },
      }),
      r.deps,
    );
    const args = r.calls.find((c) => c.args[0] === "browser")!.args;
    expect(args).toContain("--no-sandbox");
    expect(args).not.toContain("--allow-url");
  });

  it("CANNOT_RUN, nothing spawned, when --allow-url is given", async () => {
    for (const pattern of ["*://autoflowdealer.com/*", "<all_urls>"]) {
      const r = rig();
      const { result, exitCode } = await run(
        input({ argv: ["--allow-url", pattern, "--out-dir", "o"] }),
        r.deps,
      );
      expect(result.verdict).toBe("CANNOT_RUN");
      expect(result.reason).toBe("bad arguments: unknown argument --allow-url");
      expect(exitCode).toBe(1);
      expect(r.calls).toHaveLength(0);
      expect(r.written["verdict.json"]).toContain("CANNOT_RUN");
    }
  });

  it("CANNOT_RUN for a flag without a value and for an unusable base URL", async () => {
    const missing = await run(input({ argv: ["--time-limit"] }), rig().deps);
    expect(missing.result.reason).toBe(
      "bad arguments: missing value for --time-limit",
    );
    const bad = await run(
      input({ argv: ["--base-url", "not a url"] }),
      rig().deps,
    );
    expect(bad.result.verdict).toBe("CANNOT_RUN");
    expect(bad.result.reason).toContain("bad arguments");
  });

  it("refuses a production host written with trailing dots, even with --allow-host", async () => {
    for (const host of [
      "www.autoflowdealer.com.",
      "WWW.AutoFlowDealer.com..",
    ]) {
      const r = rig();
      const { result } = await run(
        input({
          argv: ["--base-url", `https://${host}/`, "--allow-host", host],
        }),
        r.deps,
      );
      expect(result.verdict).toBe("CANNOT_RUN");
      expect(result.reason).toContain("production host");
      expect(r.calls).toHaveLength(0);
    }
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
    expect(result.reason).toContain("only 0 states");
    expect(result.entries[0]).toMatchObject({ states: 0, offOriginStates: 0 });
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

  it("an unknown argument is a CANNOT_RUN verdict, not a crash or a default", async () => {
    const r = rig();
    const { result, exitCode } = await run(input({ argv: ["--nope"] }), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toBe("bad arguments: unknown argument --nope");
    expect(exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
  });

  it("counts only parsed on-origin states toward the minimum, and records the rest", async () => {
    const offOrigin = Array.from(
      { length: 9 },
      () => "https://accounts.example/x",
    );
    const r = rig({
      dump: () => ({
        status: 0,
        stdout: dumpOf([...offOrigin, `${BASE}/`]),
      }),
    });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("home: only 1 states");
    expect(result.entries[0]).toMatchObject({ states: 1, offOriginStates: 9 });
    expect(r.logs.join("\n")).toContain("off-origin 9");
  });

  it("does not count malformed lines as states", async () => {
    const lines = [
      ...Array.from({ length: 7 }, () => state(`${BASE}/`)),
      ...Array.from({ length: 5 }, () => "{broken"),
    ].join("\n");
    const r = rig({ dump: () => ({ status: 0, stdout: lines }) });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("home: only 7 states");
  });

  it("off-origin states are recorded but do not change a PASS", async () => {
    const mixed = dumpOf([
      ...Array.from({ length: 12 }, () => `${BASE}/`),
      "https://accounts.example/handshake",
      "https://accounts.example/handshake",
    ]);
    const r = rig({ dump: () => ({ status: 0, stdout: mixed }) });
    const { result, exitCode } = await run(input(), r.deps);
    expect(result.verdict).toBe("PASS");
    expect(exitCode).toBe(0);
    expect(result.entries[0]).toMatchObject({ states: 12, offOriginStates: 2 });
    expect(
      JSON.parse(r.written["verdict.json"] ?? "{}").entries[0].offOriginStates,
    ).toBe(2);
  });

  it("removes an old trace before exploring and never reads a stale one", async () => {
    const r = rig({ stale: true, traceExists: false });
    const { result } = await run(input(), r.deps);
    expect(result.verdict).toBe("CANNOT_RUN");
    expect(result.reason).toContain("only 0 states");
    expect(r.calls.some((c) => c.args[0] === "trace")).toBe(false);
    for (const e of ENTRY_POINTS) {
      expect(r.events.indexOf(`remove:${e.slug}`)).toBeGreaterThanOrEqual(0);
      expect(r.events.indexOf(`remove:${e.slug}`)).toBeLessThan(
        r.events.indexOf(`spawn:${e.slug}`),
      );
    }
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
