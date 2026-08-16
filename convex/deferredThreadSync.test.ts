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
 * ⚠️ `stripComments` USED TO LIVE HERE, and its removal is the point.
 *
 * The obligation check ran over comment-stripped text, so a stripper was
 * needed — and it was the single most defect-prone thing in this file. It went
 * through a regex version (a comment opener inside a string swallowed real
 * code, including a closing `});` boundary, merging two definitions so an
 * offender inherited its neighbour's calls), then a `ts.createScanner` version
 * (no syntactic context, so a regex character class holding both comment
 * delimiters came back blanked), then a parser-with-`getChildren` version. Each
 * fix was correct and each still fed a text scan.
 *
 * The AST never sees a comment: trivia does not become a node. So the whole
 * class — comments, strings, template literals, regex literals mimicking
 * comment syntax — stopped being expressible rather than being handled. The
 * tests that pinned those behaviours through `deferredMutationOffenders` are
 * kept and still pass; the two that tested the stripper directly, and the one
 * pinning balanced block-comment delimiters across the tree, were removed with
 * it, because they assert properties of a mechanism this file no longer has.
 *
 * ⚠️ Writing this very docblock broke the file once, because the prose quoted
 * the closing delimiter and ended the comment early. The hazard is real enough
 * to bite the note explaining it.
 */

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
 * Both halves of the settlement obligation. Collecting without syncing leaves
 * the rows stale; syncing without collecting recomputes an empty set, which
 * looks exactly like success.
 */
const REQUIRED_HELPERS = ["syncDeferredSocialThreads", "collectSocialThread"] as const;
type RequiredHelper = (typeof REQUIRED_HELPERS)[number];

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
function resolveBuilderImports(sourceFile: ts.SourceFile): {
  named: Set<string>;
  namespaces: Set<string>;
} {
  // The builder's own name is always a binding, whether or not an import
  // declaration was found. Resolution ADDS the aliases a spelling match would
  // miss; it must never subtract the spelling itself. Dropping it made every
  // fixture without an import line invisible — the same fail-open shape as the
  // bug this function exists to fix, introduced by the fix for it.
  const named = new Set<string>([BUILDER]);
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;

    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }

    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // `propertyName` is set only when the import is renamed, in which case it
      // holds the ORIGINAL name and `name` holds the local one.
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === BUILDER) named.add(element.name.text);
    }
  }

  return { named, namespaces };
}


/** Whether an expression node resolves to the deferred builder. */
function isBuilderReference(
  node: ts.Expression,
  named: Set<string>,
  namespaces: Set<string>
): boolean {
  if (ts.isIdentifier(node)) return named.has(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === BUILDER &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    );
  }
  return false;
}

/**
 * THE representation of a deferred mutation. One AST fact, derived once.
 *
 * ## Why this replaced the text scan, rather than patching it again
 *
 * The guard used to be two mechanisms that had to agree: `builderEscapes`
 * resolved the builder through the AST, while discovery and the obligation
 * check ran a regex shaped like `= <binding>(` over comment-stripped, `export
 * const`-split chunks. Two representations of one invariant is how they drift,
 * and they did — repeatedly, always failing OPEN:
 *
 *   - a comment opener inside a string swallowed a chunk boundary
 *   - a definition at offset 0 produced no chunk at all
 *   - a chunk ran on into the next definition and borrowed its calls
 *   - an aliased import defeated the spelling
 *   - and finally: `socialBulkMutation<void, void>({...})`. The AST reads that
 *     as a direct builder call and approves it; the regex needs the paren to
 *     follow the name immediately, so it matched nothing and the mutation was
 *     invisible to BOTH the offender list and the armed list. The builder is
 *     exposed through a generic callable type by the convex-helpers version
 *     this repo uses, so explicit type arguments are ordinary and legal.
 *
 * Five fail-opens of the same shape is a design fault, not five bad patches. So
 * discovery and obligation now read the SAME nodes: a deferred mutation is an
 * exported const whose initializer is a CallExpression whose callee resolves to
 * the builder binding, and its obligation is checked by walking that call's own
 * subtree. Type arguments, comments, formatting, neighbouring definitions and
 * declaration order stop being able to matter, because none of them is a
 * CallExpression.
 */
