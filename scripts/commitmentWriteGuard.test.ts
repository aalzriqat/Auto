import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  analyzeSuccessorTopology,
  auditCommitmentWrites,
  auditOrganizationInserts,
  auditRootInserts,
  convexSourceFiles,
  findOrganizationInsertSites,
  findRootInsertSites,
  findUnchokedWrites,
  summarize,
} from "./commitmentWriteGuard";
// The real constant, so the guard's deliberate restatement of it cannot drift.
import { COMMITMENT_AUTHORITY_V1 } from "../convex/utils/commitmentKernel";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

/**
 * SCRUM-208 — THE RATCHET.
 *
 * Every write to a commitment liveness field that currently happens outside
 * the writer choke. New entries fail CI; removing one without updating this
 * map ALSO fails, so the debt cannot be quietly re-hidden after being paid.
 *
 * ⚠️ THIS IS A BURN-DOWN LIST, NOT AN ALLOWLIST. Each entry is a site Phase 3
 * routes through `utils/commitmentWriters.ts`. The three `vehicles.ts` sites
 * that motivated the guard are already gone from it — that absence is the
 * assertion, which is why the map is compared exactly rather than as a
 * ceiling.
 */
const BASELINE: Record<string, number> = {
  // The deposit module's own writers. In-module, so they are the least
  // dangerous of the set, but still not routed through one function.
  "deposits.ts::holdActive": 1,
  "deposits.ts::insert:depositVehicleHolds": 3,
  "utils/depositHelpers.ts::holdActive": 6,
  "utils/depositRecording.ts::holdActive": 1,
  // SCRUM-208 c15808 — THE REPRESENTATION CLASS, WRITTEN EXACTLY ONCE.
  //
  // This entry appearing is the point. `usesVehicleHoldRows` shipped with
  // readers on both sides and NO writer, so every deposit the product created
  // carried `undefined`, every canonical reader correctly failed closed on it,
  // and the whole canonical range matched nothing. The field now has one
  // writer, in the one function that inserts a deposit, and the map is
  // compared exactly — so a SECOND writer for it fails CI, which is the thing
  // that would let the two representations drift apart again.
  "utils/depositRecording.ts::usesVehicleHoldRows": 1,
  "utils/saleCancellation.ts::holdActive": 2,
  // SCRUM-208 / SCRUM-201 c15855 — THE AUTHORITY VERSION, WRITTEN AT BIRTH.
  //
  // `organizations:create` is the ONLY production organization creator, and
  // it now stamps the canonical version so a dealership is never born LEGACY.
  // Compared exactly, so a SECOND writer of this field — which is what any
  // downgrade or "repair" path would be — fails CI.
  //
  // ⚠️ The complementary risk is INVISIBLE to this map by construction: a new
  // creation site that OMITS the field writes nothing for a write-scanner to
  // see. That one is covered by `auditOrganizationInserts` below, and the two
  // checks are not redundant.
  "organizations.ts::commitmentAuthorityVersion": 1,
  // vehicles.ts is deliberately ABSENT. Its three raw
  // `ctx.db.patch(reservation.depositId, { holdActive: false })` calls were
  // the round-4 finding and are now routed through
  // `releaseReservationDepositHold`. This map is compared exactly, so their
  // return would fail CI.
};

/**
 * SCRUM-208 c16192, extended by c16195 — the whole-tree audits get a timeout
 * chosen FOR them.
 *
 * Four tests here parse every file under `convex/` — 215 of them — against
 * vitest's DEFAULT 5000ms, a number nobody picked for this work. On one CI
 * run the file took 15818ms and passed; on the next, 21768ms, and three of
 * them timed out; on the re-run of the identical commit, 12901ms and green.
 * A 69% swing on the same work, with zero assertion failures.
 *
 * c16192 authorized it for exactly the three that had already failed. c16195
 * makes it a class rule and adds the fourth, `no longer sees a raw holdActive
 * write in vehicles.ts` — the same `auditCommitmentWrites` pass over the same
 * 215 files, at the same measured cost. It carried the default only because
 * the earlier ruling was keyed on which tests had been unlucky, not on what
 * they do.
 *
 * The other two tests that walk the whole tree deliberately do NOT get it:
 * they enumerate files and substring-scan without ever building an AST. One
 * local run of this file measured the four parses at 982 / 961 / 865 / 760ms,
 * `SOURCE_EPISODE_REINSTATED has no production caller` at 24ms, and
 * `analyses a surface large enough…` at 2ms. 5000ms was tight for the parse
 * and nowhere near tight for the other two.
 *
 * This is a timeout proportionate to the work, NOT a retry and NOT a weakened
 * assertion — every expectation below is unchanged. A test that still exceeds
 * 15s is reporting a real regression in the audit, and should fail.
 */
