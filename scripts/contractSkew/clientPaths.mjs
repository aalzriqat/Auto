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
export const DIRECT_CALLERS = new Set([
  "mutation", "query", "action",
  "runMutation", "runQuery", "runAction",
  "fetchQuery", "fetchMutation", "fetchAction",
  "preloadQuery",
  // Client-class methods that transmit at call time (ConvexReactClient /
  // ConvexClient / ConvexHttpClient). The census inventories these from the
  // pinned `convex` package; listing them here is what lets the extractor
  // answer for them rather than leave each as an unaccounted site.
  "watchQuery", "prewarmQuery", "onUpdate", "consistentQuery",
]);
/**
 * The same entry points called as BARE functions (`fetchQuery(api.x.y, {...})`
 * from `convex/nextjs`). Form B only matched `something.fetchQuery(...)`, so the
 * bare form — the one that package actually exports — was never extracted.
 */
const BARE_DIRECT_CALLERS = new Set(["fetchQuery", "fetchMutation", "fetchAction", "preloadQuery"]);

/**
 * The name a Form B call is spelled with: `x.query` -> "query", `x["query"]` ->
 * "query", bare `fetchQuery` -> "fetchQuery". Only called on the three shapes
 * the Form B test above admits (a string-literal element access, never computed).
 *
 * @param {import("typescript").Expression} expression
 * @returns {string}
 */
function calleeName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return /** @type {import("typescript").StringLiteral} */ (expression.argumentExpression).text;
  }
  return /** @type {import("typescript").Identifier} */ (expression).text;
}

const MAX_DEPTH = 12;

/**
 * ⚠️ THIS ANNOTATION WAS WRONG FOR AS LONG AS NOBODY CHECKED IT. It still
 * described a `sent: Map<...>` that no longer exists, and because `checkJs` was
 * off the compiler inferred THAT shape for every consumer — reporting
 * `unresolvedBinders` and `casts` as properties that do not exist the moment
 * checking was switched on. A comment that drifts is a comment; an annotation
 * that drifts is a lie the toolchain repeats.
 *
 * @typedef {{
 *   calls: Array<{
 *     identifier: string, file: string, line: number,
 *     payload: import("./contractTree.mjs").ClientNode | null,
 *     skipped?: boolean, unknowns: string[], casts: string[], via?: string,
 *     siteId: string, mapSiteId?: string
 *   }>,
 *   unresolvedBinders: Array<{
 *     identifier: string, file: string, line: number, cause: string, reason: string,
 *     siteId: string, mapSiteId?: string
 *   }>,
 *   provedSkips: Array<{file: string, line: number, reason: string, siteId: string, mapSiteId?: string}>,
 *   diagnosticsCount: number
 * }} Extraction
 */

/**
 * Build the TypeScript program for one client surface.
 *
 * Separate from extraction so the SAME program can feed the independent census
 * (`census.mjs`) — the census must not trust the extractor's call list, but it
 * has no reason to pay for a second type-check of the same files.
 *
 * @param {string[]} rootFiles  entry files to type-check
 * @param {string} tsconfigPath
 * @returns {import("typescript").Program}
 */
