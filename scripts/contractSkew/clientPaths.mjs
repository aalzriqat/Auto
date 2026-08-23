/**
 * Extract, from client source, the field PATHS each Convex call actually sends.
 *
 * ⚠️ WHY THE TYPECHECKER AND NOT PATTERN MATCHING.
 *
 * The defect this exists to catch was a field named `rowId` added inside
 * `vehicles: v.array(v.object({...}))`. At the call site the client writes:
 *
 *     importBulk({ orgId, acquisitionPosting, importId, vehicles: payload })
 *
 * A regex — or any syntactic walk of the object literal — sees `vehicles` and
 * stops. The incompatible field is not in the literal at all; it is inside the
 * TYPE of `payload`, which was built several statements earlier by a `.map()`.
 * Only a type-aware pass can see through that, which is why this module builds
 * a real `ts.Program` and asks the checker.
 *
 * Paths are emitted in the same grammar the spec side uses, so the two can be
 * compared directly:
 *
 *     orgId
 *     vehicles[*]
 *     vehicles[*].rowId
 *     vehicles[*].valuations[*].companyName
 *
 * ⚠️ UNRESOLVABLE IS NOT COMPATIBLE. Where a payload is `any`, an index
 * signature, or otherwise not statically knowable, this records an UNKNOWN at
 * that path instead of silently emitting nothing. A missing path and an
 * unknowable path are opposite findings: the first says "the client does not
 * send this", the second says "we cannot tell". Collapsing them would let the
 * detector report a clean result for a payload it never understood, which is
 * the one outcome that would make this control worse than useless.
 */
import ts from "typescript";
import path from "node:path";
import { clientNode, mergeClientNodes } from "./contractTree.mjs";
import { normalizeSurfacePath } from "./clientFiles.mjs";

/** Hooks and helpers whose first argument is a Convex function reference. */
const CLIENT_BINDERS = new Set(["useMutation", "useQuery", "useAction", "usePaginatedQuery"]);
/**
 * Hooks that take the PAYLOAD INLINE, at the hook call itself.
 *
 * ⚠️ Queries are not deferred functions. `useMutation` returns something you
 * call later with a payload; `useQuery(api.x.y, { orgId })` sends its arguments
 * immediately and returns DATA. Treating both the same way made every
 * `const { results } = usePaginatedQuery(...)` look like an unfollowable
 * destructured binding — 53 of the 63 "unresolved" call sites in the first
 * whole-repo baseline were this one category error, not a real limit.
 */
const INLINE_PAYLOAD_BINDERS = new Set(["useQuery", "usePaginatedQuery"]);
/**
 * `useQuery(fn, "skip")` does not run, so it transmits nothing.
 *
 * ⚠️ THE REAL IDIOM IS A TERNARY, NOT A BARE LITERAL. Every one of the 283
 * occurrences in this repo is `useQuery(fn, cond ? args : "skip")`, and none is
 * the bare `useQuery(fn, "skip")` the original check looked for. The flat model
 * never noticed because merging a union into a path map quietly dropped the
 * string branch; the tree keeps it, and then correctly refuses a string where
 * the backend declares an object — 269 fabricated BREAKING findings until the
 * sentinel is removed where it actually appears.
 */
const SKIP_SENTINEL = "skip";

/**
 * Remove the non-running branch of a skippable query payload.
 *
 * Returns `null` when nothing but the sentinel remains. The caller decides what
 * that means, because two different situations arrive here looking identical
 * and they are NOT the same:
 *
 *   `cond ? undefined : "skip"`  the query RUNS, with no arguments. The
 *                                `undefined` branch was already dropped by the
 *                                optional-property rule inside collectPaths —
 *                                correct for a property, wrong at the payload
 *                                root, where it means "called with no args".
 *   `"skip"`                     the query provably never runs.
 *
 * ⚠️ Neither may drop the CALL SITE. Losing three sites to this is a silent
 * coverage hole of exactly the kind this control exists to detect.
 */
/**
 * @param {import("./contractTree.mjs").ClientNode} node
 * @returns {import("./contractTree.mjs").ClientNode | null}
 */
function stripSkipSentinel(node) {
  if (node.kind === "literal") {
    const values = [...node.values].filter((v) => v !== SKIP_SENTINEL);
    return values.length
      ? /** @type {import("./contractTree.mjs").ClientNode} */ (clientNode.literal(new Set(values)))
      : null;
  }
  if (node.kind === "variants") {
    const kept = node.nodes.map(stripSkipSentinel).filter(Boolean);
    return kept.length ? clientNode.variants(kept) : null;
  }
  if (node.kind === "assertion") {
    const inner = stripSkipSentinel(node.node);
    return inner
      ? /** @type {import("./contractTree.mjs").ClientNode} */ (clientNode.assertion(node.effect, inner))
      : null;
  }
  switch (node.kind) {
    case "unresolved":
    case "opaqueValue":
    case "scalar":
    case "id":
    case "object":
    case "array":
      return node;
    default: {
      /** @type {never} */
      const unhandled = node;
      return unhandled;
    }
  }
}
/** Direct invocation forms: convex.mutation(api.x.y, {...}) / ctx.runMutation(...). */
const DIRECT_CALLERS = new Set([
  "mutation", "query", "action",
  "runMutation", "runQuery", "runAction",
  "fetchQuery", "fetchMutation", "fetchAction",
  "preloadQuery",
]);

const MAX_DEPTH = 12;

/**
 * ⚠️ THIS ANNOTATION WAS WRONG FOR AS LONG AS NOBODY CHECKED IT. It still
 * described a `sent: Map<...>` that no longer exists, and because `checkJs` was
 * off the compiler inferred THAT shape for every consumer — reporting
 * `unresolvedBinders` and `casts` as properties that do not exist the moment
 * checking was switched on. A comment that drifts is a comment; an annotation
 * that drifts is a lie the toolchain repeats.
 *
 * @param {string[]} rootFiles  entry files to type-check
 * @param {string} tsconfigPath
 * @returns {{
 *   calls: Array<{
 *     identifier: string, file: string, line: number,
 *     payload: import("./contractTree.mjs").ClientNode | null,
 *     skipped?: boolean, unknowns: string[], casts: string[], via?: string
 *   }>,
 *   unresolvedBinders: Array<{identifier: string, file: string, line: number, cause: string, reason: string}>,
 *   diagnosticsCount: number
 * }}
 */