const WHOLE_TREE_PARSE_TIMEOUT_MS = 15_000;

describe("commitment liveness writes go through the choke", () => {
  it("matches the recorded burn-down list exactly", () => {
    expect(summarize(auditCommitmentWrites(CONVEX_ROOT))).toEqual(BASELINE);
  }, WHOLE_TREE_PARSE_TIMEOUT_MS);

  it("no longer sees a raw holdActive write in vehicles.ts", () => {
    const offenders = auditCommitmentWrites(CONVEX_ROOT).filter(
      (w) => w.file === "vehicles.ts" && w.field === "holdActive"
    );
    expect(offenders).toEqual([]);
  }, WHOLE_TREE_PARSE_TIMEOUT_MS);

  /**
   * SCRUM-208 c15810 — A DORMANT BRANCH STAYS VISIBLY DORMANT.
   *
   * `SOURCE_EPISODE_REINSTATED` cannot fire on real data: it requires a
   * RELEASED claim, and no production writer ever sets a claim status. Its
   * resolver is unit-tested, which is legitimate — and is exactly the kind of
   * green suite that gets mistaken for integration proof. That mistake is what
   * blocked the previous head.
   *
   * So the absence of a caller is asserted rather than assumed. Wiring one
   * fails here, which is the point: whoever does it has to decide what writes
   * a RELEASED claim first.
   */
  it("SOURCE_EPISODE_REINSTATED has no production caller", () => {
    const constructing = convexSourceFiles(CONVEX_ROOT)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("SOURCE_EPISODE_REINSTATED"))
      .map((file) => path.relative(CONVEX_ROOT, file).split(path.sep).join("/"));

    // Only the module that DEFINES the intent may mention it.
    expect(constructing).toEqual(["commitments.ts"]);
  });

  it("analyses a surface large enough for the result to mean something", () => {
    // A green result from an analyzer that examined nothing is
    // indistinguishable from a green result from a clean backend.
    expect(convexSourceFiles(CONVEX_ROOT).length).toBeGreaterThan(100);
  });

  describe("root creation has exactly one site", () => {
    it("is created in one place only, and that place is the private openRoot", () => {
      // ⚠️ M1 — one place decides which root an operation acts under, one
      // place opens it. A second opener re-creates the defect that gave one
      // physical car two roots, and the field guard above CANNOT see it:
      // `commitments.ts` is choke-exempt, so an extra insert inside that file
      // passes it. This check deliberately ignores the choke list.
      expect(auditRootInserts(CONVEX_ROOT)).toEqual([
        { file: "commitments.ts", enclosingFunction: "openRoot" },
      ]);
    }, WHOLE_TREE_PARSE_TIMEOUT_MS);

    it("keeps the successor shape inside the unexported executor", () => {
      const source = fs.readFileSync(path.join(CONVEX_ROOT, "commitments.ts"), "utf8");
      const topology = analyzeSuccessorTopology(source);

      // ⚠️ A comment saying "only restoreCommitment supplies this" is not an
      // enforcement boundary. Module privacy is.
      expect(topology.exportedSuccessorParams).toEqual([]);
      expect(new Set(topology.openingSites)).toEqual(new Set(["executeAcquisition"]));
      expect(source).not.toMatch(/export\s+(async\s+)?function\s+executeAcquisition/);
    });

    it("flags a successor shape constructed in an exported function", () => {
      const source = [
        `export async function acquireVehicle(\n  ctx,\n  args: { successorOf?: Doc<"commitmentRoots"> }\n) {`,
        `  await openRoot(ctx, { opening: { kind: "SUCCESSOR", predecessor: args.successorOf } });`,
        `}`,
      ].join("\n");
      const topology = analyzeSuccessorTopology(source);
      expect(topology.openingSites).toEqual(["acquireVehicle"]);
      expect(topology.exportedSuccessorParams).toEqual(["acquireVehicle"]);
    });

    it("names the enclosing function, so a second opener is identifiable", () => {
      const source = [
        `async function openRoot(ctx) {`,
        `  return await ctx.db.insert("commitmentRoots", { status: "OPEN" });`,
        `}`,
        `export async function openSuccessorRoot(ctx) {`,
        `  return await ctx.db.insert("commitmentRoots", { status: "OPEN" });`,
        `}`,
      ].join("\n");
      expect(findRootInsertSites(source, "commitments.ts")).toEqual([
        { file: "commitments.ts", enclosingFunction: "openRoot" },
        { file: "commitments.ts", enclosingFunction: "openSuccessorRoot" },
      ]);
    });
  });

  describe("every organization is born on a known authority", () => {
    it("initializes the canonical version at the one production creator", () => {
      // ⚠️ THE FIELD RATCHET ABOVE CANNOT MAKE THIS ASSERTION. A creator that
      // OMITS the version writes no guarded field, so it passes the ratchet
      // while silently minting LEGACY dealerships whose every deferred
      // reversal terminalizes AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE
      // forever. Counting SITES is the only shape that catches an absence.
      expect(auditOrganizationInserts(CONVEX_ROOT)).toEqual([
        {
          file: "organizations.ts",
          enclosingFunction: "create",
          initializesAuthorityVersion: true,
        },
      ]);
    }, WHOLE_TREE_PARSE_TIMEOUT_MS);

    it("reports a second creator that omits the version", () => {
      const source = [
        `export const create = mutation({`,
        `  handler: async (ctx) => {`,
        `    await ctx.db.insert("organizations", { name: "a", commitmentAuthorityVersion: 1 });`,
        `  },`,
        `});`,
        `export const createFromInvite = mutation({`,
        `  handler: async (ctx) => {`,
        `    await ctx.db.insert("organizations", { name: "b" });`,
        `  },`,
        `});`,
      ].join("\n");
      expect(findOrganizationInsertSites(source, "organizations.ts")).toEqual([
        {
          file: "organizations.ts",
          enclosingFunction: "create",
          initializesAuthorityVersion: true,
        },
        {
          file: "organizations.ts",
          enclosingFunction: "createFromInvite",
          initializesAuthorityVersion: false,
        },
      ]);
    });

    it("refuses to read an indirect insert as initialized", () => {
      // A false PASS here would authorize the exact defect being guarded, so
      // an unreadable literal fails closed instead of searching forward for a
      // `{` that belongs to something else entirely.
      const source = [
        `export const create = mutation({`,
        `  handler: async (ctx) => {`,
        `    await ctx.db.insert("organizations", orgDoc);`,
        `    const unrelated = { commitmentAuthorityVersion: 1 };`,
        `  },`,
        `});`,
      ].join("\n");
      expect(findOrganizationInsertSites(source, "organizations.ts")).toEqual([
        {
          file: "organizations.ts",
          enclosingFunction: "create",
          initializesAuthorityVersion: false,
        },
      ]);
    });

    it("does not read the rule stated in a comment as a creation site", () => {
      const source = [
        `// ctx.db.insert("organizations", { commitmentAuthorityVersion: 1 })`,
        `export const noop = 1;`,
      ].join("\n");
      expect(findOrganizationInsertSites(source, "organizations.ts")).toEqual([]);
    });
  });

  describe("what the analyzer actually detects", () => {
    it("catches a raw patch of a guarded field outside the choke", () => {
      const source = `await ctx.db.patch(reservation.depositId, { holdActive: false });`;
      expect(findUnchokedWrites(source, "vehicles.ts")).toEqual([
        { file: "vehicles.ts", method: "patch", field: "holdActive" },
      ]);
    });

    it("catches an insert into a guarded table — liveness is born at insert", () => {
      const source = `await ctx.db.insert("depositVehicleHolds", { vehicleId, active: true });`;
      expect(findUnchokedWrites(source, "deposits.ts")).toEqual([
        { file: "deposits.ts", method: "insert", field: "insert:depositVehicleHolds" },
      ]);
    });

    it("catches a replace that carries a guarded field", () => {
      const source = `await ctx.db.replace(id, { usesVehicleHoldRows: true });`;
      expect(findUnchokedWrites(source, "migrations.ts")).toHaveLength(1);
    });

    it("allows the choke modules themselves to write", () => {
      const source = `await ctx.db.patch(deposit._id, { holdActive: false });`;
      expect(findUnchokedWrites(source, "utils/commitmentWriters.ts")).toEqual([]);
    });

    it("does not flag an unrelated table that happens to have a status", () => {
      const source = `await ctx.db.patch(leadId, { status: "WON", active: true });`;
      expect(findUnchokedWrites(source, "leads.ts")).toEqual([]);
    });

    it("does not mistake a later object literal for this call's argument", () => {
      const source = `await ctx.db.patch(id, someVar);\nconst other = { holdActive: true };`;
      expect(findUnchokedWrites(source, "leads.ts")).toEqual([]);
    });

    it("reads code, not prose — a comment describing the rule is not a violation", () => {
      // Documenting the rule must not break the check that enforces it.
      const commented = [
        `/**`,
        ` * Never write ctx.db.patch(deposit._id, { holdActive: false }) here.`,
        ` */`,
        `// and never ctx.db.insert("commitmentRoots", { status: "OPEN" })`,
      ].join("\n");
      expect(findUnchokedWrites(commented, "vehicles.ts")).toEqual([]);
      expect(findRootInsertSites(commented, "vehicles.ts")).toEqual([]);
    });

    it("does not treat a // inside a string literal as a comment", () => {
      const source = [
        `const url = "https://example.test/docs";`,
        `await ctx.db.patch(id, { holdActive: false });`,
      ].join("\n");
      expect(findUnchokedWrites(source, "vehicles.ts")).toEqual([
        { file: "vehicles.ts", method: "patch", field: "holdActive" },
      ]);
    });
  });
});

