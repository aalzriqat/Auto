import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { acceptanceAt, ACCEPTANCE, breakKey, classifyRelease, findingKey } from "./compare.mjs";
import { classifyAgainstCurrent, alertsFor, CLASSIFICATION } from "./classify.mjs";
import { skewSummary } from "./skewWording.mjs";

/**
 * SCRUM-178 v2 batch 5 (D-30). ONE INVARIANT:
 *
 *   A deployed break is "fixed" by spec X (current or candidate) only when X is
 *   comparable at that same call (same siteId) and accepts it at the cited break
 *   path. The absence of a break is not acceptance.
 *
 * These pin the helper both classifiers share, and the identity it keys on.
 */

const SITE_A = "app/x.tsx:1:10";
const SITE_B = "app/x.tsx:1:30";

type Finding = Record<string, unknown>;
const at = (siteId: string | undefined, path: string, extra: Finding = {}): Finding => ({
  severity: "BREAKING",
  dimension: "VALUE",
  identifier: "w:save",
  path,
  file: "app/x.tsx",
  line: 1,
  surface: "web",
  detail: "…",
  ...(siteId === undefined ? {} : { siteId }),
  ...extra,
});
const gapAt = (siteId: string, path: string) => at(siteId, path, { severity: "COVERAGE_GAP", dimension: "SHAPE" });
const unknownAt = (siteId: string, path: string) => at(siteId, path, { severity: "TYPE_UNKNOWN" });
const other = (parts: { breaking?: Finding[]; gaps?: Finding[]; needsEvidence?: Finding[] }) => ({
  breaking: [],
  gaps: [],
  needsEvidence: [],
  ...parts,
});

describe("B4-1: the identity of a break includes the call site", () => {
  test("two calls on the SAME line at different columns have different keys", () => {
    expect(breakKey(at(SITE_A, "tag"))).not.toBe(breakKey(at(SITE_B, "tag")));
  });

  test("the SAME call compared against two specs keeps an equal key (detail is not identity)", () => {
    expect(breakKey(at(SITE_A, "tag", { detail: "against deployed" }))).toBe(
      breakKey(at(SITE_A, "tag", { detail: "against current" }))
    );
  });

  test("a finding with no siteId never matches another finding", () => {
    expect(breakKey(at(undefined, "tag"))).not.toBe(breakKey(at(undefined, "tag")));
    expect(breakKey(at(undefined, "tag"))).not.toBe(breakKey(at(SITE_A, "tag")));
  });

  test("a finding with no siteId still equals ITSELF (it can sit in a Set)", () => {
    const f = at(undefined, "tag");
    expect(breakKey(f)).toBe(breakKey(f));
  });

  test("findingKey over a list naming siteId has the same rule; a list without it is unchanged", () => {
    const fields = ["surface", "file", "line", "identifier", "path", "siteId"] as const;
    expect(findingKey(at(undefined, "p"), fields)).not.toBe(findingKey(at(undefined, "p"), fields));
    expect(findingKey(at(undefined, "p"), ["identifier", "path"])).toBe(findingKey(at(undefined, "p"), ["identifier", "path"]));
  });
});

