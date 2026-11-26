import { describe, expect, it } from "vitest";
import {
  countStates,
  decideVerdict,
  hostRefusal,
  scrubbedEnv,
  violatedNames,
} from "./runPublicSurface.mjs";

const ok = {
  platform: "linux",
  arch: "x64",
  hostname: "127.0.0.1",
  healthStatus: 200,
  exitCode: 0,
  stateCount: 50,
  minStates: 20,
};

describe("decideVerdict", () => {
  it("PASS: exit 0 and enough states", () => {
    expect(decideVerdict(ok).verdict).toBe("PASS");
  });
  it("PASS at exactly the minimum", () => {
    expect(decideVerdict({ ...ok, stateCount: 20 }).verdict).toBe("PASS");
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
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(hostRefusal(h, undefined), h).toBeNull();
    }
  });
  it("CANNOT_RUN when health is not 200", () => {
    expect(decideVerdict({ ...ok, healthStatus: 503 }).verdict).toBe(
      "CANNOT_RUN",
    );
    expect(decideVerdict({ ...ok, healthStatus: undefined }).verdict).toBe(
      "CANNOT_RUN",
    );
  });
  it("CANNOT_RUN when the binary cannot start", () => {
    expect(decideVerdict({ ...ok, spawnError: "ENOENT" }).verdict).toBe(
      "CANNOT_RUN",
    );
  });
  it("CANNOT_RUN on zero or too few states even with exit 0", () => {
    expect(decideVerdict({ ...ok, stateCount: 0 }).verdict).toBe("CANNOT_RUN");
    expect(decideVerdict({ ...ok, stateCount: 19 }).verdict).toBe("CANNOT_RUN");
  });
  it("CANNOT_RUN on exit 1 (other error)", () => {
    expect(decideVerdict({ ...ok, exitCode: 1 }).verdict).toBe("CANNOT_RUN");
    expect(decideVerdict({ ...ok, exitCode: undefined }).verdict).toBe(
      "CANNOT_RUN",
    );
  });
  it("FAIL on exit 2 and carries the violated names", () => {
    const r = decideVerdict({
      ...ok,
      exitCode: 2,
      violations: ["noBrokenValueText"],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.violations).toEqual(["noBrokenValueText"]);
  });
});

describe("helpers", () => {
  it("counts only JSON object lines as states", () => {
    expect(countStates('{"a":1}\nnoise\n{"b":2}\n')).toBe(2);
    expect(countStates("")).toBe(0);
  });
  it("reads violated property names defensively", () => {
    const text =
      '{"index":0,"metadata":{"violations":[{"name":"p1","violation":{}}]}}\n' +
      '{"index":1,"metadata":{"violations":[{"name":"p1"},{"property":"p2"}]}}\nnot json\n{"index":2,"metadata":{"violations":[]}}';
    expect(violatedNames(text).sort()).toEqual(["p1", "p2"]);
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
});