export function extractClientCalls(rootFiles, tsconfigPath) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );

  // ⚠️ A TSCONFIG THAT DID NOT LOAD IS NOT A TSCONFIG OF DEFAULTS.
  //
  // `readConfigFile` returns `{config, error}` and `parseJsonConfigFileContent`
  // returns `errors`; neither was inspected. A missing, unreadable or malformed
  // file left `config` undefined and `options` falling back to compiler
  // defaults. `createProgram` still SUCCEEDS, because rootFiles supplies the
  // root names — but it runs without the project's `paths`, `jsx`, `lib` and
  // `strict` settings, so type resolution collapses and every payload degrades
  // to `opaqueValue` or `unresolved`.
  //
  // The run then reports a wall of UNKNOWNs that looks like honest uncertainty
  // and is actually a broken toolchain. Refusing loudly is the only honest
  // answer: the caller asked us to read a project, and we could not.
  if (configFile.error) {
    throw new Error(
      `Cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`
    );
  }
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new Error(
      `Cannot parse ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`
    );
  }

  const program = ts.createProgram({
    rootNames: rootFiles.length ? rootFiles : parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const evidence = createEvidenceAnalysis(program, checker);

  const calls = [];
  const unresolvedBinders = [];

  // ⚠️ SCOPE IS THE DECLARED CLIENT, NOT THE WHOLE PROGRAM.
  //
  // `program.getSourceFiles()` returns every file the compiler pulled in,
  // including `convex/*.ts` reached through imports. Those were being scanned,
  // and their `ctx.runMutation` calls counted as client call sites: six of the
  // first whole-repo run's 86 unproven paths pointed at backend files, telling
  // a reader to go look at `convex/marketplaceRequests.ts:150` for a *client*
  // problem.
  //
  // A Convex-to-Convex call cannot skew this way at all. Caller and callee ship
  // in the same `convex deploy`, so they are never separately deployed — the
  // entire failure mode this control exists for is unreachable there. Counting
  // them inflated the coverage denominator with call sites that are
  // structurally incapable of the thing being measured.
  // ⚠️ ONE DEFINITION OF PATH IDENTITY, SHARED — NOT A SECOND COPY HERE.
  //
  // This used to lowercase unconditionally, which is the same defect already
  // fixed in `clientFiles.mjs`. Fixing one writer and leaving the other is
  // worse than either: two modules then answer "is this file in scope?"
  // differently, which is precisely what the shared helper exists to prevent.
  //
  // The direction of harm here is the opposite one. On Linux `convex/Foo.ts`
  // and `convex/foo.ts` are DIFFERENT files that collapsed to one key, so a
  // file never passed in `rootFiles` could pass this `inScope` test and be
  // scanned as a client call site — scope WIDENING, and fabricated findings
  // attributed to a file nobody asked to scan.
  const inScope = new Set(rootFiles.map((p) => normalizeSurfacePath(p)));

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    if (inScope.size && !inScope.has(normalizeSurfacePath(sourceFile.fileName))) continue;

    // ⚠️ KEYED BY SYMBOL, NOT BY NAME.
    //
    // Name-based binding is unsound and it produced eight fabricated BREAKING
    // findings on the first whole-repo run. `CustomFieldsSection.tsx` holds BOTH
    // a Convex mutation and a `useState` setter called `setValues`; matching on
    // the text `setValues` attributed React state updates to
    // `api.orgCustomFields.setValues`, whose payload naturally did not match the
    // validator. The collision is not exotic — a mutation named `setX` beside a
    // `const [x, setX] = useState()` is ordinary React.
    //
    // The checker resolves each identifier to the declaration it actually binds,
    // so shadowing and same-name-different-scope stop mattering.
    /** @type {Map<import("typescript").Symbol,string>} */
    const bound = new Map();
    /** Hook calls already resolved by the inline-payload pass. */
    const inlineResolved = new Set();

    // Pass 1: bind hook results to their Convex function identifier.
    const bind = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        CLIENT_BINDERS.has(node.initializer.expression.text) &&
        node.initializer.arguments.length > 0 &&
        ts.isIdentifier(node.name)
      ) {
        const id = apiReferenceToIdentifier(node.initializer.arguments[0]);
        const symbol = checker.getSymbolAtLocation(node.name);
        if (id && symbol) bound.set(symbol, id);
      }
      ts.forEachChild(node, bind);
    };
    bind(sourceFile);

    // Queries: payload is argument[1] at the hook call, so resolve it here
    // regardless of how (or whether) the result is bound.
    const visitInlinePayloadHooks = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        INLINE_PAYLOAD_BINDERS.has(node.expression.text) &&
        node.arguments.length > 0
      ) {
        const id = apiReferenceToIdentifier(node.arguments[0]);
        if (id) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const acc = { unknowns: [], casts: [] };
          const payloadExpr = node.arguments[1];
          const isSkip =
            payloadExpr && ts.isStringLiteral(payloadExpr) && payloadExpr.text === SKIP_SENTINEL;
          const collected =
            payloadExpr && !isSkip
              ? collectFromExpression(payloadExpr, {
                  checker,
                  prefix: "",
                  acc,
                  depth: 0,
                  seen: new Set(),
                  evidence,
                  expressionSeen: new Set(),
                })
              : null;
          const stripped = collected ? stripSkipSentinel(collected) : null;
          // Provably never runs: no transmission, so neither direction of the
          // comparison applies. That is knowable — NOT an unknown — and the
          // call site is still counted, because losing it would be a silent
          // coverage hole.
          const neverRuns = Boolean(
            !stripped && payloadExpr && !typeAdmitsUndefined(checker.getTypeAtLocation(payloadExpr))
          );
          // Runs with no arguments — knowable too, and it is what lets
          // Direction 2 notice a backend that started requiring one.
          const payload = stripped ?? (neverRuns ? null : EMPTY_PAYLOAD);
          calls.push({
            skipped: neverRuns,
            identifier: id,
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            payload,
            unknowns: acc.unknowns,
            casts: acc.casts,
            // Which hook produced this call. The comparator needs it because
            // `usePaginatedQuery` supplies `paginationOpts` itself, so demanding
            // it from the caller is a fabricated finding.
            via: node.expression.text,
          });
          inlineResolved.add(node);
        }
      }
      ts.forEachChild(node, visitInlinePayloadHooks);
    };
    visitInlinePayloadHooks(sourceFile);

    // ⚠️ A BINDER WE CANNOT FOLLOW IS A COVERAGE GAP, NOT A NON-EVENT.
    //
    // `bind` above only follows `const x = useMutation(api.a.b)`. A destructured
    // binding, a mutation returned from a custom hook, or one passed straight
    // into a callback is invisible to it — and silently emitting nothing for
    // those would let the run report PASS over call sites it never examined.
    // That is this control's own failure mode reproduced one level up, so each
    // one is recorded with its file and line and denies PASS.
    const findLooseBinders = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        CLIENT_BINDERS.has(node.expression.text) &&
        node.arguments.length > 0
      ) {
        const identifier = apiReferenceToIdentifier(node.arguments[0]);
        const parent = node.parent;
        const boundToSimpleName =
          parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name);
        if (!boundToSimpleName && !inlineResolved.has(node)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          unresolvedBinders.push({
            identifier: identifier ?? "<unresolved>",
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            cause: classifyBinder(node, identifier),
            reason: identifier
              ? "hook result is not bound to a simple name; its payload cannot be followed"
              : "the Convex function reference is not a literal api.* path",
          });
        }
      }
      ts.forEachChild(node, findLooseBinders);
    };
    findLooseBinders(sourceFile);

    // Pass 2: find invocations and read the payload's TYPE.
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        let identifier = null;
        let argExpr = null;

        // Form A: boundVariable({...}) — resolved through the symbol so a
        // same-named local (a useState setter, a prop) cannot be mistaken for
        // the mutation.
        if (ts.isIdentifier(node.expression)) {
          const symbol = resolveSymbol(checker, node.expression);
          if (symbol && bound.has(symbol)) {
            identifier = bound.get(symbol);
            argExpr = node.arguments[0] ?? null;
          }
        }

        // Form B: something.mutation(api.x.y, {...})
        if (
          !identifier &&
          ts.isPropertyAccessExpression(node.expression) &&
          DIRECT_CALLERS.has(node.expression.name.text) &&
          node.arguments.length > 0
        ) {
          const maybe = apiReferenceToIdentifier(node.arguments[0]);
          if (maybe) {
            identifier = maybe;
            argExpr = node.arguments[1] ?? null;
          }
        }

        if (identifier) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const acc = { unknowns: [], casts: [] };
          // Called with no payload at all is knowable, not unknown: an object
          // with no fields and a COMPLETE key set, which is exactly what lets
          // Direction 2 notice a backend that started requiring an argument.
          const payload = argExpr
            ? collectFromExpression(argExpr, {
                checker,
                prefix: "",
                acc,
                depth: 0,
                seen: new Set(),
                evidence,
                expressionSeen: new Set(),
              })
            : EMPTY_PAYLOAD;
          calls.push({
            identifier,
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            payload,
            unknowns: acc.unknowns,
            casts: acc.casts,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    calls,
    unresolvedBinders,
    diagnosticsCount: program.getSemanticDiagnostics().length,
  };
}