describe("B4-2 / N-1: acceptanceAt(finding, otherResult)", () => {
  const A = at(SITE_A, "tag");

  test("ACCEPTED: nothing at that site", () => {
    expect(acceptanceAt(A, other({})).disposition).toBe(ACCEPTANCE.ACCEPTED);
  });

  test("REJECTED_SAME: the same break identity", () => {
    const got = acceptanceAt(A, other({ breaking: [at(SITE_A, "tag", { detail: "other wording" })] }));
    expect(got.disposition).toBe(ACCEPTANCE.REJECTED_SAME);
  });

  test("REJECTED_OTHER: a break at the same site on a different path", () => {
    const got = acceptanceAt(A, other({ breaking: [at(SITE_A, "other")] }));
    expect(got.disposition).toBe(ACCEPTANCE.REJECTED_OTHER);
    expect(got.rejectedAt.map((f: Finding) => f.path)).toEqual(["other"]);
  });

  test("REJECTED_OTHER: a break at the same site on a different dimension", () => {
    const got = acceptanceAt(A, other({ breaking: [at(SITE_A, "tag", { dimension: "SHAPE" })] }));
    expect(got.disposition).toBe(ACCEPTANCE.REJECTED_OTHER);
  });

  test("REJECTED_OTHER: a break at <function> on the same site", () => {
    const got = acceptanceAt(A, other({ breaking: [at(SITE_A, "<function>", { dimension: "SHAPE" })] }));
    expect(got.disposition).toBe(ACCEPTANCE.REJECTED_OTHER);
  });

  test("a break at a DIFFERENT site on the same line is not this call's (two-site isolation)", () => {
    expect(acceptanceAt(A, other({ breaking: [at(SITE_B, "tag")] })).disposition).toBe(ACCEPTANCE.ACCEPTED);
    expect(acceptanceAt(A, other({ gaps: [gapAt(SITE_B, "<function>")] })).disposition).toBe(ACCEPTANCE.ACCEPTED);
  });

  test("the same break identity at ANOTHER site is not REJECTED_SAME", () => {
    // Same function, path and dimension, same line - only the column differs.
    expect(acceptanceAt(A, other({ breaking: [at(SITE_B, "tag")] })).disposition).not.toBe(ACCEPTANCE.REJECTED_SAME);
  });

  describe("UNPROVEN: a gap or unknown at the same site", () => {
    const finding = at(SITE_A, "vehicles[*].rowId");
    test.each([
      ["same path", "vehicles[*].rowId"],
      ["ancestor path", "vehicles[*]"],
      ["descendant path", "vehicles[*].rowId.inner"],
      ["<function>", "<function>"],
    ])("a gap at the %s", (_name, p) => {
      expect(acceptanceAt(finding, other({ gaps: [gapAt(SITE_A, p)] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
    });
    test.each([
      ["same path", "vehicles[*].rowId"],
      ["ancestor path", "vehicles[*]"],
      ["descendant path", "vehicles[*].rowId.inner"],
      ["<function>", "<function>"],
    ])("an unknown (needsEvidence) at the %s", (_name, p) => {
      expect(acceptanceAt(finding, other({ needsEvidence: [unknownAt(SITE_A, p)] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
    });

    test("an unknown at an unrelated SIBLING path does not make it UNPROVEN: acceptance is judged at the cited path", () => {
      expect(acceptanceAt(finding, other({ needsEvidence: [unknownAt(SITE_A, "vehicles[*].valuations[*]")] })).disposition).toBe(
        ACCEPTANCE.ACCEPTED
      );
    });

    test("a gap or unknown at ANOTHER site is not this call's", () => {
      expect(acceptanceAt(finding, other({ gaps: [gapAt(SITE_B, "<function>")] })).disposition).toBe(ACCEPTANCE.ACCEPTED);
      expect(acceptanceAt(finding, other({ needsEvidence: [unknownAt(SITE_B, "vehicles[*].rowId")] })).disposition).toBe(
        ACCEPTANCE.ACCEPTED
      );
    });

    test("a <function> finding is judged at <function>: an unknown on a field is not its path", () => {
      const fn = at(SITE_A, "<function>", { dimension: "SHAPE" });
      expect(acceptanceAt(fn, other({ needsEvidence: [unknownAt(SITE_A, "orgId")] })).disposition).toBe(ACCEPTANCE.ACCEPTED);
      expect(acceptanceAt(fn, other({ gaps: [gapAt(SITE_A, "<function>")] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
    });
  });

  test("a finding with NO siteId is UNPROVEN, never ACCEPTED", () => {
    expect(acceptanceAt(at(undefined, "tag"), other({})).disposition).toBe(ACCEPTANCE.UNPROVEN);
    expect(acceptanceAt(at(undefined, "tag"), other({ breaking: [at(undefined, "tag")] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
  });

  test("an other-side finding with NO siteId on the same function and line makes the call UNPROVEN, not ACCEPTED", () => {
    expect(acceptanceAt(A, other({ breaking: [at(undefined, "tag")] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
  });

  describe("precedence: REJECTED_SAME > REJECTED_OTHER > UNPROVEN > ACCEPTED", () => {
    const same = at(SITE_A, "tag");
    const elsewhere = at(SITE_A, "other");
    const gap = gapAt(SITE_A, "<function>");
    test("same beats other, gap", () => {
      expect(acceptanceAt(A, other({ breaking: [elsewhere, same], gaps: [gap] })).disposition).toBe(ACCEPTANCE.REJECTED_SAME);
    });
    test("other beats a gap", () => {
      expect(acceptanceAt(A, other({ breaking: [elsewhere], gaps: [gap] })).disposition).toBe(ACCEPTANCE.REJECTED_OTHER);
    });
    test("a gap beats nothing", () => {
      expect(acceptanceAt(A, other({ gaps: [gap] })).disposition).toBe(ACCEPTANCE.UNPROVEN);
    });
  });
});

describe("classifyAgainstCurrent routes each disposition", () => {
  const deployedA = at(SITE_A, "tag");

  test("REJECTED_SAME -> STANDING_DEFECT", () => {
    const got = classifyAgainstCurrent([deployedA], other({ breaking: [at(SITE_A, "tag")] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.STANDING_DEFECT);
  });

  test("B4-1: the same function, path and dimension on the same line but ANOTHER column is not a standing defect", () => {
    // Deployed rejects A; current accepts A and rejects B. The old key (no siteId)
    // read B's break as A's, called A standing, and never exited 7.
    const got = classifyAgainstCurrent([deployedA], other({ breaking: [at(SITE_B, "tag")] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.REVISION_SKEW);
    expect(got.rejectedElsewhere).toHaveLength(0);
  });

  test("REJECTED_OTHER stays REVISION_SKEW but is named, with the current break, and is not deployable", () => {
    const got = classifyAgainstCurrent([deployedA], other({ breaking: [at(SITE_A, "other", { detail: "current says no" })] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.REVISION_SKEW);
    expect(got.rejectedElsewhere).toHaveLength(1);
    expect(got.classified[0].currentRejects[0]).toMatchObject({ path: "other", detail: "current says no" });
  });

  test("UNPROVEN -> COVERAGE_INCOMPLETE", () => {
    const got = classifyAgainstCurrent([deployedA], other({ gaps: [gapAt(SITE_A, "<function>")] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.COVERAGE_INCOMPLETE);
    expect(got.uncertain).toHaveLength(1);
  });

  test("two-site isolation: a current gap at site B leaves site A's skew a skew", () => {
    const got = classifyAgainstCurrent([deployedA], other({ gaps: [gapAt(SITE_B, "<function>")] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.REVISION_SKEW);
    expect(got.uncertain).toHaveLength(0);
  });

  test("a missing siteId is never STANDING and never skew: it is COVERAGE_INCOMPLETE", () => {
    const got = classifyAgainstCurrent([at(undefined, "tag")], other({ breaking: [at(undefined, "tag")] }));
    expect(got.classified[0].classification).toBe(CLASSIFICATION.COVERAGE_INCOMPLETE);
  });
});

describe("classifyRelease: only ACCEPTED is fixed; UNPROVEN is indeterminate", () => {
  const deployed = (breaking: Finding[]) => ({ breaking });
  const none: Array<{ identifier: string; path: string }> = [];

  test("the candidate truly accepts -> fixed", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({}), none);
    expect(got.fixedByCandidate).toHaveLength(1);
    expect(got.indeterminate).toHaveLength(0);
  });

  test("the candidate has a GAP at that call -> indeterminate, NOT fixed", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({ gaps: [gapAt(SITE_A, "<function>")] }), none);
    expect(got.fixedByCandidate).toHaveLength(0);
    expect(got.indeterminate).toHaveLength(1);
  });

  test("the candidate has an UNKNOWN on the cited path -> indeterminate, NOT fixed", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({ needsEvidence: [unknownAt(SITE_A, "tag")] }), none);
    expect(got.fixedByCandidate).toHaveLength(0);
    expect(got.indeterminate).toHaveLength(1);
  });

  test("the candidate rejects the call at another path -> neither fixed nor indeterminate (it is a release break)", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({ breaking: [at(SITE_A, "other")] }), none);
    expect(got.fixedByCandidate).toHaveLength(0);
    expect(got.indeterminate).toHaveLength(0);
    expect(got.releaseBreaks).toHaveLength(1);
  });

  test("two-site isolation: a candidate gap at site B does not touch site A's fix", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({ gaps: [gapAt(SITE_B, "<function>")] }), none);
    expect(got.fixedByCandidate).toHaveLength(1);
    expect(got.indeterminate).toHaveLength(0);
  });

  test("a candidate break at ANOTHER column on the same line does not make site A 'standing'", () => {
    const got = classifyRelease(deployed([at(SITE_A, "tag")]), other({ breaking: [at(SITE_B, "tag")] }), none);
    expect(got.fixedByCandidate).toHaveLength(1);
    expect(got.standingAgainstBoth).toHaveLength(0);
    expect(got.releaseBreaks).toHaveLength(1);
  });
});

describe("L-2 (batch 6): a <root> unknown is relevant to a <function> break", () => {
  const fnBreak = at(SITE_A, "<function>");

  test("a <root> unknown at the SAME site makes a <function> break UNPROVEN", () => {
    const got = acceptanceAt(fnBreak, { needsEvidence: [unknownAt(SITE_A, "<root>")] });
    expect(got.disposition).toBe(ACCEPTANCE.UNPROVEN);
  });

  test("control: a <root> unknown at ANOTHER site leaves it ACCEPTED", () => {
    const got = acceptanceAt(fnBreak, { needsEvidence: [unknownAt(SITE_B, "<root>")] });
    expect(got.disposition).toBe(ACCEPTANCE.ACCEPTED);
  });
});

describe("Q4: the exit-7 deploy instruction is conditional on the per-site disposition", () => {
  const base = { rung: "ENV_KEY", specSource: "", proven: 2, unclassified: 0, basis: "b" };

  test("nothing rejected elsewhere (or no current spec): the deploy instruction is given", () => {
    expect(skewSummary({ ...base, rejectedElsewhere: [] })).toMatch(/Deploy the Convex backend at this commit/);
    expect(skewSummary(base)).toMatch(/Deploy the Convex backend at this commit/);
  });

  test("any REJECTED_OTHER: no deploy instruction, the calls are listed, and it says deploying will not fix them", () => {
    const rejected = [
      { ...at(SITE_A, "tag"), currentRejects: [at(SITE_A, "other", { detail: "current still says no" })] },
    ];
    // `rejectedElsewhere` is a subset of the proven skew, so the only proven call is the rejected one.
    const text = skewSummary({ ...base, proven: 1, rejectedElsewhere: rejected });
    expect(text).not.toMatch(/Deploy the Convex backend/);
    expect(text).toMatch(/will not (make|fix)/i);
    expect(text).toContain("w:save");
    expect(text).toContain("other");
  });

  test("a supplied spec file stays free of deploy advice, and names rejected calls too", () => {
    const rejected = [{ ...at(SITE_A, "tag"), currentRejects: [at(SITE_A, "other")] }];
    const text = skewSummary({ ...base, rung: "SUPPLIED_FILE", rejectedElsewhere: rejected });
    expect(text).not.toMatch(/Deploy the Convex backend/);
    expect(text).toContain("w:save");
  });

  test("alertsFor does not say the deployed backend is simply 'behind' for calls current also rejects", () => {
    const rejected = at(SITE_A, "tag");
    const alert = alertsFor(
      { revisionSkew: [rejected], standingDefects: [], unclassified: [], rejectedElsewhere: [rejected] } as never,
      false,
      0,
      0
    );
    expect(alert.productionSkew).toBe(true);
    expect(alert.summary).not.toMatch(/behind the current one/);
    expect(alert.summary).toMatch(/will not fix/i);
  });

  test("the workflow's exit-7 line and the alert issue body do not unconditionally instruct a deploy", () => {
    const text = fs.readFileSync(path.resolve(".github/workflows/contract-skew.yml"), "utf8");
    const exit7 = text.split("\n").find((l) => /^\s*7\)/.test(l)) ?? "";
    expect(exit7).not.toBe("");
    expect(exit7).not.toMatch(/Deploy the Convex backend at this commit\./);
    expect(exit7).toMatch(/CLI/);
    const body = text.split("\n").find((l) => l.includes("body=")) ?? "";
    expect(body).not.toMatch(/proven production skew \(deploy the backend\)/);
    expect(body).not.toMatch(/Only 7 carries a deploy instruction/);
    expect(body).toMatch(/CLI summary/);
    // M-1 (batch 6): the CLI also words an UNCLASSIFIED skew as a likely remedy, so
    // neither text may claim deploy advice is always proven.
    for (const line of [exit7, body]) {
      expect(line).not.toMatch(/only when that is proven for every call/i);
      expect(line).not.toMatch(/Only 7 can carry a deploy instruction/);
      expect(line).toMatch(/likely/i);
    }
  });
});