type DeferredMutation = { name: string; call: ts.CallExpression };

function findDeferredMutations(source: string): DeferredMutation[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const { named, namespaces } = resolveBuilderImports(sourceFile);
  const found: DeferredMutation[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isCallExpression(init)) continue;
      if (!isBuilderReference(init.expression, named, namespaces)) continue;
      if (!ts.isIdentifier(decl.name)) continue;
      // Only exported consts are Convex functions. A non-exported one is not a
      // mutation at all, and `builderEscapes` reports it as unsupported
      // indirection rather than letting it pass unexamined.
      if ((ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) === 0) continue;
      found.push({ name: decl.name.text, call: init });
    }
  }

  return found;
}

/** The module that may hand out the settlement helpers. */
const HELPER_MODULE = "./aggregates";

/**
 * Which settlement helpers this module has legitimately bound.
 *
 * The builder was made binding-aware and these two were left matched by callee
 * NAME — the same asymmetry, one layer down, and it made the obligation
 * satisfiable by anything spelled correctly:
 *
 *     function syncDeferredSocialThreads() {}   // a local stub that does nothing
 *     fake.syncDeferredSocialThreads(ctx, t);   // only the last segment matched
 *
 * Either one reported a mutation as compliant while it settled nothing, which
 * is precisely the silent staleness this file exists to prevent.
 *
 * The contract is deliberately narrow, because these are safety helpers and
 * there is no legitimate reason to reach them any other way: a DIRECT named
 * import from `./aggregates`, unaliased. Aliases, wrappers and namespace
 * indirection are rejected for the same reason they are rejected for the
 * builder — not because they are wrong, but because this guard cannot follow
 * them and must not pretend otherwise.
 *
 * ⚠️ A local declaration of the same name DISQUALIFIES the import, rather than
 * being ignored. If a module both imports `collectSocialThread` and declares
 * something by that name, which one a given call site resolves to depends on
 * scope, and a build guard that guesses is a build guard that fails open.
 *
 * Full `ts.Program` symbol resolution would settle it exactly, and is
 * deliberately not used: this scan already blew CI's 5s timeout once under
 * coverage instrumentation, and constructing a Program over the Convex tree is
 * far heavier than parsing three files. The narrow contract gets the same
 * answer for every shape that can legitimately occur here.
 */
function resolveHelperImports(sourceFile: ts.SourceFile): Set<string> {
  const bound = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text !== HELPER_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // `propertyName` set means the import was renamed — rejected.
      if (element.propertyName) continue;
      if (REQUIRED_HELPERS.includes(element.name.text as RequiredHelper)) {
        bound.add(element.name.text);
      }
    }
  }

  // Anything the module also declares locally under one of these names makes
  // the binding ambiguous, so it stops counting as bound.
  const shadowed = new Set<string>();
  const findShadows = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && bound.has(node.name.text)) {
      shadowed.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && bound.has(node.name.text)) {
      shadowed.add(node.name.text);
    }
    node.forEachChild(findShadows);
  };
  findShadows(sourceFile);
  for (const name of shadowed) bound.delete(name);

  return bound;
}

/**
 * Whether the imported helper `name` is CALLED anywhere inside this subtree.
 *
 * A call, not a mention: an identifier in a comment is trivia and never becomes
 * a node, and a string containing the name is a StringLiteral. Both classes of
 * false satisfaction that the text scan kept re-admitting are structurally
 * impossible here, which is why the tests pinning them survive unchanged.
 *
 * The callee must be a bare Identifier that the module bound properly. A
 * property access is rejected outright: `fake.syncDeferredSocialThreads()` is
 * not the imported helper no matter how it is spelled.
 */