export function createClientProgram(rootFiles, tsconfigPath) {
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

  return ts.createProgram({
    rootNames: rootFiles.length ? rootFiles : parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

/**
 * @param {string[]} rootFiles  entry files to type-check
 * @param {string} tsconfigPath
 * @param {{ program?: import("typescript").Program }} [options]
 * @returns {Extraction}
 */
export function extractClientCalls(rootFiles, tsconfigPath, options = {}) {
  const program = options.program ?? createClientProgram(rootFiles, tsconfigPath);
  const checker = program.getTypeChecker();
  const evidence = createEvidenceAnalysis(program, checker);

  const calls = [];
  const unresolvedBinders = [];
  const provedSkips = [];

  // ⚠️ SITE IDENTITY. Every record carries the position of the expression that
  // NAMES the Convex function (or the request map, or the invoked binding) so
  // the independent census can reconcile its own candidates to these records by
  // identity. Counts would let one gap swap for another; this cannot.
  const relFile = (sourceFile) => path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/");
  const siteOf = (sourceFile, node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return `${relFile(sourceFile)}:${line + 1}:${character + 1}`;
  };

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
    // An explicitly listed file is scanned even if its path contains
    // `node_modules` (the exit-code scaffolds live there); an unlisted one never is.
    if (inScope.size) {
      if (!inScope.has(normalizeSurfacePath(sourceFile.fileName))) continue;
    } else if (sourceFile.fileName.includes("node_modules")) continue;

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
    /** @type {Map<import("typescript").Symbol,{ id: string, via: string }>} bound symbol -> its function and the hook that produced it */
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
        const id = resolveFunctionReference(node.initializer.arguments[0], checker);
        const symbol = checker.getSymbolAtLocation(node.name);
        if (id && symbol) bound.set(symbol, { id, via: node.initializer.expression.text });
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
        const id = resolveFunctionReference(node.arguments[0], checker);
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
                  refinements: createFlowRefinements(),
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
            siteId: siteOf(sourceFile, node.arguments[0]),
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
        const identifier = resolveFunctionReference(node.arguments[0], checker);
        const parent = node.parent;
        const boundToSimpleName =
          parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name);
        // ⚠️ BINDING TO A SIMPLE NAME ONLY HELPS A REFERENCE WE RESOLVED.
        //
        // `boundToSimpleName` used to suppress the record on its own, so
        // `const rows = useQuery(someRef, ...)` with a reference nobody could
        // resolve produced NOTHING: no call, no unresolved site, and a
        // clean-looking run. The simple name says where the hook's RESULT goes;
        // it says nothing about whether the FUNCTION was identified.
        const followable = identifier && (boundToSimpleName || inlineResolved.has(node));
        if (!followable) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          unresolvedBinders.push({
            identifier: identifier ?? "<unresolved>",
            file: relFile(sourceFile),
            line: line + 1,
            cause: classifyBinder(node, identifier),
            reason: identifier
              ? "hook result is not bound to a simple name; its payload cannot be followed"
              : "the Convex function reference is not a literal api.* path or a const alias of one",
            siteId: siteOf(sourceFile, node.arguments[0]),
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
        /**
         * The expression whose position identifies this transmission site.
         * @type {import("typescript").Node}
         */
        let siteNode = node;
        /** The hook or SDK method that made this call (the comparator checks it against the function's type). */
        let via = null;

        // Form A: boundVariable({...}) — resolved through the symbol so a
        // same-named local (a useState setter, a prop) cannot be mistaken for
        // the mutation.
        if (ts.isIdentifier(node.expression)) {
          const symbol = resolveSymbol(checker, node.expression);
          const entry = symbol ? bound.get(symbol) : undefined;
          if (entry) {
            identifier = entry.id;
            via = entry.via;
            argExpr = node.arguments[0] ?? null;
            siteNode = node.expression;
          }
        }

        // Form B: something.mutation(api.x.y, {...}), and the bare
        // fetchQuery(api.x.y, {...}) that `convex/nextjs` actually exports.
        if (
          !identifier &&
          node.arguments.length > 0 &&
          ((ts.isPropertyAccessExpression(node.expression) &&
            DIRECT_CALLERS.has(node.expression.name.text)) ||
            // `client["query"](api.x.y, {...})` is the same call (CS2-1). Only a
            // string-literal member can be named; a computed one is the census's
            // to record.
            (ts.isElementAccessExpression(node.expression) &&
              (ts.isStringLiteral(node.expression.argumentExpression) ||
                ts.isNoSubstitutionTemplateLiteral(node.expression.argumentExpression)) &&
              DIRECT_CALLERS.has(node.expression.argumentExpression.text)) ||
            (ts.isIdentifier(node.expression) && BARE_DIRECT_CALLERS.has(node.expression.text)))
        ) {
          const maybe = resolveFunctionReference(node.arguments[0], checker);
          if (maybe) {
            identifier = maybe;
            via = calleeName(node.expression);
            argExpr = node.arguments[1] ?? null;
            siteNode = node.arguments[0];
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
                refinements: createFlowRefinements(),
              })
            : EMPTY_PAYLOAD;
          calls.push({
            identifier,
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            payload,
            unknowns: acc.unknowns,
            casts: acc.casts,
            ...(via ? { via } : {}),
            siteId: siteOf(sourceFile, siteNode),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // Pass 3: `useQueries` request maps. Each `{ query, args }` entry is a call.
    const visitUseQueries = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useQueries"
      ) {
        extractRequestMap(node, sourceFile);
      }
      ts.forEachChild(node, visitUseQueries);
    };
    visitUseQueries(sourceFile);
  }

  /**
   * ⚠️ A `useQueries` ARGUMENT IS A MAP OF CALLS, NOT A FUNCTION REFERENCE.
   *
   * `useQueries({ key: { query: api.x.y, args } })` sends one query per entry.
   * Treating it as a hook with a reference at argument 0 (as every other hook
   * here does) finds nothing. The map is usually built in a `useMemo`, so this
   * follows const identifiers, conditionals and `useMemo` return statements:
   *
   *   - an EMPTY object literal is a PROVED skip (nothing is sent);
   *   - an entry with a resolvable `query` is a call;
   *   - anything else (a parameter, a spread, a computed reference, a call we
   *     cannot read) is UNRESOLVED at its file:line — never dropped.
   */
  function extractRequestMap(callNode, sourceFile) {
    const mapSiteId = callNode.arguments[0]
      ? siteOf(sourceFile, callNode.arguments[0])
      : siteOf(sourceFile, callNode);
    const lineOfNode = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const unresolved = (node, cause, reason) =>
      unresolvedBinders.push({
        identifier: "<unresolved>",
        file: relFile(sourceFile),
        line: lineOfNode(node),
        cause,
        reason,
        siteId: siteOf(sourceFile, node),
        mapSiteId,
      });

    /** Return expressions of a function body, not descending into nested functions. */
    const returnedExpressions = (fn) => {
      if (!ts.isBlock(fn.body)) return [fn.body];
      const found = [];
      const scan = (n) => {
        if (ts.isFunctionLike(n) && n !== fn) return;
        if (ts.isReturnStatement(n)) {
          if (n.expression) found.push(n.expression);
          return;
        }
        ts.forEachChild(n, scan);
      };
      scan(fn.body);
      return found;
    };

    const propertyKey = (prop) =>
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ? prop.name.text
        : null;

    const entry = (entryNode) => {
      const literal = unwrapReferenceExpression(entryNode);
      if (!ts.isObjectLiteralExpression(literal)) {
        unresolved(entryNode, "DYNAMIC_REQUEST_ENTRY", "a useQueries entry is not an object literal");
        return;
      }
      let queryNode = null;
      let argsNode = null;
      for (const prop of literal.properties) {
        const key = propertyKey(prop);
        const valueNode = ts.isShorthandPropertyAssignment(prop)
          ? prop.name
          : ts.isPropertyAssignment(prop)
            ? prop.initializer
            : null;
        if (key === "query" && valueNode) queryNode = valueNode;
        else if (key === "args" && valueNode) argsNode = valueNode;
        else if (ts.isSpreadAssignment(prop) || key === null) {
          unresolved(prop, "DYNAMIC_REQUEST_ENTRY", "a useQueries entry has a spread or computed key");
          return;
        }
      }
      if (!queryNode) {
        unresolved(literal, "DYNAMIC_REQUEST_ENTRY", "a useQueries entry has no literal `query` property");
        return;
      }
      const identifier = resolveFunctionReference(queryNode, checker);
      if (!identifier) {
        unresolved(queryNode, "DYNAMIC_IDENTITY", "the Convex function reference is not a literal api.* path or a const alias of one");
        return;
      }
      const acc = { unknowns: [], casts: [] };
      const payload = argsNode
        ? collectFromExpression(argsNode, {
            checker,
            prefix: "",
            acc,
            depth: 0,
            seen: new Set(),
            evidence,
            expressionSeen: new Set(),
            refinements: createFlowRefinements(),
          })
        : EMPTY_PAYLOAD;
      calls.push({
        identifier,
        file: relFile(sourceFile),
        line: lineOfNode(queryNode),
        payload,
        unknowns: acc.unknowns,
        casts: acc.casts,
        via: "useQueries",
        siteId: siteOf(sourceFile, queryNode),
        mapSiteId,
      });
    };

    const walk = (expression, depth, seen) => {
      const node = unwrapReferenceExpression(expression);
      if (depth > MAX_DEPTH) {
        unresolved(node, "DYNAMIC_REQUEST_MAP", "the useQueries request map is nested too deeply to follow");
        return;
      }
      if (ts.isObjectLiteralExpression(node)) {
        if (node.properties.length === 0) {
          provedSkips.push({
            file: relFile(sourceFile),
            line: lineOfNode(node),
            reason: "empty useQueries request map: nothing is sent",
            siteId: siteOf(sourceFile, node),
            mapSiteId,
          });
          return;
        }
        for (const prop of node.properties) {
          if (ts.isPropertyAssignment(prop)) entry(prop.initializer);
          else if (ts.isSpreadAssignment(prop)) walk(prop.expression, depth + 1, seen);
          else unresolved(prop, "DYNAMIC_REQUEST_ENTRY", "a useQueries entry is not an inline object literal");
        }
        return;
      }
      if (ts.isConditionalExpression(node)) {
        walk(node.whenTrue, depth + 1, seen);
        walk(node.whenFalse, depth + 1, seen);
        return;
      }
      if (ts.isIdentifier(node)) {
        const symbol = resolveSymbol(checker, node);
        const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        const list = decl && ts.isVariableDeclaration(decl) ? decl.parent : undefined;
        if (
          symbol &&
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          list &&
          ts.isVariableDeclarationList(list) &&
          list.flags & ts.NodeFlags.Const &&
          !seen.has(symbol)
        ) {
          seen.add(symbol);
          walk(decl.initializer, depth + 1, seen);
          return;
        }
        unresolved(node, "DYNAMIC_REQUEST_MAP", "the useQueries request map is not a const object we can read");
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isUseMemo =
          (ts.isIdentifier(callee) && callee.text === "useMemo") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "useMemo");
        const factory = node.arguments[0] ? unwrapReferenceExpression(node.arguments[0]) : null;
        if (isUseMemo && factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
          const returned = returnedExpressions(factory);
          if (returned.length === 0) {
            unresolved(node, "DYNAMIC_REQUEST_MAP", "the useMemo factory returns no request map");
            return;
          }
          for (const expr of returned) walk(expr, depth + 1, seen);
          return;
        }
      }
      unresolved(node, "DYNAMIC_REQUEST_MAP", "the useQueries request map is built dynamically");
    };

    if (callNode.arguments.length === 0) {
      unresolved(callNode, "DYNAMIC_REQUEST_MAP", "useQueries called without a request map");
      return;
    }
    walk(callNode.arguments[0], 0, new Set());
  }

  return {
    calls,
    unresolvedBinders,
    provedSkips,
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
 *   expressionSeen: Set<import("typescript").Symbol>,
 *   refinements: ReturnType<typeof createFlowRefinements>
 * }} ExpressionContext
 */

/**
 * @param {import("typescript").Expression} expr
 * @param {ExpressionContext} context
 */
function collectFromExpression(expr, context) {
  const { checker, prefix, acc, depth, seen, evidence, refinements } = context;
  const nested = (nestedPrefix = prefix, nestedRefinements = refinements) => ({
    ...context,
    prefix: nestedPrefix,
    depth: depth + 1,
    refinements: nestedRefinements,
  });
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
    // `as const` preserves literal/read-only information without claiming a
    // different runtime value. Treat it as transparent while still inspecting
    // its operand for nested assertions.
    if (ts.isConstTypeReference(node.type)) {
      return collectFromExpression(node.expression, nested());
    }
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

  // A concrete Next route is runtime evidence that the framework's broad
  // `string | string[]` hook type cannot express. Preserve every assertion on
  // the way back to `useParams()` but derive the value shape from `[id]` versus
  // `[...id]` / `[[...id]]`, never from an asserted target type.
  const routeParam = routeParamRuntimeNode(node, checker, evidence);
  if (routeParam) {
    return applyUseSiteRefinement(
      routeParam,
      refinementForExpression(checker, node, refinements),
    );
  }

  // Follow immutable assertion-bearing aliases back to their runtime source.
  // The symbol stack prevents self-referential initializers from laundering
  // through an infinite recursion into a trusted checker type. A truthiness
  // fact belongs to this USE SITE, not to the initializer, so it is applied
  // only after the runtime source has been reconstructed.
  if (ts.isIdentifier(node)) {
    const symbol = resolveSymbol(checker, node);
    return collectIdentifierFromSymbol(node, symbol, context);
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
      const childNode = ts.isPropertyAssignment(prop)
        ? collectFromExpression(prop.initializer, nested(childPath))
        : ts.isShorthandPropertyAssignment(prop)
          ? collectIdentifierFromSymbol(
              prop.name,
              checker.getShorthandAssignmentValueSymbol(prop) ?? resolveSymbol(checker, prop.name),
              nested(childPath),
            )
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
    if (isUndefinedExpression(checker, node.whenTrue)) {
      return collectFromExpression(node.whenFalse, nested());
    }
    if (isUndefinedExpression(checker, node.whenFalse)) {
      return collectFromExpression(node.whenTrue, nested());
    }
    const whenTrueRefinements = truthyRefinementsForCondition(
      checker,
      node.condition,
      refinements,
      evidence,
    );
    const whenFalseRefinements = falsyRefinementsForCondition(
      checker,
      node.condition,
      refinements,
      evidence,
    );
    return mergeClientNodes(
      collectFromExpression(node.whenTrue, nested(prefix, whenTrueRefinements)),
      collectFromExpression(node.whenFalse, nested(prefix, whenFalseRefinements))
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
  const collected = collectPaths(checker, type, prefix, acc, depth, seen, "LITERAL");
  // SCRUM-686: TypeScript narrows `a.b` only for a DIRECT condition (or a
  // readonly property through an aliased one), so a proven `!!a.b` carried by a
  // const alias is lost here. The use-site refinement recorded from the branch
  // condition is applied instead — but never for a receiver that is written
  // anywhere, because then the fact may have been invalidated before this read.
  const access = routeParamAccess(node);
  const receiverSymbol = access ? resolveSymbol(checker, access.receiver) : null;
  if (access && receiverSymbol && !evidence.isWrittenSymbol(receiverSymbol)) {
    return applyUseSiteRefinement(
      collected,
      refinementForExpression(checker, node, refinements),
      declaredTypeAdmitsUndefined(checker, accessSymbol(checker, node)),
    );
  }
  return collected;
}

function collectIdentifierFromSymbol(node, symbol, context) {
  const { checker, prefix, acc, depth, seen, evidence, expressionSeen, refinements } = context;
  const refinement = refinementForExpression(checker, node, refinements, symbol);
  const routeParam = routeParamRuntimeNode(node, checker, evidence, new Set(), symbol);
  const mayBeUndefined = declaredTypeAdmitsUndefined(checker, symbol);
  if (routeParam) return applyUseSiteRefinement(routeParam, refinement, mayBeUndefined);

  const alias = evidence.assertionInitializerForSymbol(symbol);
  if (alias) {
    if (expressionSeen.has(alias.symbol)) {
      return clientNode.assertion("TYPE_CLAIM", clientNode.opaqueValue());
    }
    expressionSeen.add(alias.symbol);
    try {
      return applyUseSiteRefinement(
        collectFromExpression(alias.expression, { ...context, depth: depth + 1 }),
        refinement,
        mayBeUndefined,
      );
    } finally {
      expressionSeen.delete(alias.symbol);
    }
  }

  if (symbol && evidence.hasAssertionOriginForSymbol(symbol)) {
    return clientNode.assertion("TYPE_CLAIM", clientNode.opaqueValue());
  }

  const type = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, node)
    : checker.getTypeAtLocation(node);
  const narrowed = isShorthandName(node) ? shorthandUseSiteBranches(checker, node, type) : null;
  if (narrowed) {
    // Merge exactly as the union branch of collectPaths does (an `undefined`
    // branch is absence), over only the branches the checker keeps at this call.
    let merged = null;
    for (const branch of narrowed) {
      if (branch.getFlags() & ts.TypeFlags.Undefined) continue;
      merged = mergeClientNodes(
        merged,
        collectPaths(checker, branch, prefix, acc, depth + 1, seen, "LITERAL"),
      );
    }
    return applyUseSiteRefinement(merged ?? clientNode.unresolved(), refinement, mayBeUndefined);
  }
  return applyUseSiteRefinement(
    collectPaths(checker, type, prefix, acc, depth, seen, "LITERAL"),
    refinement,
    mayBeUndefined,
  );
}

function isShorthandName(node) {
  return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
}

/**
 * ⚠️ THE TYPE AT THE CALL SITE, FOR A SHORTHAND PROPERTY.
 *
 * `getTypeOfSymbolAtLocation(symbol, location)` applies control-flow narrowing
 * only when `location` is an expression REFERENCING the symbol. The name of a
 * shorthand assignment (`{ quoteId }`) is a declaration name, so it came back as
 * the binding's DECLARED type and silently discarded `if (!quoteId) return;`.
 * That produced "client can send [null]" for correctly guarded code — a false
 * production-skew alarm. `getTypeAtLocation(shorthand.name)` DOES go through the
 * flow-narrowed expression check, but it widens literals (`"A"` -> `string`),
 * which would turn a provable enum into an unprovable scalar. So the narrowed
 * type is used only to decide WHICH branches of the declared union survive; the
 * surviving branches are the declared ones, literals intact.
 *
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Identifier} node
 * @param {import("typescript").Type} declared
 * @returns {import("typescript").Type[] | null} surviving branches, or null when
 *   nothing was narrowed (the caller then behaves exactly as before)
 */
function shorthandUseSiteBranches(checker, node, declared) {
  if (!declared.isUnion()) return null;
  const narrowed = checker.getTypeAtLocation(node);
  const narrowedParts = narrowed.isUnion() ? narrowed.types : [narrowed];
  const kept = declared.types.filter((branch) =>
    narrowedParts.some((part) => part === branch || checker.getBaseTypeOfLiteralType(branch) === part),
  );
  if (kept.length === 0 || kept.length === declared.types.length) return null;
  return kept;
}

/**
 * SCRUM-686 (CS-686-3). Only the GLOBAL `undefined` (or `void 0`) is the undefined
 * value. `undefined` is not a reserved word: a parameter, a local `const`, an
 * import or a type-level declaration can all bind the name, and then `x != undefined`
 * proves nothing. The global value symbol has no declarations in the program; any
 * resolved symbol that has one is a local binding and gives no proof. An
 * unresolvable identifier is not trusted either.
 */
function isUndefinedExpression(checker, node) {
  if (ts.isParenthesizedExpression(node)) return isUndefinedExpression(checker, node.expression);
  if (ts.isVoidExpression(node)) {
    return ts.isNumericLiteral(node.expression) && node.expression.text === "0";
  }
  if (!ts.isIdentifier(node) || node.text !== "undefined") return false;
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol) && (symbol.declarations ?? []).length === 0;
}

/**
 * SCRUM-686 (CS-686-1). The checker drops an `undefined` union member from every
 * type it reads (absence is not a value), so a refinement that proves only
 * "not null" must put the possibility of `undefined` back, or a required field
 * would read as always present. Fail closed: no symbol, `any`/`unknown`, an
 * optional member, or an `undefined`/`void` member all admit undefined.
 */
function declaredTypeAdmitsUndefined(checker, symbol) {
  if (!symbol) return true;
  if (symbol.flags & ts.SymbolFlags.Optional) return true;
  const type = checker.getTypeOfSymbol(symbol);
  if (type.getFlags() & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  return typeAdmitsUndefined(type);
}

function accessSymbol(checker, node) {
  if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return checker.getSymbolAtLocation(node.argumentExpression);
  }
  return null;
}

function createFlowRefinements() {
  return { identifiers: new Map(), properties: new Map() };
}

function cloneFlowRefinements(refinements) {
  return {
    identifiers: new Map(refinements.identifiers),
    properties: new Map(
      [...refinements.properties].map(([symbol, properties]) => [
        symbol,
        new Map(properties),
      ]),
    ),
  };
}

function refinementForExpression(checker, expression, refinements, knownSymbol = null) {
  if (ts.isIdentifier(expression)) {
    const symbol = knownSymbol ?? resolveSymbol(checker, expression);
    return symbol ? refinements.identifiers.get(symbol) : undefined;
  }
  const access = routeParamAccess(expression);
  if (!access) return undefined;
  const receiverSymbol = resolveSymbol(checker, access.receiver);
  return receiverSymbol
    ? refinements.properties.get(receiverSymbol)?.get(access.name)
    : undefined;
}

/**
 * Add only branch facts that are logically forced by a condition. For `a && b`
 * the true branch proves both operands; for `a || b` the false branch proves
 * both false. The opposite branches do not prove which operand decided the
 * result and therefore contribute no fabricated narrowing evidence.
 */
/**
 * @typedef {{ isWrittenSymbol: (symbol: import("typescript").Symbol | undefined | null) => boolean }} WriteEvidence
 * @typedef {Set<import("typescript").Symbol> | null} AliasTrail
 */
/** @param {WriteEvidence | null} [evidence] */
function truthyRefinementsForCondition(checker, condition, currentRefinements, evidence = null) {
  const branchRefinements = cloneFlowRefinements(currentRefinements);
  recordTruthyCondition(checker, condition, branchRefinements, evidence);
  return branchRefinements;
}

/** @param {WriteEvidence | null} [evidence] */
function falsyRefinementsForCondition(checker, condition, currentRefinements, evidence = null) {
  const branchRefinements = cloneFlowRefinements(currentRefinements);
  recordFalsyCondition(checker, condition, branchRefinements, evidence);
  return branchRefinements;
}

/**
 * SCRUM-686. The initializer of a boolean alias such as
 * `const active = enabled && !!a.id && !!b.id`, but ONLY for a binding that is a
 * `const`, declared exactly once with an initializer, and never written (a
 * `let`, a reassigned binding, a destructured or parameter binding is not
 * evidence). The caller then reads the initializer as if it were written
 * inline in the condition, which is what `active` means on its true branch.
 */
function constAliasInitializer(checker, identifier, evidence) {
  const symbol = resolveSymbol(checker, identifier);
  if (!symbol || evidence.isWrittenSymbol(symbol)) return null;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return null;
  const [declaration] = declarations;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  if (!declaration.initializer) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  return { symbol, initializer: declaration.initializer };
}

/**
 * @param {WriteEvidence | null} [evidence]
 * @param {AliasTrail} [viaAlias] symbols of the const
 *   aliases being expanded. Non-null means every fact recorded below was reached
 *   THROUGH an alias, so it is dropped when its subject is written anywhere: the
 *   alias may have been computed long before the read it is now guarding.
 */
function recordTruthyCondition(checker, condition, refinements, evidence = null, viaAlias = null) {
  if (ts.isParenthesizedExpression(condition)) {
    recordTruthyCondition(checker, condition.expression, refinements, evidence, viaAlias);
    return;
  }
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
    recordFalsyCondition(checker, condition.operand, refinements, evidence, viaAlias);
    return;
  }
  if (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    recordTruthyCondition(checker, condition.left, refinements, evidence, viaAlias);
    recordTruthyCondition(checker, condition.right, refinements, evidence, viaAlias);
    return;
  }
  const nullTest = nullComparisonRefinement(checker, condition);
  if (nullTest) {
    recordExpressionRefinement(checker, nullTest.subject, refinements, nullTest.refinement, evidence, viaAlias);
    return;
  }
  if (ts.isIdentifier(condition) && evidence) {
    const alias = constAliasInitializer(checker, condition, evidence);
    if (alias && !(viaAlias ?? new Set()).has(alias.symbol)) {
      recordTruthyCondition(
        checker,
        alias.initializer,
        refinements,
        evidence,
        new Set([...(viaAlias ?? []), alias.symbol]),
      );
    }
  }
  recordExpressionRefinement(checker, condition, refinements, "truthy", evidence, viaAlias);
}

/**
 * @param {WriteEvidence | null} [evidence]
 * @param {AliasTrail} [viaAlias]
 */
function recordFalsyCondition(checker, condition, refinements, evidence = null, viaAlias = null) {
  if (ts.isParenthesizedExpression(condition)) {
    recordFalsyCondition(checker, condition.expression, refinements, evidence, viaAlias);
    return;
  }
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
    recordTruthyCondition(checker, condition.operand, refinements, evidence, viaAlias);
    return;
  }
  if (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    recordFalsyCondition(checker, condition.left, refinements, evidence, viaAlias);
    recordFalsyCondition(checker, condition.right, refinements, evidence, viaAlias);
    return;
  }
  recordExpressionRefinement(checker, condition, refinements, "falsy", evidence, viaAlias);
}