/**
 * SCRUM-208 — THE ANALYZERS MUST NOT BE FORGEABLE BY SPELLING.
 *
 * Codex xhigh blocked on this, Sonnet MAX filed it, and I reproduced every case
 * against the exported functions before any of it was fixed. The regex versions
 * certified — or simply never saw — a creator that mints LEGACY dealerships.
 *
 * ⚠️ THE TWO ANALYZERS ANSWER OPPOSITE QUESTIONS, AND THE TESTS SAY SO.
 * `findOrganizationInsertSites` must PROVE a field is set, so anything it cannot
 * read is NOT initialized. `findUnchokedWrites` must catch a field that MIGHT be
 * written, so it searches every depth. Collapsing them is what produced both a
 * false certification on one side and, when first fixed, a silent loss of
 * coverage on the other.
 */
describe("the write analyzers cannot be forged by spelling", () => {
  const withField = (table: string) =>
    `export const create = mutation({ handler: async (ctx, args) => {
       return await ctx.db.insert(${table}, { name: args.name, commitmentAuthorityVersion: 1 });
     }});`;
  const withoutField = (table: string) =>
    `export const create = mutation({ handler: async (ctx, args) => {
       return await ctx.db.insert(${table}, { name: args.name });
     }});`;

  // CONTROLS — if these ever fail, the rest of this block proves nothing.
  it("CONTROL: sees a double-quoted creator and certifies a real initializer", () => {
    const sites = findOrganizationInsertSites(withField('"organizations"'), "f.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].initializesAuthorityVersion).toBe(true);
  });

  it("CONTROL: sees a double-quoted creator that omits the field", () => {
    const sites = findOrganizationInsertSites(withoutField('"organizations"'), "f.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  it.each([
    ["single-quoted", "'organizations'"],
    ["template-literal", "`organizations`"],
  ])("sees a %s creator that omits the field — was INVISIBLE", (_label, table) => {
    const sites = findOrganizationInsertSites(withoutField(table), "f.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  it("refuses to certify a CONDITIONAL initializer — was falsely certified", () => {
    const src = `export const create = mutation({ handler: async (ctx, args) => {
      return await ctx.db.insert("organizations", {
        name: args.name,
        ...(args.canonical ? { commitmentAuthorityVersion: 1 } : {}),
      });
    }});`;
    const sites = findOrganizationInsertSites(src, "f.ts");
    expect(sites).toHaveLength(1);
    // The runtime document has no such field when the condition is false.
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  it("refuses to certify the field NESTED in an unrelated object — was falsely certified", () => {
    const src = `export const create = mutation({ handler: async (ctx, args) => {
      return await ctx.db.insert("organizations", {
        name: args.name,
        migrationHints: { commitmentAuthorityVersion: "set me later" },
      });
    }});`;
    const sites = findOrganizationInsertSites(src, "f.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  it("refuses to certify a SHORTHAND initializer, whose value it cannot read", () => {
    const src = `export const create = mutation({ handler: async (ctx, args) => {
      const commitmentAuthorityVersion = 0;
      return await ctx.db.insert("organizations", { name: args.name, commitmentAuthorityVersion });
    }});`;
    const sites = findOrganizationInsertSites(src, "f.ts");
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  it("audits an UNREADABLE table name as if it were organizations", () => {
    const src = `export async function seed(ctx, table) {
      return await ctx.db.insert(table, { name: "x" });
    }`;
    const sites = findOrganizationInsertSites(src, "f.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].initializesAuthorityVersion).toBe(false);
  });

  // ── the no-downgrade ratchet ────────────────────────────────────────────
  it("CONTROL: reports an explicit downgrade", () => {
    const w = findUnchokedWrites(
      `await ctx.db.patch(orgId, { commitmentAuthorityVersion: 0 });`,
      "x.ts"
    );
    expect(w.map((r) => r.field)).toContain("commitmentAuthorityVersion");
  });

  it("reports a SHORTHAND downgrade — was INVISIBLE to the ratchet", () => {
    const w = findUnchokedWrites(
      `const commitmentAuthorityVersion = 0;
       await ctx.db.patch(orgId, { commitmentAuthorityVersion });`,
      "x.ts"
    );
    expect(w.map((r) => r.field)).toContain("commitmentAuthorityVersion");
  });

  it("reports a COMPUTED key — was INVISIBLE to the ratchet", () => {
    const w = findUnchokedWrites(`await ctx.db.patch(orgId, { [k]: 0 });`, "x.ts");
    expect(w.map((r) => r.field)).toContain("write:<computed-key>");
  });

  /**
   * ⚠️ REGRESSION GUARD FOR MY OWN FIRST FIX. Restricting the ratchet to
   * top-level properties made it miss the two real conditional-spread sites
   * (`saleCancellation.ts`, `depositHelpers.ts`) — a silent LOSS of coverage,
   * strictly worse than the forgery it was meant to close.
   */
  it("still reports a guarded field written inside a CONDITIONAL SPREAD", () => {
    const w = findUnchokedWrites(
      `await ctx.db.patch(d._id, { ...(reinstateHold ? { holdActive: true } : {}) });`,
      "x.ts"
    );
    expect(w.map((r) => r.field)).toContain("holdActive");
  });

  /**
   * ⚠️ AN HONEST LIMIT, ASSERTED SO IT CANNOT BE MISREAD AS COVERAGE.
   * A spread of a binding built elsewhere names no field at this call site, and
   * resolving it needs type information this source-text analyzer does not have.
   * Recorded as a known gap rather than claimed as closed.
   */
  it("does NOT resolve a spread of a prebuilt object — known, recorded gap", () => {
    const w = findUnchokedWrites(
      `const patch = { commitmentAuthorityVersion: 0 };
       await ctx.db.patch(orgId, { ...patch });`,
      "x.ts"
    );
    // The literal that NAMES the field is a separate statement, not the write.
    expect(w.map((r) => r.field)).not.toContain("commitmentAuthorityVersion");
  });
});

/**
 * SCRUM-208 round 6 — the defects BOTH SEATS found in the round-5 repair.
 *
 * ⚠️ THESE EXIST BECAUSE MY OWN FIX WAS FORGEABLE. The round-5 change closed
 * the four spellings it was told about and left seven more, found by Codex
 * xhigh, Sonnet MAX and my own probe against `6e2dceb83` — including one
 * outright algorithmic bug (below) and a doc comment claiming the opposite.
 * Every case here failed against that revision.
 */
describe("round-6: the analyzers cannot be forged by position or by value", () => {
  const orgInsert = (literal: string) =>
    findOrganizationInsertSites(`ctx.db.insert("organizations", ${literal})`, "x.ts")[0];

  /**
   * ⚠️ THE ALGORITHMIC ONE. Object literals resolve in source order and later
   * entries WIN, so anything after the match can overwrite it. The old code
   * returned on the first match and never looked further. Runtime, verified not
   * assumed: `{ver:1, ...{ver:0}}` is `{ver:0}`. Found by Sonnet MAX.
   */
  it("refuses when a spread AFTER the match can override it", () => {
    expect(orgInsert(`{ commitmentAuthorityVersion: 1, ...extra }`).initializesAuthorityVersion)
      .toBe(false);
  });

  /**
   * ⚠️ AND THE MIRROR CASE MUST STILL PASS. A spread BEFORE the assignment is
   * genuinely safe — the explicit value wins. Refusing it too would have been
   * the lazy fix; the verdict is position-aware precisely so this stays true.
   */
  it("still certifies when the spread comes BEFORE the assignment", () => {
    expect(orgInsert(`{ ...extra, commitmentAuthorityVersion: 1 }`).initializesAuthorityVersion)
      .toBe(true);
  });

  it("refuses a duplicate key whose LAST value is not canonical", () => {
    expect(
      orgInsert(`{ commitmentAuthorityVersion: 1, commitmentAuthorityVersion: 0 }`)
        .initializesAuthorityVersion
    ).toBe(false);
  });

  // The key being present was never the question — `: 0` mints a LEGACY org.
  it.each([["0"], ["undefined"], ["someRuntimeValue"], ["flag ? 1 : 0"]])(
    "refuses commitmentAuthorityVersion: %s",
    (value) => {
      expect(orgInsert(`{ commitmentAuthorityVersion: ${value} }`).initializesAuthorityVersion)
        .toBe(false);
    }
  );

  /**
   * ⚠️ ONLY A NUMERIC LITERAL CERTIFIES (SCRUM-208 c15929, owner ruling).
   *
   * The identifier `COMMITMENT_AUTHORITY_V1` is no longer accepted in ANY
   * form, imported or not. Two rounds of trying to prove a name resolves to
   * the kernel binding were forged twice, the second time by the repair for
   * the first — the convergence circuit breaker. The inference is deleted
   * rather than sharpened, and the duplicated number is held in place by the
   * two pins at the bottom of this block instead.
   */
  const IMPORT = `import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";
`;
  const orgInsertImporting = (literal: string) =>
    findOrganizationInsertSites(
      `${IMPORT}ctx.db.insert("organizations", ${literal})`,
      "convex/organizations.ts"
    )[0];

  it("CONTROL — certifies the canonical numeric literal", () => {
    expect(
      orgInsert(`{ commitmentAuthorityVersion: ${COMMITMENT_AUTHORITY_V1} }`)
        .initializesAuthorityVersion
    ).toBe(true);
  });

  it("refuses the identifier even under a GENUINE kernel import", () => {
    // This case CERTIFIED before c15929. It is the whole behaviour change:
    // the name buys nothing, so nothing can be forged through it.
    expect(
      orgInsertImporting(`{ commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 }`)
        .initializesAuthorityVersion
    ).toBe(false);
  });

  /**
   * ⚠️ THE TWO FORGERIES THAT DEFEATED THE PREVIOUS RULE, KEPT AS PERMANENT
   * REGRESSIONS. Both certified at 69f020415 with a real top-level import.
   *
   * The round-9 test that was SUPPOSED to cover this had no import in its
   * fixture, so it silently duplicated the "no import" case and never
   * exercised import+shadow at all — which is exactly how the hole survived a
   * green 53-test suite. Both shapes below carry the import deliberately.
   */
  it("refuses a PARAMETER-DEFAULT shadow under a genuine import (Codex)", () => {
    const forged = findOrganizationInsertSites(
      `${IMPORT}export const create = mutation({
         handler: async (ctx) => {
           const insertOrg = (COMMITMENT_AUTHORITY_V1 = 0) =>
             ctx.db.insert("organizations", { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 });
           return await insertOrg();
         },
       });`,
      "convex/organizations.ts"
    )[0];
    expect(forged.initializesAuthorityVersion).toBe(false);
  });

  it("refuses a BLOCK-SCOPED shadow under a genuine import (Sonnet MAX)", () => {
    // `tsc --strict` compiles this with no TS2451: an inner scope may shadow a
    // module import. The previous rule's stated justification was false.
    const forged = findOrganizationInsertSites(
      `${IMPORT}export function createLegacyMigratedOrg(ctx: any) {
         const COMMITMENT_AUTHORITY_V1 = 0;
         return ctx.db.insert("organizations", { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 });
       }`,
      "convex/organizations.ts"
    )[0];
    expect(forged.initializesAuthorityVersion).toBe(false);
  });

  it("refuses an identifier imported from a LOOK-ALIKE module path", () => {
    // `.includes("commitmentKernel")` accepted `./fakecommitmentKernel`. The
    // path is no longer consulted at all, so the shape cannot recur.
    const forged = findOrganizationInsertSites(
      `import { COMMITMENT_AUTHORITY_V1 } from "./fakecommitmentKernel";
       ctx.db.insert("organizations", { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 });`,
      "convex/organizations.ts"
    )[0];
    expect(forged.initializesAuthorityVersion).toBe(false);
  });

  it("refuses a RENAMED import, whose local name proves nothing", () => {
    const renamed = findOrganizationInsertSites(
      `import { SOMETHING as COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";
       ctx.db.insert("organizations", { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 });`,
      "x.ts"
    )[0];
    expect(renamed.initializesAuthorityVersion).toBe(false);
  });

  /**
   * ⚠️ PIN 1 OF 2. The guard restates the canonical version rather than
   * importing convex runtime code into a static-analysis script, and c15929
   * made the production writer restate it a second time. This pins the guard's
   * number to the real kernel constant from BOTH sides, so the duplication
   * cannot drift in either direction: the kernel's value must certify, and the
   * value one above it must not.
   *
   * PIN 2 lives in `convex/organizations.test.ts`, which drives the real
   * `organizations:create` and asserts the STORED version equals this same
   * kernel constant. Together they mean a kernel bump to V2 fails both suites
   * until the writer and this guard are updated deliberately, together.
   */
  it("pins its canonical version to the real COMMITMENT_AUTHORITY_V1", () => {
    expect(
      orgInsert(`{ commitmentAuthorityVersion: ${COMMITMENT_AUTHORITY_V1} }`)
        .initializesAuthorityVersion,
      "the kernel's own value must certify"
    ).toBe(true);
    expect(
      orgInsert(`{ commitmentAuthorityVersion: ${COMMITMENT_AUTHORITY_V1 + 1} }`)
        .initializesAuthorityVersion,
      "one above the kernel's value must not"
    ).toBe(false);
  });

  /**
   * ⚠️ `commitments.ts` IS CHOKE-EXEMPT, so `findUnchokedWrites` cannot see an
   * extra root insert placed there. This audit is the ONLY defence for "exactly
   * one creation site", and a quote character defeated it.
   */
  it.each([
    ["single-quoted", `'commitmentRoots'`],
    ["template-literal", "`commitmentRoots`"],
    ["unresolved binding", "table"],
  ])("sees a %s commitmentRoots insert", (_label, table) => {
    expect(
      findRootInsertSites(`function rogue(ctx){ return ctx.db.insert(${table}, {}); }`, "x.ts")
    ).toHaveLength(1);
  });

  it("CONTROL — still sees the ordinary double-quoted root insert", () => {
    expect(
      findRootInsertSites(`function openRoot(ctx){ return ctx.db.insert("commitmentRoots", {}); }`, "x.ts")
    ).toEqual([{ file: "x.ts", enclosingFunction: "openRoot" }]);
  });

  // A guard that depends on where somebody put a newline is not a guard.
  it.each([
    ["single-line function", `export function f(ctx, args: { successorOf?: string }) { return 1; }`],
    ["arrow-const", `export const f = async (ctx, args: { successorOf?: string }) => { return 1; };`],
    [
      "multi-line function",
      `export async function f(\n  ctx,\n  args: { successorOf?: string }\n) { return 1; }`,
    ],
  ])("sees a caller-supplied successorOf on an exported %s", (_label, src) => {
    expect(analyzeSuccessorTopology(src).exportedSuccessorParams).toEqual(["f"]);
  });

  it("CONTROL — an exported function without successorOf is not reported", () => {
    expect(
      analyzeSuccessorTopology(`export function f(ctx, args: { vehicleId: string }) { return 1; }`)
        .exportedSuccessorParams
    ).toEqual([]);
  });
});
