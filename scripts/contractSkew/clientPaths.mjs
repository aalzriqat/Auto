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
/** `useQuery(fn, "skip")` does not run, so it transmits nothing. */
const SKIP_SENTINEL = "skip";
/** Direct invocation forms: convex.mutation(api.x.y, {...}) / ctx.runMutation(...). */
const DIRECT_CALLERS = new Set([
  "mutation", "query", "action",
  "runMutation", "runQuery", "runAction",
  "fetchQuery", "fetchMutation", "fetchAction",
  "preloadQuery",
]);

const MAX_DEPTH = 12;

/**
 * @param {string[]} rootFiles  entry files to type-check
 * @param {string} tsconfigPath
 * @returns {{ calls: Array<{identifier:string, file:string, line:number, sent:Map<string,{optional:boolean}>, unknowns:string[]}>, diagnosticsCount:number }}
 */
export function extractClientCalls(rootFiles, tsconfigPath) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );

  const program = ts.createProgram({
    rootNames: rootFiles.length ? rootFiles : parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

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
  const normalize = (p) => path.resolve(p).split(path.sep).join("/").toLowerCase();
  const inScope = new Set(rootFiles.map(normalize));

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    if (inScope.size && !inScope.has(normalize(sourceFile.fileName))) continue;

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
          const sent = new Map();
          const unknowns = [];
          const casts = [];
          const payload = node.arguments[1];
          const isSkip =
            payload && ts.isStringLiteral(payload) && payload.text === SKIP_SENTINEL;
          if (payload && !isSkip) {
            collectFromExpression(checker, payload, "", sent, unknowns, casts, 0, new Set());
          }
          calls.push({
            identifier: id,
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            sent,
            unknowns,
            casts,
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
          const sent = new Map();
          const unknowns = [];
          const casts = [];
          if (argExpr) {
            collectFromExpression(checker, argExpr, "", sent, unknowns, casts, 0, new Set());
          } else {
            // Called with no payload at all. That is knowable, not unknown.
          }
          calls.push({
            identifier,
            file: path.relative(process.cwd(), sourceFile.fileName).replace(/\\/g, "/"),
            line: line + 1,
            sent,
            unknowns,
            casts,
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
 * `chunk as any` still sends `chunk`'s shape over the wire. So assertions are
 * stripped and the underlying expression is typed instead. Object and array
 * literals are walked syntactically for the same reason — it keeps per-property
 * precision when an inner property is itself cast.
 *
 * Every cast stripped is recorded in `casts`. That is deliberate: `as any` at a
 * Convex boundary disables the compiler's own contract checking, so it is worth
 * surfacing as a risk in its own right rather than silently compensating for it.
 */
function collectFromExpression(checker, expr, prefix, out, unknowns, casts, depth, seen) {
  if (depth > MAX_DEPTH) {
    unknowns.push(`${prefix || "<root>"} (max depth)`);
    return;
  }

  let node = expr;
  // Strip parentheses, `as X`, `satisfies X` and `!` — none changes the payload.
  for (;;) {
    if (ts.isParenthesizedExpression(node)) { node = node.expression; continue; }
    if (ts.isNonNullExpression(node)) { node = node.expression; continue; }
    if (ts.isAsExpression(node) || (ts.isSatisfiesExpression?.(node) ?? false)) {
      const toAny =
        node.type &&
        (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword);
      if (toAny) casts.push(`${prefix || "<root>"} (as any)`);
      node = node.expression;
      continue;
    }
    break;
  }

  if (ts.isObjectLiteralExpression(node)) {
    if (prefix) setKind(out, prefix, "object");
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // `...rest` — resolvable by type; merge whatever it contributes.
        const spreadType = checker.getTypeAtLocation(prop.expression);
        collectPaths(checker, spreadType, prefix, out, unknowns, depth + 1, seen);
        continue;
      }
      const name = propertyName(prop);
      if (name === null) {
        // Computed key: the field name is not statically knowable.
        unknowns.push(`${prefix ? `${prefix}.` : ""}[computed]`);
        continue;
      }
      const childPath = prefix ? `${prefix}.${name}` : name;
      record(out, childPath, false, "LITERAL");
      const value = ts.isPropertyAssignment(prop)
        ? prop.initializer
        : ts.isShorthandPropertyAssignment(prop)
          ? prop.name
          : null;
      if (value) collectFromExpression(checker, value, childPath, out, unknowns, casts, depth + 1, seen);
    }
    return;
  }

  if (ts.isArrayLiteralExpression(node)) {
    if (prefix) setKind(out, prefix, "array");
    const elementPath = `${prefix}[*]`;
    record(out, elementPath, false, "LITERAL");
    for (const element of node.elements) {
      collectFromExpression(checker, element, elementPath, out, unknowns, casts, depth + 1, seen);
    }
    return;
  }

  // Not a literal — fall back to the type of the (unwrapped) expression.
  const type = checker.getTypeAtLocation(node);
  collectPaths(checker, type, prefix, out, unknowns, depth, seen, out.get(prefix)?.provenance ?? "LITERAL");
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
 * Walk a TS type into dotted/bracketed paths.
 *
 * `seen` guards recursive types; without it a self-referential payload type
 * (a tree node, a threaded comment) would recurse until the stack died and the
 * whole run would report nothing at all.
 */
function collectPaths(checker, type, prefix, out, unknowns, depth, seen, inherited = "LITERAL") {
  if (depth > MAX_DEPTH) {
    if (prefix) unknowns.push(`${prefix} (max depth)`);
    return;
  }

  const flags = type.getFlags();

  // Stamp this path's own value kind. The extractor stays FACTUAL — it reports
  // what the type is, and the comparator decides what that means. Keeping the
  // policy out of here is what lets one honest fact ("this value is `any`")
  // produce two different verdicts depending on what the backend declared.
  if (prefix) setKind(out, prefix, kindOfType(checker, type, flags), literalsOfType(type));

  // any / unknown: the value is not statically knowable here.
  //
  // ⚠️ This is NOT automatically safe, and it is NOT automatically breaking.
  // An `any` at a path the backend declares as a scalar cannot hide an
  // undeclared KEY, but it can still hide an incompatible VALUE — a runtime
  // `make: 123` against `v.string()` is rejected by Convex just as surely as
  // an unknown field. An `any` at a path the backend declares as an object or
  // array is worse: extra keys can hide inside it. The comparator draws that
  // line; recording it as plain "unknown" here would throw away the
  // information needed to draw it at all.
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) {
    unknowns.push(prefix || "<root>");
    return;
  }

  // Unions: a property present in only some branches is optional overall.
  if (type.isUnion()) {
    for (const branch of type.types) {
      if (branch.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      collectPaths(checker, branch, prefix, out, unknowns, depth + 1, seen, inherited);
    }
    return;
  }

  // Arrays / tuples -> `[*]` and descend into the element type.
  const elementType = getElementType(checker, type);
  if (elementType) {
    const elementPath = `${prefix}[*]`;
    const elementProvenance = out.get(prefix)?.provenance ?? inherited;
    record(out, elementPath, false, elementProvenance);
    collectPaths(checker, elementType, elementPath, out, unknowns, depth + 1, seen, elementProvenance);
    return;
  }

  // Primitives and Convex Ids are leaves; they were recorded by the parent.
  if (!(flags & ts.TypeFlags.Object)) return;

  const typeId = type.id ?? checker.typeToString(type);
  const seenKey = `${prefix}::${typeId}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);

  // An index signature accepts arbitrary keys: dynamic, not empty.
  const stringIndex = checker.getIndexInfoOfType?.(type, ts.IndexKind.String);
  if (stringIndex) {
    unknowns.push(`${prefix ? prefix : "<root>"}[*key*]`);
  }

  for (const prop of checker.getPropertiesOfType(type)) {
    const name = prop.getName();
    if (name.startsWith("__")) continue;
    const childPath = prefix ? `${prefix}.${name}` : name;
    const optional = Boolean(prop.getFlags() & ts.SymbolFlags.Optional);
    // Provenance is inherited, exactly as optionality is on the validator side.
    // A REQUIRED field inside an OPTIONAL parent is not transmitted when the
    // parent is absent, so it cannot be stronger evidence than its parent.
    // Without this, `sourceLikeVehicle.make` reads as proven while
    // `sourceLikeVehicle` itself is only a maybe — eight fabricated BREAKING
    // findings in the third whole-repo run.
    const ownProvenance = optional ? "TYPE_OPTIONAL" : "TYPE_REQUIRED";
    const childProvenance = inherited === "TYPE_OPTIONAL" ? "TYPE_OPTIONAL" : ownProvenance;
    record(out, childPath, optional, childProvenance);

    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) {
      unknowns.push(childPath);
      continue;
    }
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    collectPaths(checker, propType, childPath, out, unknowns, depth + 1, seen, childProvenance);
  }
}

function getElementType(checker, type) {
  if (checker.isArrayType?.(type)) {
    const args = checker.getTypeArguments(type);
    return args?.[0] ?? null;
  }
  if (checker.isTupleType?.(type)) {
    const args = checker.getTypeArguments(type);
    return args?.[0] ?? null;
  }
  return null;
}

/**
 * ⚠️ PROVENANCE: HOW DO WE KNOW THIS FIELD IS ACTUALLY SENT?
 *
 * Presence in a shared TypeScript type is not transmission. The first whole-repo
 * run reported `wizardData.vehicleItems` as BREAKING because the type permits
 * it — while the call site never sets it, so Convex never sees it. An OPTIONAL
 * property nobody assigns is not a defect; claiming otherwise is the detector
 * inventing an outage.
 *
 *   LITERAL        an explicit property in the object literal at the call site
 *   SPREAD         contributed by a resolvable spread
 *   TYPE_REQUIRED  a non-optional property of a resolved type: always present
 *   TYPE_OPTIONAL  an optional property: MAY be sent, unproven
 *
 * Only the first three prove transmission and can justify BREAKING.
 * TYPE_OPTIONAL is SHAPE_UNKNOWN — real uncertainty, honestly labelled.
 *
 * The strongest provenance seen for a path wins: one call site that definitely
 * sends a field is enough to prove it is transmitted.
 */
const PROVENANCE_RANK = { TYPE_OPTIONAL: 0, TYPE_REQUIRED: 1, SPREAD: 2, LITERAL: 3 };

function record(out, pathKey, optional, provenance = "TYPE_OPTIONAL") {
  const existing = out.get(pathKey);
  if (!existing) {
    out.set(pathKey, { optional, valueKind: "unresolved", provenance });
    return;
  }
  existing.optional = existing.optional && optional;
  if (PROVENANCE_RANK[provenance] > PROVENANCE_RANK[existing.provenance ?? "TYPE_OPTIONAL"]) {
    existing.provenance = provenance;
  }
}

/**
 * Attach the value kind to an already-recorded path.
 *
 * `any` wins over everything: if ANY route to this path is opaque, the path is
 * opaque. Two call sites sending the same field, one typed and one `any`, means
 * the field is not verified — taking the typed one would report a confidence
 * the code does not support.
 */
function setKind(out, pathKey, kind, literals = null) {
  const existing = out.get(pathKey);
  if (!existing) {
    out.set(pathKey, { optional: false, valueKind: kind, literals });
    return;
  }
  if (existing.valueKind === "any" || kind === "any") existing.valueKind = "any";
  else if (existing.valueKind === "unresolved") existing.valueKind = kind;
  else if (existing.valueKind !== kind) existing.valueKind = "union";

  // Merging call sites: the set stays a whitelist only while EVERY contributor
  // is itself enumerable. One widened route makes the whole path unprovable.
  if (existing.literals === undefined) existing.literals = literals;
  else if (existing.literals && literals) for (const v of literals) existing.literals.add(v);
  else existing.literals = null;
}

/**
 * The values a client type can actually take, or `null` when it is wider than
 * an enumeration.
 *
 * A literal type (`"CASH"`) or a union of them is provable against a validator's
 * accepted set. A plain `string` is not — it is assignable from anything, so it
 * can carry `"MAYBE"` to a validator that accepts only `"CASH" | "CHEQUE"`.
 * That is a TYPE_UNKNOWN, not a pass.
 */
function literalsOfType(type) {
  if (type.isStringLiteral?.() || type.isNumberLiteral?.()) return new Set([type.value]);
  if (type.isUnion?.()) {
    const values = new Set();
    for (const branch of type.types) {
      if (branch.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      if (branch.isStringLiteral?.() || branch.isNumberLiteral?.()) values.add(branch.value);
      else if (branch.getFlags() & ts.TypeFlags.BooleanLiteral) {
        values.add(checkerBooleanValue(branch));
      } else return null; // a non-literal branch widens it open
    }
    return values.size ? values : null;
  }
  if (type.getFlags() & ts.TypeFlags.BooleanLiteral) return new Set([checkerBooleanValue(type)]);
  return null;
}

function checkerBooleanValue(type) {
  // TS models `true`/`false` as intrinsic names on the literal type.
  return type.intrinsicName === "true";
}

/** Coarse classification — enough to compare against a Convex validator. */
function kindOfType(checker, type, flags) {
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return "any";
  if (flags & (ts.TypeFlags.StringLike)) return "string";
  if (flags & (ts.TypeFlags.NumberLike)) return "number";
  if (flags & (ts.TypeFlags.BooleanLike)) return "boolean";
  if (flags & (ts.TypeFlags.BigIntLike)) return "bigint";
  if (flags & ts.TypeFlags.Null) return "null";
  if (type.isUnion?.()) return "union";
  if (checker.isArrayType?.(type) || checker.isTupleType?.(type)) return "array";
  if (flags & ts.TypeFlags.Object) return "object";
  return "unresolved";
}