/**
 * `x != null`, `x !== null`, `x != undefined`, `x !== undefined` (either side).
 * Each proves ONLY what the operator proves: `!== null` leaves `undefined`
 * possible and `!= null` does not exclude `0` or `""`, so none of them is read
 * as truthiness.
 */
function nullComparisonRefinement(checker, condition) {
  if (!ts.isBinaryExpression(condition)) return null;
  const operator = condition.operatorToken.kind;
  const strict = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!strict && operator !== ts.SyntaxKind.ExclamationEqualsToken) return null;
  const isNull = (n) => n.kind === ts.SyntaxKind.NullKeyword;
  const isNullish = (n) => isNull(n) || isUndefinedExpression(checker, n);
  const left = condition.left;
  const right = condition.right;
  const [subject, literal] = isNullish(right) ? [left, right] : [right, left];
  if (!isNullish(literal)) return null;
  if (!strict) return { subject, refinement: "nonNullish" };
  return { subject, refinement: isNull(literal) ? "nonNull" : "nonUndefined" };
}

/**
 * @param {WriteEvidence | null} [evidence]
 * @param {AliasTrail} [viaAlias]
 */
function recordExpressionRefinement(checker, condition, refinements, refinement, evidence = null, viaAlias = null) {
  if (ts.isIdentifier(condition)) {
    const symbol = resolveSymbol(checker, condition);
    if (symbol && !(viaAlias && evidence?.isWrittenSymbol(symbol))) {
      refinements.identifiers.set(
        symbol,
        combineRefinement(refinements.identifiers.get(symbol), refinement),
      );
    }
    return;
  }
  const access = routeParamAccess(condition);
  if (!access) return;
  const receiverSymbol = resolveSymbol(checker, access.receiver);
  if (!receiverSymbol) return;
  if (viaAlias && evidence?.isWrittenSymbol(receiverSymbol)) return;
  // CS-686-2: a property fact survives only while the receiver cannot be
  // reached and mutated through another reference.
  if (!receiverIsConfinedAt(checker, receiverSymbol, condition)) return;
  const properties = refinements.properties.get(receiverSymbol) ?? new Map();
  properties.set(access.name, combineRefinement(properties.get(access.name), refinement));
  refinements.properties.set(receiverSymbol, properties);
}