/**
 * Read a payload from its EXPRESSION, not merely from its type.
 *
 * ⚠️ THIS EXISTS BECAUSE THE REAL #235 CALL SITE IS `vehicles: chunk as any`.
 *
 * Asking the checker for the type of that argument yields `any`, so a purely
 * type-driven detector reports UNKNOWN for the single most important call site
 * in the codebase — it would not have caught the outage it was built to catch.
 *
 * A cast is an assertion by the author, not a change to what is transmitted:
 * `chunk as any` still sends `chunk`'s shape over the wire. The target type is
 * therefore ignored while a first-class assertion wrapper retains the trust
 * boundary. Object and array literals are walked syntactically for the same
 * reason — it keeps per-property precision when an inner property is cast.
 *
 * Every `as any` boundary is recorded in `casts`. That is deliberate: `as any` at a
 * Convex boundary disables the compiler's own contract checking, so it is worth
 * surfacing as a risk in its own right rather than silently compensating for it.
 */
/**
 * @typedef {{
 *   checker: import("typescript").TypeChecker,
 *   prefix: string,
 *   acc: {unknowns: string[], casts: string[]},
 *   depth: number,
 *   seen: Set<string>,
 *   evidence: ReturnType<typeof createEvidenceAnalysis>,
 *   expressionSeen: Set<import("typescript").Symbol>
 * }} ExpressionContext
 */

/**
 * @param {import("typescript").Expression} expr
 * @param {ExpressionContext} context
 */
