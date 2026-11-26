import { describe, expect, it } from "vitest";
import {
  ENTRY_POINTS,
  MIN_STATES_PER_ENTRY,
  countStates,
  decideVerdict,
  hostRefusal,
  parseArgs,
  preflightRefusal,
  perEntrySeconds,
  scrubbedEnv,
  timeLimitSeconds,
  violatedNames,
  visitedPaths,
} from "./runPublicSurface.mjs";

const entry = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  exitCode: 0,
  states: 50,
  paths: ["/"],
  violations: [] as string[],
  ...over,
});
const allGood = () => ENTRY_POINTS.map((e) => entry(e.slug));
const ok = {
  platform: "linux",
  arch: "x64",
  hostname: "127.0.0.1",
  healthStatus: 200,
  entries: allGood(),
};

describe("decideVerdict preflight", () => {
  it("PASS when every entry exits 0 with enough states", () => {
    expect(decideVerdict(ok).verdict).toBe("PASS");
  });
  it("CANNOT_RUN on an unsupported platform (Windows has no binary)", () => {
    expect(decideVerdict({ ...ok, platform: "win32" }).verdict).toBe(
      "CANNOT_RUN",
    );
    expect(
      decideVerdict({ ...ok, platform: "darwin", arch: "x64" }).verdict,
    ).toBe("CANNOT_RUN");
  });
  it("CANNOT_RUN on a non-loopback host unless named", () => {
    const remote = { ...ok, hostname: "staging.example.org" };
    expect(decideVerdict(remote).verdict).toBe("CANNOT_RUN");
    expect(
      decideVerdict({ ...remote, allowHost: "staging.example.org" }).verdict,
    ).toBe("PASS");
    expect(
      decideVerdict({ ...remote, allowHost: "other.example.org" }).verdict,
    ).toBe("CANNOT_RUN");
  });
  it("CANNOT_RUN on a production host even when named", () => {
    for (const hostname of [
      "www.autoflowdealer.com",
      "autoflowdealer.com",
      "x.convex.cloud",
      "y.convex.site",
      "z.vercel.app",
    ]) {
      const r = decideVerdict({ ...ok, hostname, allowHost: hostname });
      expect(r.verdict, hostname).toBe("CANNOT_RUN");
      expect(r.reason).toContain("production");
    }
  });
  it("accepts every loopback spelling", () => {
    for (const h of ["127.0.0.1", "localhost", "[::1]"])
      expect(hostRefusal(h, undefined), h).toBeNull();
  });
  it("CANNOT_RUN on a minimum-states value that is not a whole number >= 1", () => {
    for (const bad of [Number("abc"), 0, -1, 1.5]) {
      const r = decideVerdict({ ...ok, minStates: bad });
      expect(r.verdict, String(bad)).toBe("CANNOT_RUN");
      expect(r.reason).toContain("bad minimum states");
    }
    expect(decideVerdict({ ...ok, minStates: 1 }).verdict).toBe("PASS");
  });
  it("CANNOT_RUN when health is not 200", () => {
    expect(decideVerdict({ ...ok, healthStatus: 503 }).verdict).toBe(
      "CANNOT_RUN",
    );
    expect(decideVerdict({ ...ok, healthStatus: undefined }).verdict).toBe(
      "CANNOT_RUN",
    );
  });
  it("CANNOT_RUN when no entry was explored", () => {
    expect(decideVerdict({ ...ok, entries: [] }).verdict).toBe("CANNOT_RUN");
  });
});