function callsHelper(root: ts.Node, name: string, bound: Set<string>): boolean {
  if (!bound.has(name)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === name) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/**
 * Every use of the builder that is not a direct call defining an exported
 * mutation.
 *
 * ## Why this is an invariant and not a list of forbidden spellings
 *
 * The first attempt at this enumerated alias syntaxes: it inspected variable
 * declarations whose initializer was an identifier. That caught
 * `export const x = socialBulkMutation` and nothing else, while claiming to
 * close indirection generally. Two ordinary forms walked straight past it —
 * `export const x = fns.socialBulkMutation` (a PropertyAccessExpression, not an
 * identifier) and `export { socialBulkMutation as x } from "./functions"` (an
 * ExportDeclaration, which has no initializer to inspect at all). A wrapper
 * function was never even in scope of the idea.
 *
 * Enumerating syntaxes cannot work here, because the set is open and the guard
 * fails OPEN on anything it has not thought of. So the question asked is
 * inverted: every reference to the resolved binding must be one of exactly two
 * approved things —
 *
 *   1. its own import (its legitimate entry point), or
 *   2. the direct callee of a call that initializes an EXPORTED const.
 *
 * Anything else — alias, re-export, wrapper, property assignment, a reference
 * passed as an argument — is indirection this guard cannot follow, so it fails
 * closed and says so.
 *
 * ## Why the re-exporting module is the one that must fail
 *
 * Binding resolution cannot cross module boundaries here. Once a module does
 * `export { socialBulkMutation as deferredMutation }`, an importer of THAT
 * module contains no literal `socialBulkMutation` anywhere — so
 * `mayHoldDeferredMutation` skips it before the parser ever runs, and no care
 * at the call site can help. The bridge module is the last point at which the
 * escape is still visible, which is why the bridge is what gets reported.
 */
function builderEscapes(source: string, rel: string): string[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const { named, namespaces } = resolveBuilderImports(sourceFile);
  const offenders: string[] = [];

  /** `export const name = <builder>({ ... })` — the one approved shape. */
  const isApprovedMutationCall = (ref: ts.Node): boolean => {
    const call = ref.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== ref) return false;
    const decl = call.parent;
    if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== call) return false;
    // `getCombinedModifierFlags` walks a declaration up to the statement that
    // actually carries the modifiers, which is where `export` lives.
    return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0;
  };

  /** The nearest named declaration, so the message points somewhere findable. */
  const describe = (node: ts.Node): string => {
    let current: ts.Node | undefined = node;
    while (current) {
      if (
        (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) &&
        current.name &&
        ts.isIdentifier(current.name)
      ) {
        return current.name.text;
      }
      current = current.parent;
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `line ${line + 1}`;
  };

  const escape = (node: ts.Node) => {
    offenders.push(
      `${rel}:${describe(node)} references ${BUILDER} outside a direct exported-mutation call, which this guard cannot follow`
    );
  };

  const visit = (node: ts.Node): void => {
    // The import IS the legitimate entry point. Nothing inside it is a use.
    if (ts.isImportDeclaration(node)) return;

    // `export { socialBulkMutation as x }`, with or without a `from` clause.
    // Checked by name rather than by binding because the `from` form does not
    // import anything into local scope at all.
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          if (exported === BUILDER || named.has(exported)) {
            offenders.push(
              `${rel}:${element.name.text} re-exports ${BUILDER}, which this guard cannot follow`
            );
          }
        }
      }
      return;
    }

    // `fns.socialBulkMutation` reached through a namespace import.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === BUILDER &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      if (!isApprovedMutationCall(node)) escape(node);
      return;
    }

    if (ts.isIdentifier(node) && named.has(node.text)) {
      // The `name` half of some other object's property access is a different
      // symbol that merely shares the spelling, not a reference to the binding.
      if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        return;
      }
      if (!isApprovedMutationCall(node)) escape(node);
      return;
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return offenders;
}

/**
 * One `rel:name` per exported mutation built on `socialBulkMutation`.
 *
 * Reads the SAME representation the obligation check reads, so the two cannot
 * disagree about what a deferred mutation is. They used to be a shared regex,
 * which is not the same thing: a shared expression evaluated over two
 * separately-derived strings still drifts, and the "guard is armed" test then
 * confirms the drift instead of catching it.
 */
export function deferredMutationsIn(source: string, rel: string): string[] {
  if (!mayHoldDeferredMutation(source)) return [];
  return findDeferredMutations(source).map((m) => `${rel}:${m.name}`);
}

