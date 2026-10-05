/**
 * Self-tests for the economics-revision source analyser (SCRUM-703).
 *
 * A guard nobody has watched fail is not a guard, so these come before the repo
 * scan in `convex/economicsRevisionGuard.test.ts`. The `it.each` block pins the
 * forms that EVADED the first analyser (isolated synthetic probe on main
 * 785ab82ce, 2026-10-05): shorthand, spread, two untracked figures, and a
 * revision key that is present but does not advance.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backendSourceFiles,
  findUnbumpedEconomicsWrites,
  scanBackendForUnbumpedEconomicsWrites,
  staleExceptions,
} from "./economicsRevisionAnalyzer";

const BUMPED = `
    await ctx.db.patch(args.applicationId, {
      economicsRevision: (app.economicsRevision ?? 0) + 1,
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      updatedAt: now,
    });
`;

const UNBUMPED = `
    await ctx.db.patch(args.applicationId, {
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      updatedAt: now,
    });
`;

/** Copying the approved amount into settlement evidence moves no economics. */
const EVIDENCE_ONLY = `
    await ctx.db.patch(args.applicationId, {
      supplierDisbursementApprovedAtRecordingMinor: app.approvedDealerPurchaseAmountMinor,
      updatedAt: now,
    });
`;

const flagged = (source: string) => findUnbumpedEconomicsWrites(source, "sample.ts");