/**
 * Two facts about one subject that both hold (an `&&` chain). `!== null` and
 * `!== undefined` together are `!= null`; anything else keeps the previous
 * behaviour (the newer fact replaces the older one).
 */
function combineRefinement(previous, next) {
  if (
    (previous === "nonNull" && next === "nonUndefined") ||
    (previous === "nonUndefined" && next === "nonNull")
  ) {
    return "nonNullish";
  }
  return next;
}

/** @type {WeakMap<import("typescript").Symbol, import("typescript").Node | null>} */
const confinementScopes = new WeakMap();

function enclosingFunctionLike(node) {
  return ts.findAncestor(node.parent, (n) => ts.isFunctionLike(n)) ?? null;
}

/** True when `target` (a property access) is written, called as a method, or deleted. */
function isWriteOrCallTarget(access) {
  let child = access;
  let parent = access.parent;
  // Climb destructuring-assignment targets: `[a.x] = ...`, `({ k: a.x } = ...)`, `[...a.x] = ...`,
  // and type-only wrappers that emit nothing: `a.x! = ...`, `(a.x as T) = ...` (CS-686-2-R).
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      isTypeOnlyWrapper(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
      ts.isObjectLiteralExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return true;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === child &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (ts.isDeleteExpression(parent)) return true;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return true;
  // `a.method()` runs with `this === a`; `tag`x`` likewise.
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === child) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === child) return true;
  return false;
}