function collectFromExpression(expr, context) {
  const { checker, prefix, acc, depth, seen, evidence, expressionSeen } = context;
  const nested = (nestedPrefix = prefix) => ({ ...context, prefix: nestedPrefix, depth: depth + 1 });
  if (depth > MAX_DEPTH) {
    acc.unknowns.push(`${prefix || "<root>"} (max depth)`);
    return clientNode.opaqueValue();
  }

  const node = expr;

  if (ts.isParenthesizedExpression(node)) {
    return collectFromExpression(node.expression, nested());
  }
  if (ts.isSatisfiesExpression?.(node)) return collectFromExpression(node.expression, nested());

  // Both `value as T` and `<T>value` are TypeScript assertions. The target is
  // never runtime evidence: recursively inspect the operand, then retain a
  // required wrapper so every consumer must account for the trust boundary.
  if (ts.isAssertionExpression(node)) {
    const toAny =
      node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword;
    if (toAny) acc.casts.push(`${prefix || "<root>"} (as any)`);
    return clientNode.assertion(
      "TYPE_CLAIM",
      collectFromExpression(node.expression, nested())
    );
  }

  if (ts.isNonNullExpression(node)) {
    const operand = collectFromExpression(node.expression, nested());
    return markNonNullErasure(operand);
  }

  // Follow immutable assertion-bearing aliases back to their runtime source.
  // The symbol stack prevents self-referential initializers from laundering
  // through an infinite recursion into a trusted checker type.
  if (ts.isIdentifier(node)) {
    const alias = evidence.assertionInitializer(node);
    if (alias) {
      if (expressionSeen.has(alias.symbol)) return clientNode.assertion("TYPE_CLAIM", clientNode.opaqueValue());
      expressionSeen.add(alias.symbol);
      try {
        return collectFromExpression(alias.expression, nested());
      } finally {
        expressionSeen.delete(alias.symbol);
      }
    }
  }

  if (ts.isObjectLiteralExpression(node)) {
    const fields = new Map();
    // The key set of an object LITERAL is knowable by construction. It stops
    // being knowable the moment a computed key or an unresolvable spread joins
    // it — and that distinction is the whole basis of the missing-required-
    // field direction, so it is tracked here rather than guessed later.
    let keysComplete = true;

    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // A spread's asserted target is not its runtime shape. Read the source
        // expression and unwrap only transparent TYPE_CLAIM wrappers.
        const spread = unwrapTypeClaims(
          collectFromExpression(prop.expression, nested())
        );
        if (spread.kind === "object") {
          applySpread(fields, spread);
          if (!spread.keysComplete) keysComplete = false;
        } else {
          // ⚠️ ANY OTHER SPREAD WITHDRAWS KEY COMPLETENESS, INCLUDING
          // `unresolved`. The previous condition excluded `unresolved`
          // explicitly, so the ONE case where we know least about what is being
          // spread was the one case that left `keysComplete` TRUE — the
          // extractor asserting the key set was PROVEN COMPLETE while
          // discarding a spread of unknown contents.
          //
          // Both comparison directions read that claim: Direction 2 demands
          // every required backend field of a key-complete object, and
          // Direction 1 reports an undeclared field as BREAKING. Fail-open in
          // one, fabricated in the other.
          acc.unknowns.push(`${prefix || "<root>"} (unresolvable spread)`);
          obscureOverwritableValues(fields);
          keysComplete = false;
        }
        continue;
      }
      const name = propertyName(prop);
      if (name === null) {
        // Computed key: the field name is not statically knowable, so this
        // object may carry keys we cannot see.
        acc.unknowns.push(`${prefix ? `${prefix}.` : ""}[computed]`);
        keysComplete = false;
        continue;
      }
      const childPath = prefix ? `${prefix}.${name}` : name;
      const value = ts.isPropertyAssignment(prop)
        ? prop.initializer
        : ts.isShorthandPropertyAssignment(prop)
          ? prop.name
          : null;
      const childNode = value
        ? collectFromExpression(value, nested(childPath))
        : clientNode.unresolved();
      fields.set(name, { node: childNode, provenance: "LITERAL", optional: false });
    }
    return clientNode.object(fields, keysComplete);
  }

  if (ts.isArrayLiteralExpression(node)) {
    const elementPath = `${prefix}[*]`;
    let element = null;
    for (const el of node.elements) {
      element = mergeClientNodes(
        element,
        collectFromExpression(el, nested(elementPath))
      );
    }
    // An array literal with no elements transmits none, which is knowable.
    // `array(unresolved)` would claim we could not read the element type and
    // then be compared as though it were a real one.
    if (element === null) return clientNode.emptyArray();
    return clientNode.array(element);
  }

  if (ts.isConditionalExpression(node)) {
    // `undefined` means no transmitted value. Preserve the other alternative
    // directly so a query's `cond ? undefined : "skip"` can still normalize to
    // the known empty-payload state after the sentinel is removed.
    if (isUndefinedExpression(node.whenTrue)) {
      return collectFromExpression(node.whenFalse, nested());
    }
    if (isUndefinedExpression(node.whenFalse)) {
      return collectFromExpression(node.whenTrue, nested());
    }
    return mergeClientNodes(
      collectFromExpression(node.whenTrue, nested()),
      collectFromExpression(node.whenFalse, nested())
    );
  }

  // An assertion hidden in an argument, property chain, alias, or local callee
  // body invalidates the enclosing checker type as provenance. Unsupported
  // flows degrade to opaque evidence; they never inherit the asserted target.
  if (evidence.hasTypeAssertionOrigin(node)) {
    return clientNode.assertion("TYPE_CLAIM", clientNode.opaqueValue());
  }

  // Not a literal — fall back to the assertion-free type of the expression.
  const type = checker.getTypeAtLocation(node);
  return collectPaths(checker, type, prefix, acc, depth, seen, "LITERAL");
}