export function deferredMutationOffenders(source: string, rel: string): string[] {
  if (!mayHoldDeferredMutation(source)) return [];
  // Indirection this guard cannot follow is reported, not tolerated — and it is
  // checked first because a module that only re-exports the builder has no call
  // sites of its own to find.
  const offenders: string[] = builderEscapes(source, rel);

  const helperBindings = resolveHelperImports(
    ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true)
  );

  for (const mutation of findDeferredMutations(source)) {
    // The subtree of THIS call, so a neighbouring definition or a helper
    // declared afterwards cannot lend it calls it never makes. Scope comes from
    // the tree rather than from guessing where a definition ends, which is what
    // the old `\n});` boundary search was doing.
    for (const helper of REQUIRED_HELPERS) {
      if (!callsHelper(mutation.call, helper, helperBindings)) {
        offenders.push(`${rel}:${mutation.name} uses ${BUILDER} but never calls ${helper}`);
      }
    }
  }

  return offenders;
}

describe("deferred conversation sync", () => {

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
      // Real modules import the settlement helpers; the guard now requires it,
      // so a fixture that omits the import is not a compliant module.
      'import { collectSocialThread, syncDeferredSocialThreads } from "./aggregates";',
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
import { collectSocialThread, syncDeferredSocialThreads } from "./aggregates";

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

  test("a locally defined fake helper does not satisfy the obligation", () => {
    // The builder was made binding-aware; the two SETTLEMENT helpers were not.
    // They were matched by callee name, so anything spelled right satisfied
    // them — including a local stub that does nothing at all. That is the
    // guard's own failure mode pointed at its other half: a mutation that
    // settles nothing reports as compliant.
    const source = `
import { socialBulkMutation } from "./functions";

function collectSocialThread() {}
function syncDeferredSocialThreads() {}

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { customerId });
    collectSocialThread();
    await syncDeferredSocialThreads();
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("a helper shadowed inside the handler does not satisfy the obligation", () => {
    // The REAL shadowing case, and the one my first attempt missed.
    //
    // `import { collectSocialThread } ...` plus a top-level
    // `function collectSocialThread() {}` is a duplicate-identifier error, so
    // that shape cannot occur. What CAN occur is an inner binding shadowing the
    // import inside the handler — ordinary, legal TypeScript. The call then
    // resolves to the local stub while the module still imports the real helper
    // perfectly.
    //
    // ⚠️ Found by mutation testing, not by writing the test: deleting the
    // shadow-detection left all 20 tests green, because the "local fake helper"
    // fixture above has no import at all and was already failing for a
    // different reason. A surviving mutant is itself the finding.
    const source = `
import { socialBulkMutation } from "./functions";
import { collectSocialThread, syncDeferredSocialThreads } from "./aggregates";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    const collectSocialThread = () => {};
    const syncDeferredSocialThreads = async () => {};
    await ctx.db.patch(id, { customerId });
    collectSocialThread();
    await syncDeferredSocialThreads();
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("a property call with the right final name does not satisfy the obligation", () => {
    // `callsFunction` read only the LAST segment of a property access, so any
    // object exposing a same-named method counted — `fake.syncDeferred...()`
    // is not the imported helper and settles nothing.
    const source = `
import { socialBulkMutation } from "./functions";
import { collectSocialThread, syncDeferredSocialThreads } from "./aggregates";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { customerId });
    fake.collectSocialThread(threads, "instagram", doc);
    await fake.syncDeferredSocialThreads(ctx, threads);
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("the settlement helpers must be direct named imports from ./aggregates", () => {
    // Aliasing or re-homing the safety helpers is the same indirection the
    // builder already rejects. Accepting it here would leave the obligation
    // satisfiable by something that merely resolves to the right spelling.
    const aliased = `
import { socialBulkMutation } from "./functions";
import { collectSocialThread as collect, syncDeferredSocialThreads as sync } from "./aggregates";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    collect(threads, "instagram", doc);
    await sync(ctx, threads);
  },
});
`;
    expect(deferredMutationOffenders(aliased, "x.ts")).toHaveLength(2);

    // ⚠️ The shape the `propertyName` guard actually defends, and the one the
    // alias fixture above does NOT reach. Aliasing the helper to a new name is
    // already excluded because the local name is not one of the required
    // helpers — so that case never exercises the guard. The dangerous form is
    // the REVERSE: importing some OTHER export under the helper's name, which
    // binds the right spelling to the wrong function.
    //
    // Found by mutation testing: deleting the `propertyName` check left all 21
    // green until this case existed.
    const renamedOntoHelper = `
import { socialBulkMutation } from "./functions";
import { somethingElse as collectSocialThread, other as syncDeferredSocialThreads } from "./aggregates";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    collectSocialThread(threads, "instagram", doc);
    await syncDeferredSocialThreads(ctx, threads);
  },
});
`;
    expect(deferredMutationOffenders(renamedOntoHelper, "x.ts")).toHaveLength(2);

    const wrongModule = `
