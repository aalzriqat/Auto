import { describe, expect, test } from "vitest";
import { classifyBreaking, alertsFor, releaseBlockingFindings, CLASSIFICATION } from "./classify.mjs";
import { blockersForRelease, pathsOverlap } from "./compare.mjs";

/**
 * The distinction these pin is the difference between "somebody must deploy
 * right now" and "the client has been wrong for months". Both look identical at
 * the call site — the live backend refuses a field — and conflating them was
 * about to leave the skew alarm permanently red for SCRUM-179, which is how an
 * alarm stops being read.
 */

const breaking = (identifier: string, path: string) => ({
  identifier,
  path,
  severity: "BREAKING",
  dimension: "SHAPE",
  file: "x.tsx",
  line: 1,
  detail: "…",
});

const IMPORT_BULK = breaking("vehicles:importBulk", "acquisitionPosting");
const MOBILE_EXPENSE = breaking("expenses:create", "category");

describe("classifyBreaking", () => {
  test("a rendered current spec that moved THIS path is revision skew", () => {
    // #227 and #235: the backend contract moved and the deploy is behind.
    const changedPaths = [{ identifier: "vehicles:importBulk", path: "acquisitionPosting" }];
    const got = classifyBreaking([IMPORT_BULK], { changedPaths });
    expect(got.revisionSkew).toHaveLength(1);
    expect(got.standingDefects).toHaveLength(0);
    expect(got.classified[0].classification).toBe(CLASSIFICATION.REVISION_SKEW);
  });

  test("a rendered current spec that moved a DIFFERENT path leaves this a standing defect", () => {
    // The backend did change — just not here. Deploying would not fix this one,
    // so calling it skew would send someone to run a deploy that changes nothing.
    const changedPaths = [{ identifier: "vehicles:importBulk", path: "importId" }];
    const got = classifyBreaking([MOBILE_EXPENSE], { changedPaths });
    expect(got.standingDefects).toHaveLength(1);
    expect(got.revisionSkew).toHaveLength(0);
  });

  test("both kinds can be true at once, and are reported separately", () => {
    // A genuine skew window does not suspend pre-existing bugs.
    const changedPaths = [{ identifier: "vehicles:importBulk", path: "acquisitionPosting" }];
    const got = classifyBreaking([IMPORT_BULK, MOBILE_EXPENSE], { changedPaths });
    expect(got.revisionSkew.map((f) => f.identifier)).toEqual(["vehicles:importBulk"]);
    expect(got.standingDefects.map((f) => f.identifier)).toEqual(["expenses:create"]);
  });

  test("an unchanged convex tree proves a standing defect", () => {
    // SCRUM-179. If no backend source changed at all, no contract changed.
    const got = classifyBreaking([MOBILE_EXPENSE], {
      backendIdenticalToDeployed: true,
      deployedSha: "f2bc4dc8b",
    });
    expect(got.standingDefects).toHaveLength(1);
    expect(got.basis).toContain("byte-identical");
    expect(got.basis).toContain("f2bc4dc8b");
  });

  test("a CHANGED convex tree is unclassified, never assumed standing", () => {
    // ⚠️ This is the direction that matters. During a real skew window the
    // backend source HAS moved, which is exactly when the coarse evidence stops
    // being able to distinguish — so it must fail toward the alarm.
    const got = classifyBreaking([MOBILE_EXPENSE], {
      backendIdenticalToDeployed: false,
      deployedSha: "6909ba4dd",
    });
    expect(got.unclassified).toHaveLength(1);
    expect(got.standingDefects).toHaveLength(0);
  });

  test("no evidence at all is unclassified, not standing", () => {
    const got = classifyBreaking([MOBILE_EXPENSE], {});
    expect(got.unclassified).toHaveLength(1);
    expect(got.basis).toMatch(/no evidence/);
  });

  test("an unresolvable deployed commit says so, rather than blaming a missing input", () => {
    // A shallow clone and "nobody told us the commit" are different failures,
    // and naming one as the other sends the reader to fix the wrong thing.
    const got = classifyBreaking([MOBILE_EXPENSE], { deployedSha: "deadbeef" });
    expect(got.unclassified).toHaveLength(1);
    expect(got.basis).toMatch(/could not be compared/);
    expect(got.basis).toContain("deadbeef");
  });

  test("an ancestor path change explains a descendant incompatibility", () => {
    // The backend replaced the whole `vehicles[*]` element shape; a finding on
    // `vehicles[*].rowId` is explained by that move.
    const changedPaths = [{ identifier: "vehicles:importBulk", path: "vehicles[*]" }];
    const got = classifyBreaking([breaking("vehicles:importBulk", "vehicles[*].rowId")], {
      changedPaths,
    });
    expect(got.revisionSkew).toHaveLength(1);
  });

  test("a same-named path on a DIFFERENT function does not explain anything", () => {
    const changedPaths = [{ identifier: "somethingElse:create", path: "category" }];
    const got = classifyBreaking([MOBILE_EXPENSE], { changedPaths });
    expect(got.standingDefects).toHaveLength(1);
  });
});