/**
 * SCRUM-686 (CS-686-2). The function-like in which `symbol` is a never-escaping
 * binding, or null. Proof obligation: the binding is a parameter or a `const`
 * with a plain identifier name, and EVERY reference to it anywhere in its file is
 * a property/element READ — in the same function body, not in a nested closure,
 * never passed as an argument, aliased, spread, destructured, captured, returned,
 * written, or used as a method receiver. Anything else may mutate a property
 * through another reference, so a fact recorded about `symbol.prop` is unproven.
 */
function confinementScope(checker, symbol) {
  if (confinementScopes.has(symbol)) return confinementScopes.get(symbol);
  let scope = null;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 1) {
    const [declaration] = declarations;
    if (
      ts.isParameter(declaration) &&
      ts.isIdentifier(declaration.name) &&
      ts.isFunctionLike(declaration.parent) &&
      // A second parameter may be the SAME object at runtime — `f(shared, shared)` —
      // and mutate it under another name (Codex CS-686-2 closure round).
      declaration.parent.parameters.length === 1
    ) {
      scope = declaration.parent;
    } else if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      scope = enclosingFunctionLike(declaration);
    }
    if (scope) {
      const declarationName = declaration.name;
      let confined = true;
      const visit = (node) => {
        if (!confined) return;
        if (ts.isIdentifier(node) && node !== declarationName && node.text === declarationName.text) {
          const referenced = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node);
          if (referenced === symbol) {
            const parent = node.parent;
            const isRead =
              (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
              parent.expression === node &&
              !isWriteOrCallTarget(parent) &&
              enclosingFunctionLike(node) === scope;
            if (!isRead) confined = false;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.getSourceFile());
      if (!confined || writesAnyProperty(scope)) scope = null;
    }
  }
  confinementScopes.set(symbol, scope);
  return scope;
}

