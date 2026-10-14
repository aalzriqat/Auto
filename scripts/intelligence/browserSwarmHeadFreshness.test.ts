import { describe, expect, it } from "vitest";
import {
  assertSwarmHeadFresh,
  evaluateHeadFreshness,
  parseLsRemoteRefs,
} from "./browserSwarmHeadFreshness.mjs";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const OTHER = "c".repeat(40);
const PR = "510";

const lsRemote = (head: string | undefined, merge: string | undefined): string =>
  [
    head ? head + "\trefs/pull/" + PR + "/head" : "",
    merge ? merge + "\trefs/pull/" + PR + "/merge" : "",
  ]
    .filter(Boolean)
    .join("\n") + "\n";

const baseEnv = {
  GITHUB_TOKEN: "ghs_secret_token_value",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "owner/repo",
  PR_NUMBER: PR,
  EXPECTED_HEAD_SHA: HEAD,
  EXPECTED_TESTED_SHA: MERGE,
};

describe("SCRUM-777 swarm head freshness", () => {
  it("parses only the two PR refs and ignores everything else", () => {
    const refs = parseLsRemoteRefs(lsRemote(HEAD, MERGE) + OTHER + "\trefs/heads/main\n");
    expect(refs.get("refs/pull/" + PR + "/head")).toBe(HEAD);
    expect(refs.get("refs/pull/" + PR + "/merge")).toBe(MERGE);
    expect(refs.size).toBe(2);
  });

  it("accepts a run whose live PR head and merge both equal the tested ones", () => {
    expect(
      evaluateHeadFreshness({
        prNumber: PR,
        expectedHeadSha: HEAD,
        expectedTestedSha: MERGE,
        refs: parseLsRemoteRefs(lsRemote(HEAD, MERGE)),
      }),
    ).toEqual({ fresh: true, reason: "PR head and merge are the tested ones." });
  });

  it("NEGATIVE CONTROL: a superseded PR head is stale, never fresh", () => {
    const result = evaluateHeadFreshness({
      prNumber: PR,
      expectedHeadSha: HEAD,
      expectedTestedSha: MERGE,
      refs: parseLsRemoteRefs(lsRemote(OTHER, MERGE)),
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/head/i);
  });

  it("NEGATIVE CONTROL: a recomputed merge commit (main moved) is stale", () => {
    const result = evaluateHeadFreshness({
      prNumber: PR,
      expectedHeadSha: HEAD,
      expectedTestedSha: MERGE,
      refs: parseLsRemoteRefs(lsRemote(HEAD, OTHER)),
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/merge/i);
  });

  it("NEGATIVE CONTROL: an unreadable ref is unavailable, which is not fresh", () => {
    for (const refs of [lsRemote(HEAD, undefined), lsRemote(undefined, MERGE), ""]) {
      expect(
        evaluateHeadFreshness({
          prNumber: PR,
          expectedHeadSha: HEAD,
          expectedTestedSha: MERGE,
          refs: parseLsRemoteRefs(refs),
        }).fresh,
      ).toBe(false);
    }
  });

  it("NEGATIVE CONTROL: malformed expectations never certify", () => {
    const refs = parseLsRemoteRefs(lsRemote(HEAD, MERGE));
    for (const bad of [
      { prNumber: "abc", expectedHeadSha: HEAD, expectedTestedSha: MERGE },
      { prNumber: PR, expectedHeadSha: "", expectedTestedSha: MERGE },
      { prNumber: PR, expectedHeadSha: HEAD, expectedTestedSha: "short" },
    ]) {
      expect(evaluateHeadFreshness({ ...bad, refs }).fresh).toBe(false);
    }
  });

  it("resolves when fresh and asks git only for this PR's two refs, with the token in a header and not the URL", () => {
    const calls: { file: string; args: string[] }[] = [];
    const result = assertSwarmHeadFresh(baseEnv, (file: string, args: string[]) => {
      calls.push({ file, args });
      return lsRemote(HEAD, MERGE);
    });
    expect(result.fresh).toBe(true);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args).toContain("ls-remote");
    expect(args).toContain("refs/pull/" + PR + "/head");
    expect(args).toContain("refs/pull/" + PR + "/merge");
    expect(args).toContain("https://github.com/owner/repo.git");
    const header = args.find((arg) => arg.startsWith("http.extraheader="));
    expect(header).toBeDefined();
    expect(args.filter((arg) => arg.includes("ghs_secret_token_value"))).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: a stale head makes the assertion throw", () => {
    expect(() =>
      assertSwarmHeadFresh(baseEnv, () => lsRemote(OTHER, MERGE)),
    ).toThrow(/stale/i);
  });

  it("NEGATIVE CONTROL: a git failure throws and never leaks the token", () => {
    let thrown: unknown;
    try {
      assertSwarmHeadFresh(baseEnv, () => {
        throw new Error("fatal: could not read https://x:ghs_secret_token_value@github.com");
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).not.toContain("ghs_secret_token_value");
  });

  it("NEGATIVE CONTROL: a missing token or repository throws before any git call", () => {
    for (const key of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER"] as const) {
      let called = false;
      expect(() =>
        assertSwarmHeadFresh({ ...baseEnv, [key]: "" }, () => {
          called = true;
          return lsRemote(HEAD, MERGE);
        }),
      ).toThrow();
      expect(called).toBe(false);
    }
  });
});