function isUndefinedExpression(node) {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/** Apply a spread in source order; later properties overwrite earlier ones. */
function applySpread(fields, spread) {
  if (!spread.keysComplete) obscureOverwritableValues(fields);
  for (const [name, entry] of spread.fields) {
    const existing = fields.get(name);
    if (entry.optional && existing) {
      fields.set(name, {
        node: mergeClientNodes(existing.node, entry.node),
        provenance: existing.provenance,
        optional: false,
      });
      continue;
    }
    fields.set(name, {
      ...entry,
      provenance: entry.optional ? "TYPE_OPTIONAL" : "SPREAD",
    });
  }
}

/** An open/opaque later spread may replace any value already assigned. */
function obscureOverwritableValues(fields) {
  for (const [name, entry] of fields) {
    fields.set(name, { ...entry, node: clientNode.opaqueValue() });
  }
}

/** Remove transparent type-claim wrappers when a container must inspect shape. */
function unwrapTypeClaims(node) {
  let current = node;
  while (current.kind === "assertion" && current.effect === "TYPE_CLAIM") current = current.node;
  return current;
}

/**
 * Attach non-null uncertainty only to nullish alternatives actually erased by
 * `!`. A no-op assertion returns the original node byte-for-byte, while nested
 * variants preserve the wrapper on the affected member through later merges.
 */
function markNonNullErasure(node) {
  if (node.kind === "literal") {
    const erased = [...node.values].filter((value) => value === null || value === undefined);
    if (!erased.length) return node;
    const retained = [...node.values].filter((value) => value !== null && value !== undefined);
    const uncertain = clientNode.assertion("NON_NULL_ERASURE", clientNode.literal(new Set(erased)));
    return retained.length
      ? clientNode.variants([clientNode.literal(new Set(retained)), uncertain])
      : uncertain;
  }
  if (node.kind === "variants") {
    return clientNode.variants(node.nodes.map(markNonNullErasure));
  }
  if (node.kind === "assertion" && node.effect === "TYPE_CLAIM") {
    return clientNode.assertion("TYPE_CLAIM", markNonNullErasure(node.node));
  }
  return node;
}

/** A call that transmits no arguments at all: no keys, and we know it. */
const EMPTY_PAYLOAD = clientNode.object(new Map(), true);

/** Can this expression evaluate to `undefined` — i.e. "call it with no args"? */
function typeAdmitsUndefined(type) {
  if (type.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return true;
  if (type.isUnion?.()) {
    return type.types.some((t) => t.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  }
  return false;
}

function propertyName(prop) {
  const nameNode = prop.name;
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) return nameNode.text;
  if (ts.isNumericLiteral(nameNode)) return nameNode.text;
  return null; // computed
}

/**
 * Why could this binder not be followed?
 *
 * Grouping by CAUSE is what turns a scary total into a work plan. "412
 * unresolved" tells you nothing; "380 of them are one wrapper hook" tells you
 * where the single fix is. The causes are also not equally serious — a
 * destructured binding is an extractor limitation, while a dynamically chosen
 * function identity may be genuinely unanalysable.
 */
function classifyBinder(node, identifier) {
  if (!identifier) return "DYNAMIC_IDENTITY";
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && !ts.isIdentifier(parent.name)) {
    return "DESTRUCTURED_BINDING";
  }
  if (parent && (ts.isReturnStatement(parent) || ts.isArrowFunction(parent))) {
    return "WRAPPER_RETURN";
  }
  if (parent && (ts.isPropertyAssignment(parent) || ts.isObjectLiteralExpression(parent))) {
    return "WRAPPER_RETURN";
  }
  if (parent && ts.isCallExpression(parent)) return "INLINE_USE";
  return "OTHER_UNRESOLVED";
}

/**
 * Resolve an identifier to the symbol it actually binds, following aliases
 * (imports, re-exports) so a mutation imported from a shared module still
 * matches the declaration that bound it.
 */
function resolveSymbol(checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      /* not an alias after all */
    }
  }
  return symbol ?? null;
}

/**
 * Trace whether a checker type ultimately depends on a TypeScript assertion.
 *
 * Syntax is traversed generically with `forEachChild`, so a new expression
 * container cannot become an accidental laundering route. Symbols extend that
 * walk through immutable aliases and local function bodies. Mutable or written
 * bindings fail closed because their current runtime source is not statically
 * attributable to a single initializer.
 */
function createEvidenceAnalysis(program, checker) {
  const written = indexWrittenSymbols(program, checker);
  /** @type {Map<import("typescript").Symbol, boolean>} */
  const symbolMemo = new Map();
  /** @type {Set<import("typescript").Symbol>} */
  const visitingSymbols = new Set();

  function symbolHasAssertionOrigin(symbol) {
    if (written.has(symbol)) return true;
    const memoized = symbolMemo.get(symbol);
    if (memoized !== undefined) return memoized;
    if (visitingSymbols.has(symbol)) return false;
    visitingSymbols.add(symbol);
    let found = false;
    for (const declaration of symbol.declarations ?? []) {
      const source = evidenceSourceOfDeclaration(declaration);
      if (source.mutable || (source.node && hasAssertionOrigin(source.node))) {
        found = true;
        break;
      }
    }
    visitingSymbols.delete(symbol);
    symbolMemo.set(symbol, found);
    return found;
  }

  function hasAssertionOrigin(node) {
    if (ts.isAssertionExpression(node)) return true;
    if (ts.isIdentifier(node)) {
      const symbol = resolveSymbol(checker, node);
      if (symbol && symbolHasAssertionOrigin(symbol)) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && hasAssertionOrigin(child)) found = true;
    });
    return found;
  }

  return {
    hasTypeAssertionOrigin: hasAssertionOrigin,
    assertionInitializer(node) {
      const symbol = resolveSymbol(checker, node);
      if (!symbol || !symbolHasAssertionOrigin(symbol)) return null;
      for (const declaration of symbol.declarations ?? []) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
        const list = declaration.parent;
        if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) {
          return { symbol, expression: declaration.initializer };
        }
      }
      return null;
    },
  };
}

function indexWrittenSymbols(program, checker) {
  /** @type {Set<import("typescript").Symbol>} */
  const written = new Set();
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      recordWrittenTarget(checker, written, node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordWrittenTarget(checker, written, node.operand);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  }
  return written;
}

function recordWrittenTarget(checker, written, target) {
  const symbolNode = ts.isPropertyAccessExpression(target)
    ? target.name
    : ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression)
      ? target.expression
      : ts.isIdentifier(target)
        ? target
        : null;
  if (symbolNode) {
    const symbol = resolveSymbol(checker, symbolNode);
    if (symbol) written.add(symbol);
    return;
  }
  if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
    ts.forEachChild(target, (child) => recordWrittenTarget(checker, written, child));
  }
}