/**
 * True when `fn` (including nested closures) writes, increments or deletes ANY
 * property. Object identity is not tracked, so any property write in the
 * receiver's function may be a write to the receiver through another reference
 * (`other.id = null` where `other === box`).
 *
 * ⚠️ Known limit: a mutation inside an opaque CALL (a helper closing over the
 * same object) is not seen. Proving effects across calls is out of scope here.
 */
function writesAnyProperty(fn) {
  let writes = false;
  const visit = (node) => {
    if (writes) return;
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isPropertyWrite(node)
    ) {
      writes = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return writes;
}

/** `a!`, `a as T`, `<T>a`, `a satisfies T` — erased at emit, so they never change what is written. */
function isTypeOnlyWrapper(node) {
  return (
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))
  );
}

/** Like isWriteOrCallTarget, but a method call is not a write. */
function isPropertyWrite(access) {
  let callee = access;
  while (callee.parent && (ts.isParenthesizedExpression(callee.parent) || isTypeOnlyWrapper(callee.parent))) {
    callee = callee.parent;
  }
  const parent = callee.parent;
  if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === callee) return false;
  if (parent && ts.isTaggedTemplateExpression(parent) && parent.tag === callee) return false;
  return isWriteOrCallTarget(access);
}

function receiverIsConfinedAt(checker, receiverSymbol, conditionNode) {
  const scope = confinementScope(checker, receiverSymbol);
  return Boolean(scope) && enclosingFunctionLike(conditionNode) === scope;
}
/**
 * Restrict reconstructed runtime evidence to alternatives reachable at the
 * call site. This filters only enumerable falsy values and structurally truthy
 * containers. Wider scalars remain wider, so a truthiness check can never turn
 * an unproven string into an ID or an enumeration member.
 */
