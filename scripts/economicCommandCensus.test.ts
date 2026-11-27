/**
 * SCRUM-313 requires exactly one classification for every public mutation that
 * can reach a money-bearing sink. Missing financial writers fail the census.
 * SCRUM-57's 31-command manifest is a subset of this population.
 *
 * IDENTITY_GUARDED supports different proven mechanisms. For example,
 * vehicles.importBulk uses a stable per-row import identity.
 *
 * The first seven negative controls cover prior analyzer blind spots.
 */
import { beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectFinanceAccountingEdges } from "../test-utils/financeCommandCensusAssertions";
import { commandsMissingIdentity } from "../test-utils/economicCommandCensusIdentity";
import { CLASSIFICATION } from "../test-utils/economicCommandClassification";
import {
  buildGraph,
  censusForward,
  censusReverse,
  findSinks,
  functionReferenceTargets,
  mintsAndPostsLocally,
  mintsAndPostsTransitively,
  MONEY_TABLES,
  stripComments,
  type Bucket,
  type SymbolRecord,
} from "./economicCommandCensus";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");
// The real-tree build runs under CI v8 coverage and takes several seconds since
// SCRUM-738 parses each file with TypeScript; the default 5 s budget made
// BLIND SPOT 1 time out in CI run 37418341588.
const REAL_TREE_BUDGET_MS = 120_000;

// The real convex/ graph is built at most once per file, on first use.
let realTree: ReturnType<typeof buildGraph> | undefined;
function realTreeGraph(): ReturnType<typeof buildGraph> {
  return (realTree ??= buildGraph(CONVEX_ROOT));
}