describe("alertsFor keeps the two signals apart", () => {
  const none = { revisionSkew: [], standingDefects: [], unclassified: [] };

  test("a standing defect does NOT raise the skew alarm", () => {
    // The whole point of the split: SCRUM-179 must not leave the skew signal
    // permanently red for something proven not to be skew.
    const alert = alertsFor({ ...none, standingDefects: [MOBILE_EXPENSE] }, false, 0, 0);
    expect(alert.productionSkew).toBe(false);
    expect(alert.standingContractDefect).toBe(true);
    expect(alert.summary).toMatch(/deploying will not fix/i);
  });

  test("a standing defect is still reported — not suppressed into silence", () => {
    const alert = alertsFor({ ...none, standingDefects: [MOBILE_EXPENSE] }, false, 0, 0);
    expect(alert.summary).toMatch(/STANDING CONTRACT DEFECT/);
    expect(alert.summary).not.toBe("no incompatibility detected");
  });

  test("revision skew raises the skew alarm", () => {
    const alert = alertsFor({ ...none, revisionSkew: [IMPORT_BULK] }, false, 0, 0);
    expect(alert.productionSkew).toBe(true);
    expect(alert.summary).toMatch(/PRODUCTION SKEW/);
  });

  test("an unclassified finding raises the skew alarm too", () => {
    const alert = alertsFor({ ...none, unclassified: [MOBILE_EXPENSE] }, false, 0, 0);
    expect(alert.productionSkew).toBe(true);
    expect(alert.summary).toMatch(/could not be classified/);
  });

  test("both signals can be raised at once", () => {
    const alert = alertsFor(
      { ...none, revisionSkew: [IMPORT_BULK], standingDefects: [MOBILE_EXPENSE] },
      false,
      0,
      0
    );
    expect(alert.productionSkew).toBe(true);
    expect(alert.standingContractDefect).toBe(true);
  });

  test("a coverage warning is only surfaced when nothing worse is true", () => {
    const quiet = alertsFor(none, true, 80, 0);
    expect(quiet.summary).toMatch(/control health, NOT a confirmed outage/);
    const loud = alertsFor({ ...none, revisionSkew: [IMPORT_BULK] }, true, 80, 0);
    expect(loud.summary).toMatch(/PRODUCTION SKEW/);
    expect(loud.coverageWarning).toBe(true);
  });
});

describe("releaseBlockingFindings", () => {
  test("a standing defect does not block a release", () => {
    // ⚠️ This was a real defect in this tool, not a hypothetical. Passing every
    // BREAKING finding to the release blocker made SCRUM-179 block EVERY
    // release forever — the same failure the classification split exists to
    // prevent, relocated from the monitor into the release gate.
    const blocking = releaseBlockingFindings({
      revisionSkew: [],
      unclassified: [],
      standingDefects: [MOBILE_EXPENSE],
    } as never);
    expect(blocking).toHaveLength(0);
  });

  test("skew and unclassified both block", () => {
    const blocking = releaseBlockingFindings({
      revisionSkew: [IMPORT_BULK],
      unclassified: [MOBILE_EXPENSE],
      standingDefects: [],
    } as never);
    expect(blocking).toHaveLength(2);
  });
});

describe("findings from the cross-family review", () => {
  test("G-F1: an opaque WHOLE payload blocks any change to that function", () => {
    // ⚠️ `pathsOverlap("<root>", "vehicles[*].rowId")` was false, so the single
    // most uncertain case — the entire payload unresolvable — was the one case
    // the path-sensitive gate ignored completely. A release could change any
    // contract on that function and ship green.
    expect(pathsOverlap("<root>", "vehicles[*].rowId")).toBe(true);
    expect(pathsOverlap("vehicles[*].rowId", "<root>")).toBe(true);
    const blockers = blockersForRelease(
      { breaking: [], needsEvidence: [{ identifier: "w:save", path: "<root>", severity: "SHAPE_UNKNOWN" }] },
      [{ identifier: "w:save", path: "vehicles[*].rowId" }]
    );
    expect(blockers.blocked).toBe(true);
  });

  test("G-F1b: <root> is still scoped to its own function", () => {
    // Overlapping everything must not mean overlapping every FUNCTION.
    const blockers = blockersForRelease(
      { breaking: [], needsEvidence: [{ identifier: "w:save", path: "<root>", severity: "SHAPE_UNKNOWN" }] },
      [{ identifier: "other:fn", path: "anything" }]
    );
    expect(blockers.blocked).toBe(false);
  });
});

describe("a union-branch move is revision skew, not a standing defect", () => {
  /**
   * The end of the chain the specDiff finding breaks: if `changedContractPaths`
   * cannot see the change, this classifies a real undeployed skew as a product
   * bug and tells the responder that deploying will not help. That is the
   * dangerous direction, and it is the one invariant 8 exists to protect.
   */
  test("a changed path overlapping the finding yields REVISION_SKEW", () => {
    const breaking = [
      { identifier: "w:save", path: "payload.y", severity: "BREAKING", file: "x.tsx", line: 1, detail: "..." },
    ];
    const result = classifyBreaking(breaking, {
      changedPaths: [{ identifier: "w:save", path: "payload", change: "PATH_REDECLARED" }],
    });
    expect(result.classified[0].classification).toBe(CLASSIFICATION.REVISION_SKEW);
    expect(result.standingDefects).toHaveLength(0);
  });

  test("and with NO changed path it is a standing defect — the honest opposite", () => {
    const breaking = [
      { identifier: "w:save", path: "payload.y", severity: "BREAKING", file: "x.tsx", line: 1, detail: "..." },
    ];
    const result = classifyBreaking(breaking, { changedPaths: [] });
    expect(result.classified[0].classification).toBe(CLASSIFICATION.STANDING_DEFECT);
  });
});