function applyUseSiteRefinement(node, refinement, mayBeUndefined = false) {
  if (!refinement) return node;
  let refined =
    refinement === "truthy"
      ? truthyNode(node)
      : refinement === "falsy"
        ? falsyNode(node)
        : keepValuesNode(node, NULL_TEST_KEEP[refinement]);
  // CS-686-1: `!== null` does not exclude `undefined`; the checker dropped it from
  // the type, so put the absence back as an explicit possibility.
  if (refinement === "nonNull" && mayBeUndefined) {
    refined = mergeClientNodes(refined, clientNode.literal(new Set([undefined])));
  }
  // A contradictory branch is unreachable. `unresolved` is the conservative
  // fallback if TypeScript and the syntax evidence ever disagree; it denies a
  // clean PASS without fabricating a concrete BREAKING value.
  return refined ?? clientNode.unresolved();
}

/** Which literal values survive each null comparison (`!= null`, `!== null`, ...). */
const NULL_TEST_KEEP = {
  nonNullish: (value) => value !== null && value !== undefined,
  nonNull: (value) => value !== null,
  nonUndefined: (value) => value !== undefined,
};

function keepValuesNode(node, keep) {
  if (!keep) return node;
  if (node.kind === "literal") {
    const values = new Set([...node.values].filter(keep));
    return values.size ? clientNode.literal(values) : null;
  }
  if (node.kind === "variants") {
    const nodes = node.nodes.map((n) => keepValuesNode(n, keep)).filter(Boolean);
    return nodes.length ? clientNode.variants(nodes) : null;
  }
  if (node.kind === "assertion") {
    const inner = keepValuesNode(node.node, keep);
    return inner ? clientNode.assertion(node.effect, inner) : null;
  }
  return node;
}

function truthyNode(node) {
  if (node.kind === "literal") {
    const values = new Set([...node.values].filter(Boolean));
    return values.size ? clientNode.literal(values) : null;
  }
  if (node.kind === "variants") {
    const nodes = node.nodes
      .map(truthyNode)
      .filter(Boolean);
    return nodes.length ? clientNode.variants(nodes) : null;
  }
  if (node.kind === "assertion") {
    const inner = truthyNode(node.node);
    return inner ? clientNode.assertion(node.effect, inner) : null;
  }
  return node;
}

function falsyNode(node) {
  if (node.kind === "literal") {
    const values = new Set([...node.values].filter((value) => !value));
    return values.size ? clientNode.literal(values) : null;
  }
  if (node.kind === "variants") {
    const nodes = node.nodes
      .map(falsyNode)
      .filter(Boolean);
    return nodes.length ? clientNode.variants(nodes) : null;
  }
  if (node.kind === "assertion") {
    const inner = falsyNode(node.node);
    return inner ? clientNode.assertion(node.effect, inner) : null;
  }
  if (node.kind === "object" || node.kind === "array" || node.kind === "id") {
    return null;
  }
  return node;
}

/**
 * Resolve a value back to a concrete Next `useParams()` access. Only immutable
 * aliases and transparent assertions are followed, and assertions are retained
 * as TYPE_CLAIM wrappers. This is route-topology evidence, not type trust.
 */
function routeParamRuntimeNode(
  node,
  checker,
  evidence,
  visiting = new Set(),
  knownSymbol = null,
) {
  if (ts.isParenthesizedExpression(node)) {
    return routeParamRuntimeNode(node.expression, checker, evidence, visiting);
  }
  if (ts.isAssertionExpression(node)) {
    const inner = routeParamRuntimeNode(node.expression, checker, evidence, visiting);
    return inner ? clientNode.assertion("TYPE_CLAIM", inner) : null;
  }
  if (ts.isIdentifier(node)) {
    const symbol = knownSymbol ?? resolveSymbol(checker, node);
    if (!symbol || visiting.has(symbol)) return null;
    if (evidence.isWrittenSymbol(symbol)) return null;
    visiting.add(symbol);
    try {
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const list = declaration.parent;
          if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) continue;
          const resolved = routeParamRuntimeNode(
            declaration.initializer,
            checker,
            evidence,
            visiting,
          );
          if (resolved) return resolved;
          continue;
        }
        if (ts.isBindingElement(declaration)) {
          const variable = containingVariableDeclaration(declaration);
          const parameterName = bindingElementPropertyName(declaration);
          if (!variable?.initializer || parameterName === null) continue;
          const list = variable.parent;
          if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) continue;
          const resolved = routeParamNodeForAccess(
            variable.initializer,
            parameterName,
            declaration.getSourceFile().fileName,
            checker,
            evidence,
          );
          if (resolved) return resolved;
        }
      }
    } finally {
      visiting.delete(symbol);
    }
    return null;
  }

  const access = routeParamAccess(node);
  if (!access) return null;
  return routeParamNodeForAccess(
    access.receiver,
    access.name,
    node.getSourceFile().fileName,
    checker,
    evidence,
  );
}

function routeParamNodeForAccess(receiver, parameterName, fileName, checker, evidence) {
  if (nextUseParamsResultStatus(receiver, checker, evidence) !== "trusted") return null;
  const segmentKind = routeSegmentKind(fileName, parameterName);
  if (segmentKind === "single") return clientNode.scalar("string");
  if (segmentKind === "catchAll") {
    return clientNode.array(clientNode.scalar("string"));
  }
  if (segmentKind === "optionalCatchAll") {
    return clientNode.variants([
      clientNode.array(clientNode.scalar("string")),
      clientNode.literal(new Set([undefined])),
    ]);
  }
  return null;
}

function routeParamAccess(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return { receiver: node.expression, name: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return { receiver: node.expression, name: node.argumentExpression.text };
  }
  return null;
}

function nextUseParamsResultStatus(receiver, checker, evidence, visiting = new Set()) {
  const expression = unwrapAliasExpression(receiver);
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    isNamedImport(expression.expression, checker, "useParams", "next/navigation")
  ) {
    return "trusted";
  }
  if (!ts.isIdentifier(expression)) return null;

  const symbol = resolveSymbol(checker, expression);
  if (!symbol || visiting.has(symbol)) return null;
  visiting.add(symbol);
  try {
    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
      const list = declaration.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) continue;
      const status = nextUseParamsResultStatus(
        declaration.initializer,
        checker,
        evidence,
        visiting,
      );
      if (status) return evidence.isWrittenSymbol(symbol) ? "unsafe" : status;
    }
  } finally {
    visiting.delete(symbol);
  }
  return null;
}