describe("analyzer self-tests — the seven blind spots, pinned", () => {
  test("BLIND SPOT 1: a callee is resolved through imports, never by bare name", () => {
    // `create`, `add` and `update` are symbol names in dozens of modules. Bare
    // name resolution fused the graph and reported 348 of 349 public mutations
    // as economic. If a future edit reintroduces name-based linking, the
    // population explodes and this catches it.
    // Same memo as realTreeGraph(). The literal `buildGraph` call stays in this
    // body because the ECON-1 invariant-catalog proof requires the test to call
    // the analyzer itself; this test is first in the file, so it builds the tree.
    const g = (realTree ??= buildGraph(CONVEX_ROOT));
    const population = censusForward(g);
    const publicMutations = [...g.symbols.values()].filter((s) => s.kind === "publicMutation");
    expect(publicMutations.length).toBeGreaterThan(300);
    // A fused graph puts essentially EVERY public mutation in the population.
    expect(population.size).toBeLessThan(publicMutations.length * 0.6);
  }, REAL_TREE_BUDGET_MS);

  test("BLIND SPOT 2: a financial sink is not only a ledger insert", () => {
    // Defining a sink as a journal/accountingEvents insert dropped seven
    // already-protected commands that move money without posting. Those tables
    // must remain in the money-bearing set.
    for (const table of ["deposits", "paymentIntents", "financeDealCustody", "financeDealFees"]) {
      expect(MONEY_TABLES).toContain(table);
    }
  });

  test("BLIND SPOT 3: ctx.db.patch is reachable by sink detection", () => {
    // patch/replace take a DOCUMENT ID, never a table name, so a call-site
    // regex can only ever see inserts. A function that only patches, while
    // naming a money table in a typed id, must still be a sink.
    const onlyPatches: SymbolRecord = {
      id: "synthetic.patchesOnly",
      file: "synthetic",
      name: "patchesOnly",
      kind: "publicMutation",
      line: 1,
      body: [
        "export const patchesOnly = mutation({",
        "  handler: async (ctx, args: { id: Id<\"receivables\"> }) => {",
        "    await ctx.db.patch(args.id, { outstandingAmount: 0 });",
        "  },",
        "});",
      ].join("\n"),
    };
    const sinks = findSinks(new Map([[onlyPatches.id, onlyPatches]]));
    expect([...sinks]).toEqual(["synthetic.patchesOnly"]);
  });

  test("BLIND SPOT 4: mint-and-post detection is transitive through a helper", () => {
    // `partnerEquity.add` -> `recordMovement` mints the transactions row and
    // posts. A local-only check calls the command safe; the owner found this by
    // hand. The local check must say NO and the transitive one must say YES, or
    // the ratchet has the same hole it had before.
    const command: SymbolRecord = {
      id: "synthetic.command", file: "synthetic", name: "command", kind: "publicMutation", line: 1,
      body: [
        "export const command = mutation({",
        "  handler: async (ctx, args) => {",
        "    return await helper(ctx, args);",
        "  },",
        "});",
      ].join("\n"),
    };
    const helper: SymbolRecord = {
      id: "synthetic.helper", file: "synthetic", name: "helper", kind: "helper", line: 10,
      body: [
        "async function helper(ctx, args) {",
        "  const transactionId = await ctx.db.insert(\"partnerEquityTransactions\", { ...args });",
        "  const hookArgs = { transactionId, orgId: args.orgId };",
        "  await hookCapitalContributed(ctx, hookArgs);",
        "  return transactionId;",
        "}",
      ].join("\n"),
    };
    const symbols = new Map([[command.id, command], [helper.id, helper]]);
    const g = {
      symbols,
      edges: new Map([[command.id, new Set([helper.id])], [helper.id, new Set<string>()]]),
      rEdges: new Map([[helper.id, new Set([command.id])], [command.id, new Set<string>()]]),
      sinks: new Set<string>(),
    };
    expect(mintsAndPostsLocally(command.body)).toBe(false);
    expect(mintsAndPostsTransitively(g, command.id)).toBe(true);
  });

  test("BLIND SPOT 7: a Convex function reference is an edge, in every delegation form", () => {
    // SCRUM-743: runMutation / scheduler.runAfter / runAt / runAction reach the
    // target through a reference, never a call expression. Each form must link.
    const body = [
      "await ctx.runMutation(internal.prepaidExpenses.catchUpScheduleMutation, {});",
      "await ctx.scheduler.runAfter(0, internal.accountingOutbox.drainPendingAccountingEvents, {});",
      "await ctx.scheduler.runAt(when, internal.accountingOutbox.claimOutboxRow, {});",
      "await ctx.runAction(api.nested.dir.doThing, {});",
    ].join("\n");
    expect(functionReferenceTargets(body)).toEqual([
      "prepaidExpenses.catchUpScheduleMutation",
      "accountingOutbox.drainPendingAccountingEvents",
      "accountingOutbox.claimOutboxRow",
      "nested/dir.doThing",
    ]);
    // A reference or a call named only in prose is not a delegation.
    expect(functionReferenceTargets("// see internal.accountingOutbox.redrive\n/* api.a.b */")).toEqual([]);
    expect(stripComments("x(); // reopen() refuses LOCKED")).not.toMatch(/reopen/);
    // A URL in a string is not a comment.
    expect(stripComments('const u = "https://example.com";')).toContain("https://example.com");
  });

  test("BLIND SPOT 7: the real delegated paths are in the population, the comment edge is not", () => {
    const g = realTreeGraph();
    const forward = censusForward(g);
    const edge = (a: string, b: string) => g.edges.get(a)?.has(b) ?? false;
    expect(edge("prepaidExpenses.redriveScheduleEvents", "accountingOutbox.drainEntries")).toBe(true);
    expect(edge("accountingOutbox.drainEntries", "accountingOutbox.claimOutboxRow")).toBe(true);
    // Period registrations schedule the outbox directly after their guarded writes.
    for (const door of ["create", "open", "reopen"]) {
      const operation = `accountingPeriods.${door}`;
      expect(edge(operation, "accountingOutbox.wakePeriodHeldRows")).toBe(true);
      if (door !== "create") expect(edge(operation, "accountingOutbox.drainPendingAccountingEvents")).toBe(true);
    }
    expect(edge("accountingOutbox.wakePeriodHeldRows", "accountingOutbox.claimOutboxRow")).toBe(true);
    expect(edge("chartOfAccounts.initialize", "accountingOutbox.drainPendingAccountingEvents")).toBe(true);
    expect(edge("chartOfAccounts.repairMissingSystemAccounts", "accountingOutbox.drainPendingAccountingEvents")).toBe(true);
    expect(edge("accountingOutbox.retryFailed", "accountingOutbox.claimOutboxRow")).toBe(true);
    expect(edge("prepaidExpenses.runAmortizationNow", "prepaidExpenses.catchUpScheduleMutation")).toBe(true);
    for (const id of [
      "accountingPeriods.create", "accountingPeriods.open", "accountingPeriods.reopen", "chartOfAccounts.initialize",
      "chartOfAccounts.repairMissingSystemAccounts", "accountingOutbox.redrive",
      "accountingMigration.backfillVehicleInventoryOpeningBalances", "prepaidExpenses.runAmortizationNow",
    ]) expect([...forward], id).toContain(id);
    // A public ACTION is a seed (ruling A), not only a mutation.
    expect(g.symbols.get("prepaidExpenses.runAmortizationNow")?.kind).toBe("publicAction");
    // The false positive: `lock` named `reopen()` in a comment.
    expect(edge("accountingPeriods.lock", "accountingPeriods.reopen")).toBe(false);
    expect([...forward]).not.toContain("accountingPeriods.lock");
  }, REAL_TREE_BUDGET_MS);

  test("BLIND SPOT 5: comment text is not a call (SCRUM-738)", () => {
    // A body is sliced from its declaration to the NEXT declaration, so the next
    // function's leading JSDoc lands in the previous symbol's body, and call/hook
    // tokens were matched over raw text. A JSDoc naming a hook therefore produced
    // a false money edge. Edge extraction now strips comments with a TypeScript
    // aware pass; it must stay precise in BOTH directions: no edge from a comment,
    // and no real call lost to a `//` or `/*` that is only text inside a literal.
    const BT = "`";
    const fixture = [
      "export function foo(x: number) { return x; }",
      "export function hookX() { return 0; }",
      "export function runWith(h: unknown) { return h; }",
      "export function awaitfoo() { return 0; }",
      // (a) comments only. The JSDoc on nextOne is attributed to commentsOnly.
      "export function commentsOnly() {",
      "  // calls foo() and hookX here",
      "  /** hookX and foo() in a block */",
      "  return 1; // trailing foo() hookX",
      "}",
      "/**",
      " * Leading JSDoc of the NEXT declaration: names `hookX` and foo().",
      " */",
      "export function nextOne() { return 2; }",
      // (b) real edges that sit beside a trailing comment on the same line.
      "export function realCall() {",
      "  const y = foo(1); // mentions runWith() only in a comment",
      "  return y;",
      "}",
      "export function realHookValue() {",
      "  runWith(hookX); /* trailing */",
      "}",
      "export function realHookConst() {",
      "  const h = hookX; // trailing foo()",
      "  return h;",
      "}",
      // Replacing a comment must not glue its neighbours: awaitfoo is NOT foo.
      "export function gluing() {",
      "  return await/**/foo(1);",
      "}",
      // (c) comment markers inside literals must not hide a following real call.
      "export function dqString() {",
      '  const s = "https://example.com"; foo(1);',
      "  runWith(2);",
      "}",
      "export function sqString() {",
      "  const s = 'http://x /* y'; foo(1);",
      "  runWith(2);",
      "}",
      "export function templateText() {",
      "  const t = " + BT + "a // b /* c" + BT + "; foo(1);",
      "  runWith(2);",
      "}",
      "export function regexSlashes() {",
      String.raw`  const r = /["']\/\//; foo(1);`,
      "  runWith(2);",
      "}",
      "export function regexQuote() {",
      String.raw`  const r = /"/; foo(1);`,
      "  runWith(2);",
      "}",
      "export function regexBlockOpen() {",
      String.raw`  const r = /a\/*b/; foo(1);`,
      "  runWith(2);",
      "}",
      // (d) a call inside a template expression is still a call.
      "export function templateCall() {",
      "  return " + BT + "x ${foo()} y // z" + BT + ";",
      "}",
      "export function nestedTemplateCall() {",
      "  return " + BT + "a ${" + BT + "b ${runWith(1)}" + BT + "} /* c" + BT + ";",
      "}",
    ].join("\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census738-"));
    try {
      fs.writeFileSync(path.join(dir, "fx.ts"), fixture);
      // (e) a JSDoc that is the LAST content of a file hangs off the EndOfFileToken.
      fs.writeFileSync(
        path.join(dir, "tail.ts"),
        "export function foo() { return 0; }\nexport function bar() { return 1; }\n/** foo() */\n",
      );
      const g = buildGraph(dir);
      const edgesOf = (n: string) => [...(g.edges.get(`fx.${n}`) ?? [])].sort();

      // (a) comments create no edge, including the JSDoc the slicer mis-attributes.
      expect(edgesOf("commentsOnly")).toEqual([]);
      expect(edgesOf("nextOne")).toEqual([]);

      // (b) real call / hook-as-value edges survive beside a trailing comment.
      expect(edgesOf("realCall")).toEqual(["fx.foo"]);
      expect(edgesOf("realHookValue")).toEqual(["fx.hookX", "fx.runWith"]);
      expect(edgesOf("realHookConst")).toEqual(["fx.hookX"]);
      expect(edgesOf("gluing")).toEqual(["fx.foo"]);

      // (c) literals that merely contain `//` or `/*` lose nothing after them.
      for (const n of ["dqString", "sqString", "templateText", "regexSlashes", "regexQuote", "regexBlockOpen"]) {
        expect(edgesOf(n), n).toEqual(["fx.foo", "fx.runWith"]);
      }

      // (d) calls inside template expressions are still seen.
      expect(edgesOf("templateCall")).toEqual(["fx.foo"]);
      expect(edgesOf("nestedTemplateCall")).toEqual(["fx.runWith"]);

      // (e) terminal JSDoc is comment text too: no edge, and the text is blanked.
      expect([...(g.edges.get("tail.bar") ?? [])]).toEqual([]);
      const tail = "export function bar() { return 1; }\n/** foo() */\n";
      const blanked = stripComments(tail);
      expect(blanked).toBe("export function bar() { return 1; }\n" + " ".repeat("/** foo() */".length) + "\n");
      expect(blanked.length).toBe(tail.length);
      expect(blanked.split("\n").length).toBe(tail.split("\n").length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BLIND SPOT 6: a factory-built hook is a real call (SCRUM-738 F1)", () => {
    // `export const hookCommissionPaid = makeCommissionHook(...)` puts its only
    // callee on the DECLARATION line, which edge extraction used to skip (it
    // sliced from the line after). Comment-derived edges had hidden that. The
    // declaration line's code after the first `=` is now read for `const`/`let`,
    // minus the Convex builder call (`mutation(`) which would otherwise fuse the
    // graph, and a call may carry a type-argument list (`make<T>(`).
    const fixture = [
      'export function makeHook(name: string) {',
      '  return async (ctx: any) => { await ctx.db.insert("receivables", { name }); };',
      '}',
      'export function makeHook2<T>(opts: T) {',
      '  return async (ctx: any) => { await ctx.db.insert("receipts" + "x", opts); await ctx.db.insert("deposits", {}); };',
      '}',
      'export function plain() { return 1; }',
      'export function a() { return 1; }',
      'export const mutation = customMutation(rawMutation);',
      'export const hookA = makeHook("X");',
      // A NESTED generic inside the type argument (`Id<"t">`), as the real
      // reversal hooks in convex/accounting/workflowHooks.ts carry.
      'export const hookB = makeHook2<{ k: Id<"t"> }>({',
      '  k: "v",',
      '});',
      'export const pubA = mutation({',
      '  handler: async (ctx: any) => { await hookA(ctx); },',
      '});',
      'export const pubB = mutation({',
      '  handler: async (ctx: any) => { await hookB(ctx); },',
      '});',
      'export const pubNoCall = mutation({',
      '  handler: async (ctx: any) => { return 1; },',
      '});',
      'export const pubGeneric = mutation<Args>({',
      '  handler: async (ctx: any) => { return 1; },',
      '});',
      // A comparison is not a type-argument list: no edge to `a`.
      'export const pubCompare = mutation({',
      '  handler: async (ctx: any, b: number, c: (n: number) => number) => { return a < b && c(1); },',
      '});',
    ].join("\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census738f1-"));
    try {
      fs.writeFileSync(path.join(dir, "fx6.ts"), fixture);
      const g = buildGraph(dir);
      const edgesOf = (n: string) => [...(g.edges.get(`fx6.${n}`) ?? [])].sort();

      // The factory callee is on the declaration line only.
      expect(edgesOf("hookA")).toEqual(["fx6.makeHook"]);
      expect(edgesOf("hookB")).toEqual(["fx6.makeHook2"]);
      // The builder call never becomes an edge, so the graph cannot fuse.
      for (const n of ["pubNoCall", "pubGeneric"]) expect(edgesOf(n), n).toEqual([]);
      expect(edgesOf("pubA")).toEqual(["fx6.hookA"]);
      expect(edgesOf("pubB")).toEqual(["fx6.hookB"]);
      // `a < b && c(` is a comparison, not `a<...>(`.
      expect(edgesOf("pubCompare")).toEqual([]);

      expect(g.sinks.has("fx6.makeHook")).toBe(true);
      expect(g.sinks.has("fx6.makeHook2")).toBe(true);
      const forward = censusForward(g);
      expect(forward.has("fx6.pubA")).toBe(true);
      expect(forward.has("fx6.pubB")).toBe(true);
      expect(forward.has("fx6.pubNoCall")).toBe(false);
      expect(forward.has("fx6.pubGeneric")).toBe(false);
      expect(forward.has("fx6.pubCompare")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── KNOWN GAPS (SCRUM-742). These two tests assert the gap EXISTS today, so
  // they are deliberately written to BREAK the moment the analyzer is rewritten
  // over the TypeScript AST and the gap closes. When they fail: that is the
  // fix landing. Flip each `toEqual([])` to the control's expectation, rename the
  // test, and delete the matching SCRUM-742 tripwire below. Neither shape is on a
  // current money path; the tripwire test over the real tree enforces that.
  const edgesIn = (file: string, fixture: string, name: string): string[] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census742-"));
    try {
      fs.writeFileSync(path.join(dir, `${file}.ts`), fixture);
      const g = buildGraph(dir);
      return [...(g.edges.get(`${file}.${name}`) ?? [])].sort();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("KNOWN GAP (SCRUM-742): a generic call whose type argument contains parentheses gets no edge", () => {
    // `(?:<[^()]*>)?` cannot span the `(x: number)` inside the type argument.
    const fixture = [
      "export function make<T>(): number { return 1; }",
      "export const hookGap = make<{ cb: (x: number) => void }>();",
      // Control: the same call without parentheses in the type argument IS an edge.
      'export const hookCtl = make<{ k: Id<"t"> }>();',
    ].join("\n");
    expect(edgesIn("fx742a", fixture, "hookCtl")).toEqual(["fx742a.make"]);
    // MUST FLIP to ["fx742a.make"] when SCRUM-742 lands.
    expect(edgesIn("fx742a", fixture, "hookGap")).toEqual([]);
  });

  test("KNOWN GAP (SCRUM-742): any call on a `function` declaration line (parameter default or one-line body) gets no edge", () => {
    // Function declaration lines are not read for edges (only const/let are), so
    // neither a parameter default nor a body that opens and closes on that line.
    const fixture = [
      "export function plain() { return 1; }",
      "export function fnDefault(x = plain()) { return x; }",
      "export function one() { return plain(); }",
      // Control: the same call on a LATER line is an edge.
      // (Multi-line: the declaration line itself is never read for `function`.)
      "export function fnBody(x: number) {",
      "  return plain() + x;",
      "}",
    ].join("\n");
    expect(edgesIn("fx742b", fixture, "fnBody")).toEqual(["fx742b.plain"]);
    // BOTH MUST FLIP to ["fx742b.plain"] when SCRUM-742 lands.
    expect(edgesIn("fx742b", fixture, "fnDefault")).toEqual([]);
    expect(edgesIn("fx742b", fixture, "one")).toEqual([]);
  });
});

describe("SCRUM-313 economic command classification ratchet", () => {
  let g: ReturnType<typeof buildGraph>;
  let forward: Set<string>;
  let reverse: Set<string>;
  beforeAll(() => {
    g = realTreeGraph();
    forward = censusForward(g);
    reverse = censusReverse(g);
  }, REAL_TREE_BUDGET_MS);

  test("the population is derived identically in both directions", () => {
    const onlyForward = [...forward].filter((x) => !reverse.has(x)).sort((a, b) => a.localeCompare(b));
    const onlyReverse = [...reverse].filter((x) => !forward.has(x)).sort((a, b) => a.localeCompare(b));
    expect(onlyForward).toEqual([]);
    expect(onlyReverse).toEqual([]);
  });

  test("no NON_ECONOMIC command reaches the outbox posting worker (SCRUM-743 review F1)", () => {
    // `retryFailed` and `redriveScheduleEvents` were both labelled NON_ECONOMIC
    // while scheduling `claimOutboxRow`, which posts. A NON_ECONOMIC label is a
    // claim that no money moves, so it must never sit on a graph path to a worker
    // that posts. Over-inclusive on purpose: a false hit costs one re-bucketing.
    const POSTING_WORKERS = new Set([
      "accountingOutbox.claimOutboxRow",
      "accountingOutbox.postOutboxRow",
      "accountingOutbox.drainEntries",
      "accountingOutbox.drainPendingAccountingEvents",
    ]);
    const reaches = (from: string): boolean => {
      const seen = new Set<string>([from]);
      const queue = [from];
      while (queue.length > 0) {
        const id = queue.pop()!;
        for (const next of g.edges.get(id) ?? []) {
          if (POSTING_WORKERS.has(next)) return true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };
    // Controls: the walk must see the known STATE_GUARDED paths, and every named
    // worker must still exist, so a rename cannot silently empty the check.
    for (const worker of POSTING_WORKERS) expect(g.symbols.has(worker)).toBe(true);
    expect(reaches("prepaidExpenses.redriveScheduleEvents")).toBe(true);
    expect(reaches("accountingOutbox.retryFailed")).toBe(true);
    const offenders = Object.entries(CLASSIFICATION)
      .filter(([id, entry]) => entry.bucket === "NON_ECONOMIC" && forward.has(id) && reaches(id))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    expect(offenders).toEqual([]);
  });

  test("the population is exactly the classified set", () => {
    const liveClassified = Object.entries(CLASSIFICATION)
      .filter(([, entry]) => entry.bucket !== "RETIRED")
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    const retired = Object.entries(CLASSIFICATION)
      .filter(([, entry]) => entry.bucket === "RETIRED")
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    const population = [...forward].sort((a, b) => a.localeCompare(b));
    // Set equality in both directions against the source scan (`forward`), never a
    // count: a NEW public financial writer fails here rather than entering the
    // codebase unclassified, and a classification for a command that no longer
    // exists fails too rather than rotting. SCRUM-426 guardrail 4: the previous
    // `toHaveLength(N)` pin was bumped by hand with every command (about 20 times)
    // and added nothing these two diffs do not already prove.
    const unclassified = population.filter((p) => !CLASSIFICATION[p]);
    const staleClassifications = liveClassified.filter((c) => !forward.has(c));
    expect(unclassified, "discovered in source but not classified").toEqual([]);
    expect(staleClassifications, "classified live but no longer discovered in source").toEqual([]);
    expect(retired.filter((c) => forward.has(c)), "classified RETIRED but still discovered").toEqual([]);
    // Non-vacuity: an empty scan must not pass as an empty classification.
    expect(population.length).toBeGreaterThan(0);
    expect(liveClassified.length).toBeGreaterThan(0);
  });

  test("every entry carries exactly one bucket and a stated mechanism", () => {
    const buckets: Bucket[] = ["IDENTITY_GUARDED", "STATE_GUARDED", "NON_ECONOMIC", "RETIRED"];
    for (const [id, entry] of Object.entries(CLASSIFICATION)) {
      expect(buckets, id).toContain(entry.bucket);
      expect(entry.mechanism.trim().length, id).toBeGreaterThan(20);
    }
  });

  test("every IDENTITY_GUARDED command actually carries identity", () => {
    expect(commandsMissingIdentity(CONVEX_ROOT, CLASSIFICATION, g.symbols)).toEqual([]);
  });

  test("finance accounting operations retain concrete call graph edges", () => expectFinanceAccountingEdges(g));
  test("no public mutation mints an id and posts without an explicit classification", () => {
    // A fresh row ID cannot identify a retry of the command that minted it.
    // Classify every such posting, favoring false positives over duplicate money.
    const unclassified: string[] = [];
    for (const id of forward) {
      if (!mintsAndPostsTransitively(g, id)) continue;
      if (!CLASSIFICATION[id]) unclassified.push(id);
    }
    expect(unclassified).toEqual([]);
  });

  test("the SCRUM-57 manifest is a strict subset of this population", () => {
    // Recorded so nobody re-derives safety from the old 31-command manifest.
    const MANIFEST_SAMPLE = [
      "collections.recordPayment", "deposits.release", "paymentIntents.create",
      "financeDealCosts.recordDealFee", "applications.confirmSupplierDisbursement",
    ];
    for (const id of MANIFEST_SAMPLE) expect([...forward], id).toContain(id);
    expect(forward.size).toBeGreaterThan(31);
  });

  test("factory-built reversal and commission hooks keep their real edges and reach a sink (SCRUM-738 N1)", () => {
    // The real `export const hookX = makeY<{ ... Id<"t"> ... }>({` declarations
    // in the commission adapter. If the declaration-line read or the type-argument
    // pattern regressed, these hooks would lose their only edge.
    const H = "accounting/workflow/commissionPosting";
    const R = "accounting/workflow/reversal";
    expect(g.edges.get(H + ".hookCommissionReversed")).toContain(R + ".makeReversalHook");
    expect(g.edges.get(H + ".hookCommissionPaid")).toContain(H + ".makeCommissionHook");
    const reachesSink = (start: string): boolean => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        if (g.sinks.has(cur)) return true;
        for (const n of g.edges.get(cur) ?? []) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      return false;
    };
    expect(reachesSink(`${H}.hookCommissionPaid`)).toBe(true);
    expect(reachesSink(`${H}.reverseCommissionForSale`)).toBe(true);
  });
});