describe("decideVerdict aggregation", () => {
  const with_ = (slug: string, over: Record<string, unknown>) =>
    ENTRY_POINTS.map((e) =>
      e.slug === slug ? entry(slug, over) : entry(e.slug),
    );

  it("PASS at exactly the per-entry minimum", () => {
    expect(
      decideVerdict({
        ...ok,
        entries: with_("terms", { states: MIN_STATES_PER_ENTRY }),
      }).verdict,
    ).toBe("PASS");
  });
  it("CANNOT_RUN when one entry is starved, naming it", () => {
    const r = decideVerdict({
      ...ok,
      entries: with_("contact", { states: MIN_STATES_PER_ENTRY - 1 }),
    });
    expect(r.verdict).toBe("CANNOT_RUN");
    expect(r.reason).toContain("contact");
  });
  it("CANNOT_RUN on zero states even with exit 0", () => {
    expect(
      decideVerdict({ ...ok, entries: with_("home", { states: 0 }) }).verdict,
    ).toBe("CANNOT_RUN");
  });
  it("CANNOT_RUN when one entry exits 1, when the binary cannot start, or when the exit code is missing", () => {
    expect(
      decideVerdict({ ...ok, entries: with_("privacy", { exitCode: 1 }) })
        .verdict,
    ).toBe("CANNOT_RUN");
    expect(
      decideVerdict({
        ...ok,
        entries: with_("privacy", { spawnError: "ENOENT" }),
      }).verdict,
    ).toBe("CANNOT_RUN");
    expect(
      decideVerdict({
        ...ok,
        entries: with_("privacy", { exitCode: undefined }),
      }).verdict,
    ).toBe("CANNOT_RUN");
  });
  it("FAIL on exit 2, listing entry and property names", () => {
    const r = decideVerdict({
      ...ok,
      entries: with_("marketplace", {
        exitCode: 2,
        violations: ["noBrokenValueText"],
      }),
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.violations).toEqual(["marketplace: noBrokenValueText"]);
  });
  it("FAIL when a violation was recorded but the run then exited 1", () => {
    const r = decideVerdict({
      ...ok,
      entries: with_("marketplace", {
        exitCode: 1,
        violations: ["noHttpErrorCodes"],
      }),
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.violations).toEqual(["marketplace: noHttpErrorCodes"]);
    expect(r.problems).toEqual([expect.stringContaining("exited with code 1")]);
  });
  it("FAIL wins over CANNOT_RUN and still lists the CANNOT_RUN detail", () => {
    const entries = ENTRY_POINTS.map((e) =>
      e.slug === "home"
        ? entry("home", { exitCode: 2, violations: ["p"] })
        : e.slug === "terms"
          ? entry("terms", { states: 1 })
          : entry(e.slug),
    );
    const r = decideVerdict({ ...ok, entries });
    expect(r.verdict).toBe("FAIL");
    expect(r.problems).toEqual([expect.stringContaining("terms")]);
  });
  it("keeps every entry in the result", () => {
    expect(decideVerdict(ok).entries).toHaveLength(ENTRY_POINTS.length);
  });
});

describe("helpers", () => {
  const trace = [
    '{"index":0,"metadata":{"state":{"url":"http://127.0.0.1:3000/contact?x=1#h"},"violations":[{"name":"p1","violation":{}}]}}',
    '{"index":1,"metadata":{"state":{"url":"http://127.0.0.1:3000/privacy"},"violations":[{"name":"p1"},{"property":"p2"}]}}',
    "not json",
    '{"index":2,"metadata":{"state":{"url":"chrome-error://chromewebdata/"},"violations":[]}}',
  ].join("\n");
  it("counts only JSON object lines as states", () => {
    expect(countStates(trace)).toBe(3);
    expect(countStates("")).toBe(0);
  });
  it("reads violated names from metadata.violations", () => {
    expect(violatedNames(trace).sort()).toEqual(["p1", "p2"]);
  });
  it("lists distinct pathnames and ignores chrome-error pages", () => {
    expect(visitedPaths(trace)).toEqual(["/contact", "/privacy"]);
  });
  it("splits the total time limit evenly across the entry points", () => {
    expect(timeLimitSeconds("5m")).toBe(300);
    expect(timeLimitSeconds("90s")).toBe(90);
    expect(Number.isNaN(timeLimitSeconds("soon"))).toBe(true);
    expect(perEntrySeconds(300)).toBe(60);
    expect(perEntrySeconds(20)).toBe(10);
  });
  it("scrubs the environment to PATH, HOME and LANG", () => {
    expect(
      scrubbedEnv({
        PATH: "/bin",
        HOME: "/h",
        LANG: "C",
        CLERK_SECRET_KEY: "x",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "y",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C" });
  });
  it("keeps the sandbox on unless BOMBADIL_NO_SANDBOX=1", () => {
    expect(parseArgs([], {}).noSandbox).toBe(false);
    expect(parseArgs([], { BOMBADIL_NO_SANDBOX: "1" }).noSandbox).toBe(true);
    expect(parseArgs([], { BOMBADIL_NO_SANDBOX: "true" }).noSandbox).toBe(
      false,
    );
  });
});

describe("an entry must have visited the target origin", () => {
  it("CANNOT_RUN when every state was an error page (no on-origin path)", () => {
    const entries = allGood();
    entries[1] = entry("marketplace", { paths: [] });
    const r = decideVerdict({ ...ok, entries });
    expect(r.verdict).toBe("CANNOT_RUN");
    expect(r.reason).toContain("marketplace");
    expect(r.reason).toContain("target origin");
  });
  it("FAIL still wins over a starved entry", () => {
    const entries = allGood();
    entries[0] = entry("home", { paths: [] });
    entries[2] = entry("contact", {
      exitCode: 2,
      violations: ["noConsoleErrors"],
    });
    const r = decideVerdict({ ...ok, entries });
    expect(r.verdict).toBe("FAIL");
    expect(r.problems.join(" ")).toContain("home");
  });
  it("visitedPaths keeps only http(s) URLs on the given origin", () => {
    const line = (url: string) =>
      JSON.stringify({ metadata: { state: { url } } });
    const dump = [
      line("http://127.0.0.1:3000/terms?a=1"),
      line("http://127.0.0.1:30001/other"),
      line("chrome-error://chromewebdata/"),
      line("https://example.org/x"),
    ].join("\n");
    expect(visitedPaths(dump, "http://127.0.0.1:3000")).toEqual(["/terms"]);
    expect(visitedPaths(dump, "http://127.0.0.1:3000/ignored/path")).toEqual([
      "/terms",
    ]);
    expect(visitedPaths(dump)).toEqual(["/other", "/terms", "/x"]);
  });
});

describe("preflightRefusal (what main runs before any exploration)", () => {
  const facts = { platform: "linux", arch: "x64", hostname: "127.0.0.1" };
  it("is null on a supported platform and a loopback host", () => {
    expect(preflightRefusal(facts)).toBeNull();
  });
  it("is CANNOT_RUN on an unsupported platform", () => {
    expect(preflightRefusal({ ...facts, platform: "win32" })?.verdict).toBe(
      "CANNOT_RUN",
    );
  });
  it("is CANNOT_RUN on a production host and a bad minimum", () => {
    expect(
      preflightRefusal({ ...facts, hostname: "www.autoflowdealer.com" })
        ?.verdict,
    ).toBe("CANNOT_RUN");
    expect(preflightRefusal({ ...facts, minStates: 0 })?.verdict).toBe(
      "CANNOT_RUN",
    );
  });
});