function evidenceSourceOfDeclaration(declaration) {
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    const mutable = !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const);
    return { mutable, node: declaration.initializer };
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration)
  ) {
    return { mutable: false, node: declaration.body };
  }
  if (ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
    return { mutable: false, node: declaration.initializer };
  }
  if (ts.isBindingElement(declaration) || ts.isParameter(declaration)) {
    return { mutable: false, node: declaration.initializer };
  }
  return { mutable: false, node: undefined };
}

/** `api.vehicles.importBulk` (or `internal.x.y`) -> `vehicles:importBulk` */
function apiReferenceToIdentifier(node) {
  const segments = [];
  let current = node;
  while (current && ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!current || !ts.isIdentifier(current)) return null;
  const root = current.text;
  if (root !== "api" && root !== "internal") return null;
  if (segments.length < 2) return null;
  const fn = segments[segments.length - 1];
  const modulePath = segments.slice(0, -1).join("/");
  return `${modulePath}:${fn}`;
}

/**
 * Walk a TS type into a client NODE.
 *
 * `seen` guards recursive types; without it a self-referential payload type
 * (a tree node, a threaded comment) would recurse until the stack died and the
 * whole run would report nothing at all. A cut recursion returns an object
 * whose KEY SET is unknown rather than an empty one — we stopped looking, which
 * is not the same as having looked and found nothing.
 *
 * `path` is carried for diagnostics only (the `unknowns` list names where it
 * gave up). Nothing here consults it to decide anything.
 */
