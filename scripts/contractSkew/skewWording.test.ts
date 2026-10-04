import { describe, expect, test } from "vitest";
import { skewSummary } from "./skewWording.mjs";

/**
 * SCRUM-178 v2 F5-3. With `--spec` the spec's origin is not known to be
 * production, so the summary must not say so and must not tell anyone to deploy.
 */
const base = { specSource: "spec-dev.json, https://vibrant-cat-418.convex.cloud", proven: 1, unclassified: 2, basis: "b" };

describe("skewSummary", () => {
  test("a SUPPLIED spec file: target-neutral wording, no deploy instruction", () => {
    const text = skewSummary({ ...base, rung: "SUPPLIED_FILE", callOutcomes: { fixed: 1, stillFails: 0, unproven: 0 } });
    expect(text).toMatch(/CONTRACT SKEW against the supplied spec \(spec-dev\.json, https:\/\/vibrant-cat-418\.convex\.cloud\)/);
    expect(text).not.toMatch(/PRODUCTION/);
    expect(text).not.toMatch(/Deploy the Convex backend/);
    expect(text).toContain("1 proven, 2 unclassified");
  });

  test("PROVEN only (no unclassified, nothing rejected elsewhere): the plain deploy instruction", () => {
    const text = skewSummary({ ...base, unclassified: 0, rung: "REPO_READ_KEY", callOutcomes: { fixed: 1, stillFails: 0, unproven: 0 } });
    expect(text).toMatch(/^PRODUCTION SKEW — 1 proven, 0 unclassified\. Deploy the Convex backend at this commit\./);
    expect(text).not.toMatch(/not proven|likely/i);
  });

  test("M-1: UNCLASSIFIED breaks make the deploy an UNPROVEN likely remedy, never the plain instruction", () => {
    // Defence in depth: even if `callOutcomes` reports nothing unproven, unclassified
    // BREAKS alone must keep the plain instruction out.
    const text = skewSummary({ ...base, rung: "REPO_READ_KEY", callOutcomes: { fixed: 1, stillFails: 0, unproven: 0 } });
    expect(text).toMatch(/^PRODUCTION SKEW — 1 proven, 2 unclassified\./);
    expect(text).toMatch(/likely remedy/);
    expect(text).toMatch(/2 break\(s\) are unclassified, so this is not proven/);
    expect(text).not.toMatch(/Deploy the Convex backend at this commit\./);
    expect(text).toContain("Basis: b");
  });

  test("M-1: only-unclassified (0 proven) is likewise not proven", () => {
    const text = skewSummary({ ...base, proven: 0, unclassified: 1, rung: "ENV_KEY", callOutcomes: { fixed: 0, stillFails: 0, unproven: 1 } });
    expect(text).toMatch(/likely remedy/);
    expect(text).toMatch(/not proven/);
    expect(text).not.toMatch(/Deploy the Convex backend at this commit\./);
  });

  test("rejected elsewhere only: the instruction is withheld", () => {
    const rejected = [{ identifier: "w:save", path: "tag", file: "a.ts", line: 3, currentRejects: [{ path: "other" }] }];
    const text = skewSummary({ ...base, proven: 1, unclassified: 0, rung: "ENV_KEY", rejectedElsewhere: rejected, callOutcomes: { fixed: 0, stillFails: 1, unproven: 0 } });
    expect(text).not.toMatch(/Deploy the Convex backend|likely remedy/);
    expect(text).toMatch(/will not make 1 of these call\(s\) succeed/);
  });

  test("L-1: ACCEPTED + REJECTED_OTHER together: says what a deploy fixes AND lists what will still fail", () => {
    const rejected = [{ identifier: "w:save", path: "tag", file: "a.ts", line: 3, currentRejects: [{ path: "other" }] }];
    const text = skewSummary({ ...base, proven: 3, unclassified: 0, rung: "ENV_KEY", rejectedElsewhere: rejected, callOutcomes: { fixed: 2, stillFails: 1, unproven: 0 } });
    expect(text).toMatch(/Deploying the Convex backend at this commit fixes 2 call\(s\)/);
    expect(text).toMatch(/1 call\(s\) will still fail/);
    expect(text).toContain("w:save");
    expect(text).toContain("other");
    expect(text).not.toMatch(/Deploy the Convex backend at this commit\./);
  });

  test("U-7: a call that still fails only because of a standing defect does not claim 'the current spec still refuses them'", () => {
    const callOutcomes = { fixed: 0, stillFails: 1, unproven: 0 };
    const supplied = skewSummary({ ...base, proven: 1, unclassified: 0, rung: "SUPPLIED_FILE", callOutcomes });
    expect(supplied).toMatch(/Deploying the backend alone will not make 1 call\(s\) succeed, because a standing defect sits at the same call/);
    expect(supplied).not.toMatch(/current spec still refuses/);
    const production = skewSummary({ ...base, proven: 1, unclassified: 0, rung: "ENV_KEY", callOutcomes: { ...callOutcomes, fixed: 1 } });
    expect(production).toMatch(/fixes 1 call\(s\), but 1 call\(s\) will still fail because a standing defect sits at the same call/);
    expect(production).not.toMatch(/current spec also refuses/);
  });

  test("U-5 (N7-6): callOutcomes is required; a missing or invalid value throws instead of falling back to one-break-is-one-call", () => {
    const input = { ...base, proven: 1, unclassified: 0, rung: "ENV_KEY" };
    expect(() => skewSummary(input as never)).toThrow(/callOutcomes/);
    expect(() => skewSummary({ ...input, callOutcomes: undefined } as never)).toThrow(/callOutcomes/);
    expect(() => skewSummary({ ...input, callOutcomes: { fixed: 1 } } as never)).toThrow(/callOutcomes/);
    expect(() => skewSummary({ ...input, callOutcomes: { fixed: -1, stillFails: 0, unproven: 0 } } as never)).toThrow(/callOutcomes/);
    expect(() => skewSummary({ ...input, callOutcomes: { fixed: 1.5, stillFails: 0, unproven: 0 } } as never)).toThrow(/callOutcomes/);
  });
});