describe("the analyzer itself", () => {
  test("flags a patch that moves the approved amount without bumping", () => {
    expect(flagged(UNBUMPED)).toHaveLength(1);
  });

  test("clears the same patch once it bumps", () => {
    expect(flagged(BUMPED)).toHaveLength(0);
  });

  test("does not demand a bump for a patch that only copies the figure", () => {
    expect(flagged(EVIDENCE_ONLY)).toHaveLength(0);
  });

  test("flags an unbumped ctx.db.replace as readily as a patch", () => {
    expect(flagged(UNBUMPED.replace("ctx.db.patch(", "ctx.db.replace("))).toHaveLength(1);
  });

  test("reads a whole payload rather than stopping at the first nested brace", () => {
    // The bump sits AFTER a nested object, so a non-brace-matched reader would
    // miss it and report a false offence.
    const nested = `
    await ctx.db.patch(id, {
      snapshot: { basis: "APPRAISAL" },
      approvedDealerPurchaseAmountMinor: amount,
      economicsRevision: (app.economicsRevision ?? 0) + 1,
    });
`;
    expect(flagged(nested)).toHaveLength(0);
  });

  test("descends into subdirectories and skips codegen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "economics-guard-"));
    try {
      const nested = path.join(root, "utils", "deep");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "writer.ts"), UNBUMPED, "utf8");
      fs.mkdirSync(path.join(root, "_generated"));
      fs.writeFileSync(path.join(root, "_generated", "api.ts"), UNBUMPED, "utf8");

      const files = backendSourceFiles(root).map((f) => path.relative(root, f));
      expect(files).toEqual([path.join("utils", "deep", "writer.ts")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("forms that evaded the first analyzer (SCRUM-703)", () => {
  test.each([
    ["shorthand", "await ctx.db.patch(id, { approvedDealerPurchaseAmountMinor });"],
    ["shorthand among other keys", "await ctx.db.patch(id, { updatedAt, unfinancedPortionMinor, note });"],
    [
      "spread of a local literal",
      "const delta = { approvedDealerPurchaseAmountMinor: amount }; await ctx.db.patch(id, { ...delta });",
    ],
    ["the first-payment figure", "await ctx.db.patch(id, { customerFirstPaymentMinor: amount });"],
    [
      "the manual-approval dealer-sends figure",
      "await ctx.db.patch(id, { manualApproval: { ...previous, dealerSendsMinor: amount } });",
    ],
    [
      "a revision left unchanged",
      "await ctx.db.patch(id, { approvedDealerPurchaseAmountMinor: a, economicsRevision: app.economicsRevision });",
    ],
    [
      "a revision reset to zero",
      "await ctx.db.patch(id, { approvedDealerPurchaseAmountMinor: a, economicsRevision: 0 });",
    ],
  ])("flags an unbumped write: %s", (_name, source) => {
    expect(flagged(source)).toHaveLength(1);
  });

  test("still clears a genuine increment, with or without the nullish default", () => {
    for (const bump of [
      "economicsRevision: (app.economicsRevision ?? 0) + 1",
      "economicsRevision: (application.economicsRevision ?? 0) + 1,",
      "economicsRevision: app.economicsRevision! + 1",
    ]) {
      expect(flagged(`await ctx.db.patch(id, { customerFirstPaymentMinor: a, ${bump} });`)).toHaveLength(0);
    }
  });

  test("a spread it cannot resolve is NOT treated as moving economics (documented limit)", () => {
    // Pinned so the limit is a decision rather than an accident. Anything the
    // analyser cannot see is covered by the behavioural stale-stamp tests.
    expect(flagged("await ctx.db.patch(id, { ...fromElsewhere });")).toHaveLength(0);
  });
});

describe("Codex gpt-6-sol findings on f4e274bb (SCRUM-703)", () => {
  test("a bump that exists only in a comment is not a bump", () => {
    const commented = `
    await ctx.db.patch(id, {
      // economicsRevision: app.economicsRevision + 1,
      approvedDealerPurchaseAmountMinor: a,
    });`;
    expect(flagged(commented)).toHaveLength(1);
  });

  test("a commented-out write is not a write", () => {
    expect(flagged("// await ctx.db.patch(id, { approvedDealerPurchaseAmountMinor: a });")).toHaveLength(0);
  });

  test("an increment that is cancelled out is not an advance", () => {
    const noop = `
    await ctx.db.patch(id, {
      economicsRevision: app.economicsRevision + 1 - 1,
      approvedDealerPurchaseAmountMinor: a,
    });`;
    expect(flagged(noop)).toHaveLength(1);
  });

  test("an increment cancelled on the NEXT line is not an advance either", () => {
    const multiline = `
    await ctx.db.patch(id, {
      economicsRevision: app.economicsRevision + 1
        - 1,
      approvedDealerPurchaseAmountMinor: a,
    });`;
    expect(flagged(multiline)).toHaveLength(1);
  });

  test("a genuine increment that is the last key, with no trailing comma, still clears", () => {
    const last = `
    await ctx.db.patch(id, {
      approvedDealerPurchaseAmountMinor: a,
      economicsRevision: (app.economicsRevision ?? 0) + 1
    });`;
    expect(flagged(last)).toHaveLength(0);
  });

  test("a call written with unusual spacing is still scanned", () => {
    expect(flagged(UNBUMPED.replace("ctx.db.patch(", "ctx.db .patch ("))).toHaveLength(1);
  });

  test("one exception excuses one payload, not every payload sharing its fragment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "econ-two-"));
    try {
      fs.writeFileSync(path.join(root, "a.ts"), UNBUMPED + UNBUMPED);
      const one = { file: "a.ts", contains: "args.approvedAmountMinor" };
      expect(scanBackendForUnbumpedEconomicsWrites(root, [one])).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the reviewed-exception mechanism (SCRUM-703)", () => {
  const withRoot = <T>(files: Record<string, string>, fn: (root: string) => T): T => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "econ-exc-"));
    try {
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
      return fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const exception = { file: "a.ts", contains: "args.approvedAmountMinor" };

  test("an unexcused offence is reported", () => {
    withRoot({ "a.ts": UNBUMPED }, (root) => {
      expect(scanBackendForUnbumpedEconomicsWrites(root, [])).toHaveLength(1);
    });
  });

  test("a matching exception suppresses it and is not stale", () => {
    withRoot({ "a.ts": UNBUMPED }, (root) => {
      expect(scanBackendForUnbumpedEconomicsWrites(root, [exception])).toHaveLength(0);
      expect(staleExceptions(root, [exception])).toEqual([]);
    });
  });

  test("an exception for another file excuses nothing and is reported stale", () => {
    withRoot({ "a.ts": UNBUMPED, "b.ts": "export const x = 1;" }, (root) => {
      const other = { file: "b.ts", contains: "args.approvedAmountMinor" };
      expect(scanBackendForUnbumpedEconomicsWrites(root, [other])).toHaveLength(1);
      expect(staleExceptions(root, [other])).toEqual(["b.ts: args.approvedAmountMinor"]);
    });
  });

  test("an exception whose code was fixed is reported stale", () => {
    withRoot({ "a.ts": BUMPED }, (root) => {
      expect(staleExceptions(root, [exception])).toEqual(["a.ts: args.approvedAmountMinor"]);
    });
  });
});
