import { expect, test, describe } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * `socialBulkMutation` suppresses the per-write conversation recompute so a
 * bulk loop does not re-read each thread once per event. The price is that the
 * handler owes the recompute itself.
 *
 * That obligation fails open in the worst way: the mutation writes its event
 * rows perfectly, returns success, and simply leaves `socialConversations`
 * describing a state that no longer exists. Nothing throws, nothing logs, and
 * the inbox shows a stale thread summary until some unrelated write to the same
 * thread happens to fix it. There is no runtime signal to alert on, so the
 * guard has to be at build time and it has to be exhaustive.
 *
 * ## Why this checks each mutation, not each file
 *
 * The first version scanned whole modules. That passed as soon as *any*
 * mutation in the file synced — so a second, non-syncing `socialBulkMutation`
 * added later was invisible. That is not hypothetical: `socialInbox.ts` no
 * longer imports the ordinary `mutation` builder at all, so the deferred one is
 * what a future author reaches for by default in exactly the module where the
 * next such mutation would be written.
 *
 * It also stripped nothing, so a comment mentioning `syncDeferredSocialThreads(`
 * satisfied it. Both holes are the same shape as the bug the file exists to
 * prevent, and both are closed below.
 */

const CONVEX_DIR = path.join(process.cwd(), "convex");
/** Only this module may hand out the deferred builder. */
const BUILDER_OWNER = "functions.ts";