function collectPaths(checker, type, path, acc, depth, seen, inherited = "LITERAL") {
  if (depth > MAX_DEPTH) {
    if (path) acc.unknowns.push(`${path} (max depth)`);
    return clientNode.opaqueKeys();
  }

  const flags = type.getFlags();

  // any / unknown: the value is not statically knowable here.
  //
  // ⚠️ This is NOT automatically safe, and it is NOT automatically breaking.
  // An `any` at a path the backend declares as a scalar cannot hide an
  // undeclared KEY, but it can still hide an incompatible VALUE — a runtime
  // `make: 123` against `v.string()` is rejected by Convex just as surely as
  // an unknown field. An `any` at a path the backend declares as an object or
  // array is worse: extra keys can hide inside it. The comparator draws that
  // line; collapsing it here would throw away what is needed to draw it.
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) {
    acc.unknowns.push(path || "<root>");
    return clientNode.opaqueValue();
  }

  // An enumerable value domain — a literal, or a union of them. Provable
  // against a validator's accepted set, which a widened scalar is not.
  const literals = literalsOfType(type);
  if (literals) return clientNode.literal(literals);

  // Unions: the client may send ANY branch, so all of them are kept.
  //
  // ⚠️ `undefined` AND `null` ARE NOT THE SAME THING, and treating them as one
  // was a false negative in exactly the dimension this comparator exists for.
  //
  //   `undefined`  the property is NOT TRANSMITTED. Convex omits it, so it is
  //                an absence — a fact about optionality, not a value.
  //   `null`       the property IS TRANSMITTED, carrying null. It is a value
  //                like any other, and a backend declaring `v.literal("A")` or
  //                `v.string()` refuses it.
  //
  // Discarding the null branch made `"A" | null` read as the exact set {"A"},
  // so it compared clean against `v.literal("A")`. Preserving union branches is
  // the whole point of the tree; silently dropping one contradicts it.
  if (type.isUnion()) {
    let merged = null;
    for (const branch of type.types) {
      // ⚠️ LOAD-BEARING. REMOVING THIS LINE BREAKS EVERY OPTIONAL FIELD IN THE
      // REPOSITORY. Do not "simplify" it.
      //
      // ⚠️ AND THIS COMMENT USED TO SAY THE OPPOSITE. It called the line a
      // "CLARITY GUARD, not semantics", on the grounds that an `undefined`
      // branch resolves to an `unresolved` node and "merging that is a no-op,
      // so removing this line changes nothing — proven, not assumed, byte-
      // identical finding set."
      //
      // That proof was real, and it EXPIRED. It held only while `unresolved`
      // was ABSORBED on merge. `unresolved` now ABSORBS, so merging in a stray
      // one no longer does nothing — it destroys everything already learned
      // about the field. Under `strict`, `field?: T` resolves to `T | undefined`,
      // so without this line EVERY optional field in the codebase collapses to
      // `unresolved`: over-uncertain rather than over-certain, but the same
      // silent, sweeping, unflagged change in what this control actually knows.
      //
      // Measured by reversion at this head: disabling the guard fails 4 tests
      // (CASE 3d, 3e, 3h, 4) plus the bare-optional-scalar regression added for
      // exactly this reason. The stale claim survived the change that falsified
      // it because the commit that made `unresolved` absorbing never revisited
      // the neighbouring proof — the module header's own warning, that an
      // annotation which drifts is a lie the toolchain repeats, aimed at itself.
      if (branch.getFlags() & ts.TypeFlags.Undefined) continue;
      merged = mergeClientNodes(
        merged,
        collectPaths(checker, branch, path, acc, depth + 1, seen, inherited)
      );
    }
    return merged ?? clientNode.unresolved();
  }

  // Arrays / tuples -> descend into the element TYPE. The element is a node in
  // its own right, so everything true of an object is true of an element.
  const elementTypes = getElementTypes(checker, type);
  if (elementTypes) {
    // Every member contributes. A tuple's members are usually different shapes,
    // so merging them yields `variants` — and the comparator requires EVERY
    // variant to satisfy the validator, which is the fail-closed answer. A
    // member the checker cannot classify absorbs the rest rather than being
    // absorbed by them, so an unreadable member cannot be hidden by a readable
    // one sitting next to it in the same tuple.
    let element = null;
    for (const memberType of elementTypes) {
      element = mergeClientNodes(
        element,
        collectPaths(checker, memberType, `${path}[*]`, acc, depth + 1, seen, inherited)
      );
    }
    return clientNode.array(element);
  }

  // Primitives are leaves.
  if (!(flags & ts.TypeFlags.Object)) {
    // ⚠️ ASK FOR THE TABLE BEFORE THE BRAND IS COLLAPSED.
    //
    // `kindOfType` resolves `string & { __tableName: "vehicles" }` to primitive
    // `string`, which is correct for every OTHER purpose and destroys the one
    // dimension `v.id(table)` is about. Once erased, `Id<"users">` and
    // `Id<"vehicles">` are the same value and a wrong-table payload reports
    // CLEAN. So the question is asked here, before the collapse.
    const tables = idTablesOfType(checker, type);
    if (tables) return clientNode.id(tables);
    const kind = kindOfType(checker, type, flags);
    if (kind === "null") return clientNode.literal(new Set([null]));
    return kind === "unresolved" ? clientNode.unresolved() : clientNode.scalar(kind);
  }

  const typeId = type.id ?? checker.typeToString(type);
  const seenKey = `${path}::${typeId}`;
  if (seen.has(seenKey)) return clientNode.opaqueKeys();
  seen.add(seenKey);

  // An index signature accepts arbitrary keys: dynamic, not empty. The key set
  // is therefore NOT complete, which is what stops the comparator from
  // demanding a required field of an object that may already carry it under a
  // name we cannot see.
  // ⚠️ BOTH KEY DOMAINS, NOT JUST THE STRING ONE.
  //
  // This asked `IndexKind.String` alone, so `{ [k: number]: T }` — which has a
  // NUMERIC index signature and no string one — reported `keysComplete: true`.
  // The extractor asserted the key set was PROVEN COMPLETE over a domain that
  // admits arbitrary numeric keys, which is the same fault as the tuple above:
  // part of the shape inspected, a narrower answer stated with full confidence.
  //
  // Completeness is a conjunction over every domain that can carry a key. A
  // domain we did not ask about is not a domain that is absent.
  const stringIndex = checker.getIndexInfoOfType?.(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexInfoOfType?.(type, ts.IndexKind.Number);
  const keysComplete = !stringIndex && !numberIndex;
  if (!keysComplete) acc.unknowns.push(`${path ? path : "<root>"}[*key*]`);

  const fields = new Map();
  for (const prop of checker.getPropertiesOfType(type)) {
    const name = prop.getName();
    // ⚠️ THERE IS NO NAME FILTER HERE, AND THERE MUST NOT BE.
    //
    // This used to skip every property starting with `__`, added for Convex's
    // `Id<T>` brand marker (`__tableName`). Two things were wrong with it. It
    // is now DEAD for that purpose — `kindOfType` resolves a branded
    // intersection to its primitive before the walk ever reaches a structured
    // object — and it was never limited to the brand: ANY field so named was
    // dropped from `fields`, absent from `unknowns`, and left `keysComplete`
    // true. The extractor asserted the key set was PROVEN COMPLETE while having
    // silently discarded a field. If the backend does not declare it, Convex
    // refuses the call and this control reports PASS.
    //
    // A field skipped for any reason must be VISIBLE: either kept, or recorded
    // as unknown with key completeness withdrawn. Silence is the one thing it
    // cannot be.
    const childPath = path ? `${path}.${name}` : name;
    const optional = Boolean(prop.getFlags() & ts.SymbolFlags.Optional);
    // Provenance is inherited, exactly as optionality is on the validator side.
    // A REQUIRED field inside an OPTIONAL parent is not transmitted when the
    // parent is absent, so it cannot be stronger evidence than its parent.
    // Without this, `sourceLikeVehicle.make` reads as proven while
    // `sourceLikeVehicle` itself is only a maybe — eight fabricated BREAKING
    // findings in the third whole-repo run.
    const ownProvenance = optional ? "TYPE_OPTIONAL" : "TYPE_REQUIRED";
    const provenance = inherited === "TYPE_OPTIONAL" ? "TYPE_OPTIONAL" : ownProvenance;

    // ⚠️ A MAPPED-TYPE PROPERTY HAS NO DECLARATION.
    //
    // `Partial<Record<FieldKey, string>>` synthesises its members, so
    // `valueDeclaration` is undefined for every one of them and the
    // declaration-based overload cannot be used. The flat model recorded those
    // as kind "unresolved", which its comparator treated as compatible — an
    // unreadable value passing as verified. Asking the checker for the symbol
    // type directly resolves them properly; only if THAT fails is the value
    // genuinely opaque, and then it says so.
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType =
      checker.getTypeOfSymbol?.(prop) ??
      (decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : undefined);
    if (!propType) {
      acc.unknowns.push(childPath);
      fields.set(name, { node: clientNode.opaqueValue(), provenance, optional });
      continue;
    }
    fields.set(name, {
      node: collectPaths(checker, propType, childPath, acc, depth + 1, seen, provenance),
      provenance,
      optional,
    });
  }

  return clientNode.object(fields, keysComplete);
}

/**
 * The element types of an array-like, as a LIST — never a single type.
 *
 * ⚠️ THIS RETURNED `args[0]` FOR A TUPLE, AND THAT WAS A FALSE PASS.
 *
 * `[string, number]` was modelled as `array(scalar(string))`: the `number`
 * member was discarded before the comparator ever saw it, so the payload
 * compared clean against `v.array(v.string())` while Convex refuses it. The
 * reachable form is worse, because it looks like ordinary code —
 * `["CASH", "BANK_TRANSFER"] as const` is a TUPLE, and it collapsed to the
 * enumeration `{"CASH"}`, asserting the client could send nothing else.
 *
 * Returning an ARRAY rather than a type is the point: there is no shape here
 * that lets a caller quietly keep one member and drop the rest. An array has
 * exactly one element type and yields a one-element list; a tuple yields all of
 * them, and the caller merges them into a single element node — where an
 * unclassifiable member now ABSORBS rather than being absorbed.
 *
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Type} type
 * @returns {import("typescript").Type[] | null} null when not array-like
 */