import { socialBulkMutation } from "./functions";
import { collectSocialThread, syncDeferredSocialThreads } from "./elsewhere";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    collectSocialThread(threads, "instagram", doc);
    await syncDeferredSocialThreads(ctx, threads);
  },
});
`;
    expect(deferredMutationOffenders(wrongModule, "x.ts")).toHaveLength(2);
  });

  test("explicit type arguments cannot hide a non-syncing mutation", () => {
    // The bypass that forced this guard to stop being two mechanisms.
    //
    // `builderEscapes` resolves the binding through the AST and correctly reads
    // this as a direct builder call, so it raises nothing. Discovery and the
    // obligation check were a SEPARATE regex — `= <binding>(` — which requires
    // the paren to follow the name immediately, so `socialBulkMutation<void,
    // void>(` matched nothing. The mutation appeared in neither the offender
    // list nor the armed list.
    //
    // Not hypothetical syntax: the custom builder is exposed through a generic
    // callable type by the convex-helpers version this repo uses, so writing
    // the type arguments explicitly is ordinary and legal.
    const source = `
import { socialBulkMutation } from "./functions";

export const bad = socialBulkMutation<void, void>({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
    expect(deferredMutationsIn(source, "x.ts")).toEqual(["x.ts:bad"]);
  });

  test("a namespace-property alias of the builder fails the guard closed", () => {
    // `fns.socialBulkMutation` is a PropertyAccessExpression, not an
    // Identifier, so an alias check that only inspected identifier
    // initializers never saw it. Same escape as the plain alias below, one
    // syntax node different.
    const source = `
import * as fns from "./functions";

export const deferredMutation = fns.socialBulkMutation;
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:deferredMutation references socialBulkMutation outside a direct exported-mutation call, which this guard cannot follow",
    ]);
  });

  test("an export-declaration re-export of the builder fails the guard closed", () => {
    // An `export ... from` is an ExportDeclaration — it has no variable
    // statement and no initializer at all, so nothing that inspects
    // declarations can see it.
    //
    // This is the form that matters most, because it is the one that hides the
    // consumer completely: a module importing `deferredMutation` from here
    // contains no literal `socialBulkMutation`, so `mayHoldDeferredMutation`
    // skips it before the parser ever runs. The bridge module is the last place
    // the escape is still visible, so the bridge is what must fail.
    const source = `export { socialBulkMutation as deferredMutation } from "./functions";\n`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:deferredMutation re-exports socialBulkMutation, which this guard cannot follow",
    ]);
  });

  test("wrapping the builder in a function fails the guard closed", () => {
    // Not a spelling of an alias — a wrapper. Enumerating alias syntaxes would
    // never have reached this one, which is why the invariant is now "every
    // reference is a direct exported-mutation call" rather than a list of
    // forbidden shapes.
    const source = `
import { socialBulkMutation } from "./functions";

const wrap = (...args) => socialBulkMutation(...args);

export const bad = wrap({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:wrap references socialBulkMutation outside a direct exported-mutation call, which this guard cannot follow",
    ]);
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
      "x.ts:deferredMutation references socialBulkMutation outside a direct exported-mutation call, which this guard cannot follow",
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