function bindingElementPropertyName(declaration) {
  if (declaration.dotDotDotToken) return null;
  const property = declaration.propertyName ?? declaration.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  return null;
}

function containingVariableDeclaration(node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current)) return current;
    if (ts.isParameter(current)) return null;
    if (
      !ts.isBindingElement(current) &&
      !ts.isObjectBindingPattern(current) &&
      !ts.isArrayBindingPattern(current)
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function unwrapAliasExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression?.(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNamedImport(identifier, checker, importedName, moduleName) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return false;
  return (symbol.declarations ?? []).some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false;
    const importDeclaration = declaration.parent.parent.parent;
    return (
      ts.isImportDeclaration(importDeclaration) &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      importDeclaration.moduleSpecifier.text === moduleName &&
      (declaration.propertyName?.text ?? declaration.name.text) === importedName
    );
  });
}

function routeSegmentKind(fileName, parameterName) {
  const segments = fileName.replace(/\\/g, "/").split("/");
  if (segments.includes(`[[...${parameterName}]]`)) return "optionalCatchAll";
  if (segments.includes(`[...${parameterName}]`)) return "catchAll";
  if (segments.includes(`[${parameterName}]`)) return "single";
  return null;
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
  return unaliasSymbol(checker, checker.getSymbolAtLocation(node));
}

/**
 * Follow an alias symbol (import, re-export) to what it names; any other symbol
 * is returned as is, and a missing one as null. Shared with the census so both
 * passes resolve a use site to the same declaration.
 *
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Symbol | undefined | null} symbol
 * @returns {import("typescript").Symbol | null}
 */
export function unaliasSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol) ?? symbol;
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
    if (ts.isAssertionExpression(node) && !ts.isConstTypeReference(node.type)) return true;
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
    hasAssertionOriginForSymbol: (symbol) => Boolean(symbol && symbolHasAssertionOrigin(symbol)),
    isWrittenSymbol: (symbol) => Boolean(symbol && written.has(symbol)),
    assertionInitializerForSymbol(symbol) {
      if (!symbol || written.has(symbol) || !symbolHasAssertionOrigin(symbol)) return null;
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
  propagateWrittenAliases(program, checker, written);
  return written;
}

function recordWrittenTarget(checker, written, target) {
  const unwrapped = unwrapAliasExpression(target);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = resolveSymbol(checker, unwrapped);
    if (symbol) written.add(symbol);
    return;
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    recordWrittenTarget(checker, written, unwrapped.expression);
    return;
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (!ts.isOmittedExpression(element)) recordWrittenTarget(checker, written, element);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        recordWrittenTarget(checker, written, property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        recordWrittenTarget(checker, written, property.name);
      } else if (ts.isSpreadAssignment(property)) {
        recordWrittenTarget(checker, written, property.expression);
      }
    }
  }
}

function propagateWrittenAliases(program, checker, written) {
  /** @type {Map<import("typescript").Symbol, Set<import("typescript").Symbol>>} */
  const aliases = new Map();
  const connect = (left, right) => {
    const leftEdges = aliases.get(left) ?? new Set();
    leftEdges.add(right);
    aliases.set(left, leftEdges);
    const rightEdges = aliases.get(right) ?? new Set();
    rightEdges.add(left);
    aliases.set(right, rightEdges);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const source = unwrapAliasExpression(node.initializer);
      if (ts.isIdentifier(source)) {
        const targetSymbol = resolveSymbol(checker, node.name);
        const sourceSymbol = resolveSymbol(checker, source);
        if (targetSymbol && sourceSymbol) connect(targetSymbol, sourceSymbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visit(sourceFile);
  }

  const queue = [...written];
  for (let index = 0; index < queue.length; index += 1) {
    for (const alias of aliases.get(queue[index]) ?? []) {
      if (written.has(alias)) continue;
      written.add(alias);
      queue.push(alias);
    }
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
  if (ts.isBindingElement(declaration)) {
    const variable = containingVariableDeclaration(declaration);
    if (variable) {
      const list = variable.parent;
      const mutable = !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const);
      return { mutable, node: variable.initializer };
    }
    return { mutable: false, node: declaration.initializer };
  }
  if (ts.isParameter(declaration)) {
    return { mutable: false, node: declaration.initializer };
  }
  return { mutable: false, node: undefined };
}

/** Strip parentheses, `as`, `as unknown as`, `!` and `satisfies`. */
function unwrapReferenceExpression(node) {
  return unwrapAliasExpression(node);
}

/**
 * The path segments of a function reference rooted in `api` / `internal`,
 * following const aliases: `const ref = (api as unknown as T).search.globalSearch`
 * is `["search", "globalSearch"]`. Returns null for anything not provably a
 * literal path (a computed key, a mutable binding, a parameter, a call).
 */
function referenceChain(node, checker, depth = 0, seen = new Set()) {
  // SCRUM-178 v2 batch 3 (Opus L-b): no depth bound. A cycle is cut by `seen`
  // (each hop adds its symbol), so the walk terminates on its own; a numeric
  // cap only made a long but perfectly literal alias chain "unresolvable".
  const segments = [];
  let current = unwrapReferenceExpression(node);
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
    } else if (
      ts.isElementAccessExpression(current) &&
      (ts.isStringLiteral(current.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
    ) {
      segments.unshift(current.argumentExpression.text);
    } else {
      break;
    }
    current = unwrapReferenceExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return null;
  if (current.text === "api" || current.text === "internal") {
    // A local `const api = ...` that is itself an alias of something else is
    // not followed: the generated object (and the mobile hand-built one) are
    // the only roots, and they are recognised by name exactly as before.
    return segments;
  }
  const symbol = resolveSymbol(checker, current);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration)) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return null;
  seen.add(symbol);
  const base = referenceChain(declaration.initializer, checker, depth + 1, seen);
  return base ? [...base, ...segments] : null;
}

/** `api.vehicles.importBulk` (or an alias of it) -> `vehicles:importBulk` */
function resolveFunctionReference(node, checker) {
  if (!node) return null;
  const segments = referenceChain(node, checker);
  if (!segments || segments.length < 2) return null;
  return `${segments.slice(0, -1).join("/")}:${segments[segments.length - 1]}`;
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