function getElementTypes(checker, type) {
  // `isTupleType` / `isArrayType` are plain predicates, not TypeScript type
  // guards, so the compiler still sees a bare `Type` here. Both return true
  // only for a `TypeReference`, which is what `getTypeArguments` requires — the
  // cast states that, and is confined to the two lines the predicates guard.
  const asReference = () => /** @type {import("typescript").TypeReference} */ (type);
  if (checker.isTupleType?.(type)) {
    const args = checker.getTypeArguments(asReference());
    return args?.length ? [...args] : null;
  }
  if (checker.isArrayType?.(type)) {
    const args = checker.getTypeArguments(asReference());
    return args?.[0] ? [args[0]] : null;
  }
  return null;
}

/**
 * The values a SINGLE type can take, or `null` when it is wider than an
 * enumeration.
 *
 * A literal type (`"CASH"`) is provable against a validator's accepted set. A
 * plain `string` is not — it is assignable from anything, so it can carry
 * `"MAYBE"` to a validator that accepts only `"CASH" | "CHEQUE"`. That is a
 * TYPE_UNKNOWN, not a pass.
 *
 * ⚠️ THIS NO LONGER HANDLES UNIONS, DELIBERATELY. It used to walk union
 * branches itself, which meant the rule "`undefined` is absence, `null` is a
 * value" was written in TWO places — and when the null half was wrong, it was
 * wrong in both. Removing the duplicate leaves that decision in exactly one
 * place: the union walk in `collectPaths`, which reaches the identical node by
 * merging the branches. Proven equivalent, not assumed: with this branch
 * deleted the whole-repo run produced a byte-identical finding set (69 of 69)
 * and all 151 tests still passed. Two encodings of one semantic decision is the
 * defect family this entire redesign exists to end.
 */
function literalsOfType(type) {
  if (type.isStringLiteral?.() || type.isNumberLiteral?.()) return new Set([type.value]);
  if (type.getFlags() & ts.TypeFlags.BooleanLiteral) return new Set([checkerBooleanValue(type)]);
  return null;
}

function checkerBooleanValue(type) {
  // TS models `true`/`false` as intrinsic names on the literal type.
  return type.intrinsicName === "true";
}

/** Coarse classification — enough to compare against a Convex validator. */
/**
 * The TABLE DOMAIN of a Convex document id, or `null` if this is not one.
 *
 * `GenericId<T>` is `string & { __tableName: T }`. Two conditions must BOTH
 * hold before this claims a table, and each is a place where inventing evidence
 * would be easy:
 *
 *  1. a string-like member must be present, so a random object carrying a
 *     `__tableName` property is not mistaken for an id;
 *  2. the brand's own type must be a FINITE domain of string literals. A
 *     generic parameter, a widened `string`, or anything else is NOT proof of a
 *     table — it falls back to ordinary string semantics, which report an
 *     honest unknown rather than a fabricated table.
 *
 * A finite UNION of literals keeps every member, because `Id<"a"|"b">` really
 * may be either and collapsing it to one would be the same "part of the shape
 * inspected, narrower answer stated with full confidence" fault this ticket has
 * now found four times.
 *
 * @returns {string[] | null}
 */
function idTablesOfType(checker, type) {
  if (!type.isIntersection?.()) return null;
  if (!type.types.some((part) => part.getFlags() & ts.TypeFlags.StringLike)) return null;

  for (const part of type.types) {
    const brand = checker.getPropertyOfType?.(part, "__tableName");
    if (!brand) continue;
    const decl = brand.valueDeclaration ?? brand.declarations?.[0];
    const brandType =
      checker.getTypeOfSymbol?.(brand) ??
      (decl ? checker.getTypeOfSymbolAtLocation(brand, decl) : undefined);
    if (!brandType) return null;
    const members = brandType.isUnion?.() ? brandType.types : [brandType];
    const tables = [];
    for (const member of members) {
      // Anything that is not an exact string literal makes the domain
      // unprovable, and an unprovable domain is not an id.
      if (!(member.getFlags() & ts.TypeFlags.StringLiteral)) return null;
      const value = /** @type {{value?: unknown}} */ (member).value;
      if (typeof value !== "string") return null;
      tables.push(value);
    }
    return tables.length ? tables : null;
  }
  return null;
}

function kindOfType(checker, type, flags) {
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return "any";
  if (flags & (ts.TypeFlags.StringLike)) return "string";
  if (flags & (ts.TypeFlags.NumberLike)) return "number";
  if (flags & (ts.TypeFlags.BooleanLike)) return "boolean";
  if (flags & (ts.TypeFlags.BigIntLike)) return "bigint";
  if (flags & ts.TypeFlags.Null) return "null";
  if (type.isUnion?.()) return "union";
  if (checker.isArrayType?.(type) || checker.isTupleType?.(type)) return "array";
  // ⚠️ A BRANDED PRIMITIVE IS A PRIMITIVE. Convex's `Id<"vehicles">` is
  // `string & { __tableName: "vehicles" }` — an INTERSECTION, which carries
  // neither StringLike nor Object, so it fell through to "unresolved".
  //
  // That was invisible while `unresolved` silently passed. The moment the
  // review fix made `unresolved` report an honest unknown, every `Id` argument
  // in the app became one: 810 new TYPE_UNKNOWNs in a single whole-repo run,
  // almost all of them "declared id". Reporting ignorance we do not actually
  // have is how a monitor earns being muted. The answer is to stop being
  // ignorant, not to go back to passing silently.
  if (type.isIntersection?.()) {
    for (const part of type.types) {
      const kind = kindOfType(checker, part, part.getFlags());
      if (kind !== "unresolved" && kind !== "object") return kind;
    }
  }
  if (flags & ts.TypeFlags.Object) return "object";
  return "unresolved";
}