function convexModules(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated") continue;
      convexModules(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Blanks out comments so they cannot satisfy the obligation, using TypeScript's
 * parser rather than pattern matching.
 *
 * Two earlier versions of this were fail-open, and the failure is the same
 * shape each time: something that merely *looks* like a comment gets deleted,
 * that deletion can remove the closing `});` bounding a mutation's chunk, the
 * chunk then runs on into its neighbour, and the offender inherits a
 * `syncDeferredSocialThreads(` call it never makes. A guard that reports clean
 * because it destroyed the evidence is worse than no guard.
 *
 *   - Regular expressions matched comment shapes inside string, template and
 *     regex literals. A block-comment opener in a string pairs with the next
 *     real closer and eats everything between.
 *   - A bare `ts.createScanner` fixed that but has no syntactic context, so it
 *     cannot distinguish division from the start of a regular expression. A
 *     regex character class holding both comment delimiters came back with its
 *     contents blanked. See the fixture named for it below.
 *
 * The parser resolves regex context correctly, so trivia ranges taken from its
 * tokens are the real comments and nothing else. Ranges are replaced with
 * spaces of equal length and newlines are preserved, leaving every downstream
 * offset, chunk boundary and line number byte-for-byte unchanged.
 */
export function stripComments(source: string): string {
  // Parser, not scanner. A bare `ts.createScanner` has no syntactic context, so
  // it cannot tell a division from the start of a regular expression: given
  // `/[/*][*/]/` it reports the inner `/* ... */` as a block comment and blanks
  // a valid character class. Verified — that exact input came back as
  // `/[      ]/`. The parser decides regex context correctly, so comment ranges
  // taken from token trivia are the real comments and nothing else.
  const sourceFile = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const out = source.split("");
  const seen = new Set<string>();

  const blank = (pos: number, end: number) => {
    const key = `${pos}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (let i = pos; i < end; i++) {
      // Newlines survive so offsets, chunk boundaries and line numbers are
      // byte-for-byte what they were in the source.
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    }
  };

  // `getChildren`, not `forEachChild`. `forEachChild` visits only syntactic
  // children and skips punctuation tokens, so the leading trivia of a closing
  // `}` or `)` is never reached — and `getTrailingCommentRanges` stops at the
  // first line break, so a comment on the following line is not trailing trivia
  // of the preceding node either. The gap that leaves is the single most likely
  // place for the comment this guard must not be fooled by:
  //
  //     handler: async (ctx) => {
  //       await ctx.db.patch(id, {});
  //       // TODO: syncDeferredSocialThreads(ctx, threads)
  //     },
  //
  // Verified: that comment survived `forEachChild` and satisfied the
  // obligation. `getChildren` materialises token nodes, so their trivia is
  // visited too.
  const visit = (node: ts.Node) => {
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      blank(range.pos, range.end);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
      blank(range.pos, range.end);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);

  return out.join("");
}

/**
 * True when a module could possibly hold a deferred mutation.
 *
 * Parsing is far more expensive than the regex it replaced, and the scan runs
 * over every Convex module twice. Doing that for all ~190 of them blew the
 * 5s default timeout under CI's coverage instrumentation — a required check
 * went red on a *timing* failure, which is the kind that comes back
 * intermittently. Three files mention the builder; the rest cannot contain an
 * offender by definition, so they are never parsed.
 *
 * Deliberately a raw-text check on the unstripped source: a file whose only
 * mention is inside a comment is parsed unnecessarily, which is harmless. The
 * failure that matters would be skipping a file that *does* use the builder,
 * and that cannot happen — the name has to appear literally for the call to
 * exist.
 */
function mayHoldDeferredMutation(source: string): boolean {
  return source.includes("socialBulkMutation");
}

/** The builder's real name, wherever it is bound. */
const BUILDER = "socialBulkMutation";

/**
 * Every local name in this module that reaches the deferred builder.
 *
 * The scan used to match the builder's *spelling* at the call site
 * (`= socialBulkMutation(`), which is not the same question as "is this built
 * on the deferred builder". A named import may be renamed on the way in, and
 * that is ordinary TypeScript rather than anything exotic:
 *
 *     import { socialBulkMutation as deferredMutation } from "./functions";
 *     export const bad = deferredMutation({ ... });
 *
 * That defeated both halves of the guard at once. The mutation appeared in
 * neither `deferredMutationOffenders` nor `deferredMutationsIn`, so the
 * "guard is armed" test still saw exactly the two known mutations and stayed
 * green — a guard reporting clean because it was looking for the wrong string.
 *
 * `mayHoldDeferredMutation` is not a backstop against this: the raw source
 * still contains `socialBulkMutation` on the import line, so the file is parsed
 * and then nothing matches.
 *
 * Resolved from the AST rather than by pattern, so the answer is whatever
 * TypeScript itself would bind. Both import forms are covered — the named
 * import under any local name, and a namespace import used as
 * `fns.socialBulkMutation(...)`.
 */
function builderBindings(source: string): string[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  // The builder's own name is always a binding, whether or not an import
  // declaration was found. Resolution ADDS the aliases a spelling match would
  // miss; it must never subtract the spelling itself. Dropping it made every
  // fixture without an import line invisible — the same fail-open shape as the
  // bug this function exists to fix, introduced by the fix for it.
  const names: string[] = [BUILDER];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;

    // `import * as fns from "./functions"` — the builder is reached as a
    // property, so the binding worth recording is `fns.socialBulkMutation`.
    if (ts.isNamespaceImport(bindings)) {
      names.push(`${bindings.name.text}.${BUILDER}`);
      continue;
    }

    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // `propertyName` is set only when the import is renamed, in which case it
      // holds the ORIGINAL name and `name` holds the local one.
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === BUILDER) names.push(element.name.text);
    }
  }

  return names;
}

/** Matches `= <binding>(` for any name that resolves to the deferred builder. */
function builderCallPattern(source: string): RegExp {
  const bindings = builderBindings(source);
  // Longest first so `fns.socialBulkMutation` is preferred over a bare
  // `socialBulkMutation` binding that happens to also exist.
  const alternation = bindings
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/\./g, "\\."))
    .join("|");
  return new RegExp(`=\\s*(?:${alternation})\\(`);
}

/**
 * Re-exports of the builder under another name, which this guard refuses.
 *
 * Binding resolution closes renamed imports, but it cannot follow the builder
 * across modules. If some module does `export const deferredMutation =
 * socialBulkMutation`, then an importer of THAT module never writes
 * `socialBulkMutation` anywhere — so `mayHoldDeferredMutation` skips it before
 * any parsing happens, and no amount of care at the call site can help.
 *
 * Rather than pretend to follow arbitrary indirection, the module doing the
 * re-export is reported. That puts the failure at the one place that can still
 * see what is going on.
 */
function builderReExports(source: string, rel: string): string[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Set(builderBindings(source));
  const offenders: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isIdentifier(decl.name)) continue;
      // An identifier alone, NOT a call: `= socialBulkMutation` rather than
      // `= socialBulkMutation({...})`. The latter is an ordinary mutation.
      if (!ts.isIdentifier(init) || !bindings.has(init.text)) continue;
      offenders.push(
        `${rel}:${decl.name.text} re-exports ${BUILDER} under another name, which this guard cannot follow`
      );
    }
  }

  return offenders;
}

/**
 * One entry per exported Convex function, split on the same boundary
 * `scripts/tenantWriteGuard.ts` uses.
 */
/**
 * One `rel:name` per exported mutation built on `socialBulkMutation`, using the
 * same chunking as the obligation scan so the two cannot diverge.
 */
export function deferredMutationsIn(source: string, rel: string): string[] {
  if (!mayHoldDeferredMutation(source)) return [];
  const builderCall = builderCallPattern(source);
  const found: string[] = [];
  const code = stripComments(source);

  // Leading newline so a definition at offset 0 is chunked like any other.
  // Splitting on a newline-prefixed `export const` alone made the FIRST
  // definition in a module invisible — no chunk, no offender, silently clean.
  // Fourth fail-open in this helper, same shape as the rest: it reported
  // nothing because it looked at nothing.
  for (const raw of ("\n" + code).split(/\nexport const /).slice(1)) {
    const whole = "export const " + raw;
    const end = whole.search(/\n\}\);/);
    const name = raw.match(/^(\w+)/)?.[1];
    if (!name) continue;
    const chunk = end === -1 ? whole : whole.slice(0, end);
    if (builderCall.test(chunk)) found.push(`${rel}:${name}`);
  }

  return found;
}

export function deferredMutationOffenders(source: string, rel: string): string[] {
  if (!mayHoldDeferredMutation(source)) return [];
  // Indirection this guard cannot follow is reported, not tolerated. Checked
  // before the binding lookup because a module that only re-exports the builder
  // has no call sites of its own to scan.
  const offenders: string[] = builderReExports(source, rel);
  const builderCall = builderCallPattern(source);
  const code = stripComments(source);

  // Leading newline so a definition at offset 0 is chunked like any other.
  // Splitting on a newline-prefixed `export const` alone made the FIRST
  // definition in a module invisible — no chunk, no offender, silently clean.
  // Fourth fail-open in this helper, same shape as the rest: it reported
  // nothing because it looked at nothing.
  for (const raw of ("\n" + code).split(/\nexport const /).slice(1)) {
    const whole = "export const " + raw;
    // Bounded at this definition's own closing `});`. Splitting alone runs a
    // chunk to the next `export const` — or to EOF for the last one — so a
    // non-exported helper defined *after* an offending mutation leaked its
    // calls into the offender's chunk and the offender went unreported.
    const end = whole.search(/\n\}\);/);
    const name = raw.match(/^(\w+)/)?.[1];
    if (!name) continue;
    if (end === -1) {
      // No recognisable closing `});`, so the chunk cannot be bounded and would
      // run on into the next definition, borrowing calls that are not its own.
      // Report it rather than scan it: for a guard whose whole purpose is to
      // catch a silent omission, "I could not parse this" must not read the
      // same as "this is fine".
      if (builderCall.test(whole)) {
        offenders.push(`${rel}:${name} uses socialBulkMutation in a definition this guard cannot bound`);
      }
      continue;
    }
    const chunk = whole.slice(0, end);
    if (!builderCall.test(chunk)) continue;

    // Both halves are required. Collecting without syncing leaves the rows
    // stale; syncing without collecting recomputes an empty set, which looks
    // exactly like success.
    if (!chunk.includes("syncDeferredSocialThreads(")) {
      offenders.push(`${rel}:${name} uses socialBulkMutation but never calls syncDeferredSocialThreads`);
    }
    if (!chunk.includes("collectSocialThread(")) {
      offenders.push(`${rel}:${name} uses socialBulkMutation but never calls collectSocialThread`);
    }
  }

  return offenders;
}

describe("deferred conversation sync", () => {
  test("comment-like text inside literals is left alone", () => {
    // Each of these would have been mangled by the regex stripper. The URL and
    // the template both contain `//`; the regex literal contains a block-comment
    // opener; and the closing delimiter inside a string is what could have
    // swallowed real code up to the next one.
    const url = 'const endpoint = "https://graph.example.com/v1";';
    expect(stripComments(url)).toBe(url);

    const template = "const t = `see https://example.com/docs for details`;";
    expect(stripComments(template)).toBe(template);

    const regex = "const re = /\\/\\*/;";
    expect(stripComments(regex)).toBe(regex);

    // A regex character class holding both delimiters unescaped. This is what a
    // context-free scanner gets wrong: it reads the inner `/*` ... `*/` as a
    // block comment and blanks a valid character class.
    const charClass = "const re = /[/*][*/]/;";
    expect(stripComments(charClass)).toBe(charClass);

    const closer = 'const s = "ends with a block comment closer: */";';
    expect(stripComments(closer)).toBe(closer);

    // Real comments still go, and the code around them survives intact.
    const mixed = 'const a = 1; // note\nconst b = "//not a comment";';
    const strippedMixed = stripComments(mixed);
    expect(strippedMixed).toContain('const b = "//not a comment";');
    expect(strippedMixed).not.toContain("note");
    // Offsets are preserved so chunk boundaries and line numbers do not shift.
    expect(strippedMixed).toHaveLength(mixed.length);
  });

  test("a comment opener inside a string cannot hide an offender", () => {
    // This is the fail-open the regex stripper actually produced, not a
    // hypothetical. `"/*"` in a string paired with the next real `*/` made the
    // regex delete everything between them — including the offender's own
    // closing `});` and the boundary before the compliant mutation. The two
    // chunks merged, the offender inherited its neighbour's
    // `syncDeferredSocialThreads(` call, and a mutation that syncs nothing was
    // reported as clean.
    const source = [
      'import { socialBulkMutation } from "./functions";',
      "",
      "export const offender = socialBulkMutation({",
      "  args: {},",
      "  handler: async (ctx) => {",
      '    const blockOpener = "/*";',
      "    await ctx.db.patch(id, { blockOpener });",
      "  },",
      "});",
      "",
      "/* a perfectly ordinary comment */",
      "export const compliant = socialBulkMutation({",
      "  args: {},",
      "  handler: async (ctx) => {",
      "    const threads = newDeferredSocialThreads();",
      '    collectSocialThread(threads, "instagram", doc);',
      "    await syncDeferredSocialThreads(ctx, threads);",
      "  },",
      "});",
      "",
    ].join("\n");

    const offenders = deferredMutationOffenders(source, "x.ts");
    expect(offenders).toEqual([
      "x.ts:offender uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:offender uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("every mutation built on socialBulkMutation syncs the threads it touched", () => {
    const offenders: string[] = [];

    for (const file of convexModules(CONVEX_DIR)) {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      if (rel === BUILDER_OWNER) continue;
      offenders.push(...deferredMutationOffenders(fs.readFileSync(file, "utf8"), rel));
    }

    expect(offenders).toEqual([]);
  });

  test("a second non-syncing mutation in an already-compliant module is caught", () => {
    // The exact hole the per-file version had: `setConversationVehicle` syncs,
    // so the module passed no matter what was added beside it.
    const source = `
import { socialBulkMutation } from "./functions";

export const good = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    const threads = newDeferredSocialThreads();
    collectSocialThread(threads, "instagram", doc);
    await syncDeferredSocialThreads(ctx, threads);
  },
});

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { vehicleId: undefined });
  },
});
`;
    const offenders = deferredMutationOffenders(source, "socialInbox.ts");
    expect(offenders).toEqual([
      "socialInbox.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "socialInbox.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("an aliased import of the builder cannot hide a non-syncing mutation", () => {
    // Fifth fail-open in this helper, and the first found by review rather than
    // by a failure: the scan matched the builder's *spelling* at the call site
    // (`= socialBulkMutation(`) rather than the binding it resolves to. A named
    // import renamed on the way in is ordinary TypeScript, and it defeated both
    // halves at once — the mutation appeared in neither the offender list nor
    // the armed list, so the "guard is armed" test still saw exactly the two
    // known mutations and stayed green.
    //
    // `mayHoldDeferredMutation` is not the backstop it looks like here: the raw
    // source still contains `socialBulkMutation` on the import line, so the file
    // is parsed, and then nothing matches.
    const source = `
import { socialBulkMutation as deferredMutation } from "./functions";

export const bad = deferredMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { customerId });
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
    expect(deferredMutationsIn(source, "x.ts")).toEqual(["x.ts:bad"]);
  });

  test("a namespace import of the builder cannot hide a non-syncing mutation", () => {
    // The other spelling that reaches the same builder without ever writing
    // `= socialBulkMutation(`.
    const source = `
import * as fns from "./functions";

export const bad = fns.socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { customerId });
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
    expect(deferredMutationsIn(source, "x.ts")).toEqual(["x.ts:bad"]);
  });

  test("re-exporting the builder under another name fails the guard closed", () => {
    // The escape the two tests above cannot close by binding resolution alone.
    // If a module re-exports the builder, an importer of *that* module never
    // names `socialBulkMutation` at all, so `mayHoldDeferredMutation` skips it
    // before any parsing happens and no amount of care at the call site helps.
    //
    // The guard cannot follow arbitrary indirection, so it refuses it: the
    // module doing the re-export is itself reported. That keeps the failure at
    // the one place that can see what is happening.
    const source = `
import { socialBulkMutation } from "./functions";

export const deferredMutation = socialBulkMutation;
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:deferredMutation re-exports socialBulkMutation under another name, which this guard cannot follow",
    ]);
  });

  test("a comment mentioning the call does not satisfy the obligation", () => {
    const source = `
import { socialBulkMutation } from "./functions";

// Remember to call syncDeferredSocialThreads(ctx, threads) and
// collectSocialThread(threads, platform, doc) here.
export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toHaveLength(2);
  });

  test("a comment in ANY position cannot satisfy the obligation", () => {
    // The position above — leading trivia before `export const` — is the one a
    // `forEachChild` walk happens to reach. These are the ones it misses,
    // because `forEachChild` skips punctuation tokens so the leading trivia of
    // a closing `}` or `)` is never visited. The first is the likeliest comment
    // anyone would actually write.
    const positions: Record<string, string> = {
      "end of handler body": `
export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
    // TODO: syncDeferredSocialThreads(ctx, threads) and collectSocialThread(threads, p, d)
  },
});
`,
      "before the closing paren": `
export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => { await ctx.db.patch(id, {}); },
  // syncDeferredSocialThreads(ctx, threads) / collectSocialThread(threads, p, d)
});
`,
      "after the last args property": `
export const bad = socialBulkMutation({
  args: { a: v.string() },
  // syncDeferredSocialThreads(ctx, threads) / collectSocialThread(threads, p, d)
  handler: async (ctx) => { await ctx.db.patch(id, {}); },
});
`,
    };

    for (const [where, source] of Object.entries(positions)) {
      expect(
        deferredMutationOffenders(source, "x.ts"),
        `a comment at the ${where} satisfied the obligation`
      ).toHaveLength(2);
    }
  });

  test("only modules that could hold the builder are parsed", () => {
    // Parsing every Convex module twice blew CI's 5s timeout under coverage.
    // A module that never names the builder cannot hold an offender, so it is
    // skipped before the parser sees it.
    const unrelated = "export const x = mutation({ args: {}, handler: async () => {} });\n";
    expect(deferredMutationOffenders(unrelated, "x.ts")).toEqual([]);
    expect(deferredMutationsIn(unrelated, "x.ts")).toEqual([]);

    const scanned = convexModules(CONVEX_DIR).filter((file) =>
      fs.readFileSync(file, "utf8").includes("socialBulkMutation")
    );
    // Small and bounded. If this grows to most of the tree, the scan is heading
    // back toward the timeout that made a required check flaky.
    expect(scanned.length).toBeLessThanOrEqual(10);
  });

  test("an offender at the very start of a module is still caught", () => {
    // No leading newline: `bad` is at offset 0. Splitting on a newline-prefixed
    // `export const` produced zero chunks, so the first definition in a module
    // was never examined and came back clean.
    const source = `export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});
`;
    expect(source.startsWith("export const")).toBe(true);
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
    expect(deferredMutationsIn(source, "x.ts")).toEqual(["x.ts:bad"]);
  });

  test("a helper defined after the offender cannot lend it the calls", () => {
    // The chunk for `bad` used to run to the next `export const` — here, to
    // EOF — swallowing the helper below and its two calls, so `bad` passed.
    const source = `
import { socialBulkMutation } from "./functions";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});

async function unrelatedHelper(ctx) {
  const threads = newDeferredSocialThreads();
  collectSocialThread(threads, "instagram", doc);
  await syncDeferredSocialThreads(ctx, threads);
}
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("every Convex module has balanced block-comment delimiters", () => {
    // `stripComments` deletes everything between `/*` and the next `*/`. An
    // unbalanced `/*` inside a string or regex literal would therefore swallow
    // real code — including, in the worst case, a non-syncing mutation, which
    // would vanish from the scan entirely. That is the one shape in the
    // stripper that fails OPEN rather than merely producing a noisy build, so
    // it is pinned rather than reasoned about.
    const unbalanced: string[] = [];
    for (const file of convexModules(CONVEX_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      const opens = (source.match(/\/\*/g) ?? []).length;
      const closes = (source.match(/\*\//g) ?? []).length;
      if (opens !== closes) {
        unbalanced.push(`${path.relative(CONVEX_DIR, file)}: ${opens} open vs ${closes} close`);
      }
    }
    expect(unbalanced).toEqual([]);
  });

  test("the guard is armed — it sees the real mutations", () => {
    // A guard nobody has watched fail is not a guard. If the builder is renamed
    // the scan silently matches nothing and passes having checked no code.
    //
    // Shares `deferredMutationOffenders`' chunking rather than re-implementing
    // it. A second scan of the same thing is exactly how two interpretations of
    // one invariant drift apart — the mistake the namespaced thread key already
    // made once in this feature. The unbounded version here attributed a
    // non-exported `socialBulkMutation` to the preceding export.
    const found: string[] = [];
    for (const file of convexModules(CONVEX_DIR)) {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      if (rel === BUILDER_OWNER) continue;
      found.push(...deferredMutationsIn(fs.readFileSync(file, "utf8"), rel));
    }

    expect(found.sort()).toEqual([
      "customers.ts:mergeCustomers",
      "socialInbox.ts:setConversationVehicle",
    ]);
  });

  test("the builder itself is only defined in functions.ts", () => {
    const definitions = convexModules(CONVEX_DIR).filter((file) =>
      fs.readFileSync(file, "utf8").includes("export const socialBulkMutation")
    );
    expect(definitions.map((f) => path.basename(f))).toEqual(["functions.ts"]);
  });
});
