/**
 * An INDEPENDENT census of every place a client can name a Convex function.
 *
 * ⚠️ WHY THIS EXISTS. The extractor (`clientPaths.mjs`) finds the call forms it
 * was taught. A form it was never taught produces no record and no error — the
 * v1 detector missed `useQueries` and aliased references that way and every
 * report was clean. The remedy is not a longer list inside the extractor, which
 * would share the blind spot; it is a second pass that starts from DIFFERENT
 * evidence and is then reconciled against the extractor.
 *
 * What it starts from:
 *
 *   1. every CALL that resolves, by import symbol, to a declaration inside the
 *      installed `convex` package and is a known reference-taking entry point
 *      (`ENTRY_TABLE`, checked against the package's own `.d.ts` by
 *      `convexInventory.mjs`), and
 *   2. every runtime REFERENCE rooted in the generated `api` / `internal`
 *      object, found through a fixpoint over const aliases, assertions
 *      (`as unknown as`), imports and re-exports.
 *
 * It deliberately does NOT use the extractor's hook-name sets (`CLIENT_BINDERS`
 * and friends) or its call list as authority. The extractor's records are the
 * thing being CHECKED: each candidate must reconcile, by SITE IDENTITY
 * (`file:line:col` of the expression naming the function, never a count), to
 * exactly one of
 *
 *   TRANSMISSION      the extractor holds a record for that site;
 *   NON_TRANSMISSION  proved to send nothing (alias declaration, dependency
 *                     array, `getFunctionName`, an empty request map, ...);
 *   UNRESOLVED        an explicit file:line record that the reference cannot be
 *                     followed (the extractor's own, or the census's);
 *   UNACCOUNTED       nobody holds a record for a site that transmits or may
 *                     transmit. This is the one that means the extractor missed
 *                     something, and it is never allowed to read as clean.
 *
 * Tests, generated code, tooling and `convex/` are outside the file set handed
 * in (see `clientFiles.mjs`), exactly as for the extractor.
 */
import path from "node:path";
import ts from "typescript";
import { normalizeSurfacePath } from "./clientFiles.mjs";

/** @typedef {"IMMEDIATE"|"DEFERRED"|"REQUEST_MAP"|"LOCAL"|"REFERENCE_CONSTRUCTOR"|"SERVER_ONLY"|"UNSUPPORTED"} EntryKind */

/**
 * Every reference-taking export of the pinned `convex` package, classified.
 *
 *   IMMEDIATE   transmits at the call; argument 0 names the function.
 *   DEFERRED    returns a function that transmits when INVOKED; the binding and
 *               every use of the bound name are reconciled separately.
 *   REQUEST_MAP takes a map of `{query, args}` requests.
 *   LOCAL       reads or edits local state / names a function; sends nothing.
 *   SERVER_ONLY runs inside the backend; cannot skew against a deploy.
 *   UNSUPPORTED the census cannot follow it, so any use is an explicit
 *               unresolved record rather than silence.
 *
 * @type {Record<string, EntryKind>}
 */
export const ENTRY_TABLE = {
  // React hooks
  useQuery: "IMMEDIATE",
  useQuery_experimental: "IMMEDIATE",
  usePaginatedQuery: "IMMEDIATE",
  usePaginatedQuery_experimental: "IMMEDIATE",
  useMutation: "DEFERRED",
  useAction: "DEFERRED",
  createMutation: "DEFERRED",
  useQueries: "REQUEST_MAP",
  useQueriesHelper: "REQUEST_MAP",
  usePreloadedQuery: "LOCAL",
  // Clients
  "ConvexReactClient.query": "IMMEDIATE",
  "ConvexReactClient.mutation": "IMMEDIATE",
  "ConvexReactClient.action": "IMMEDIATE",
  "ConvexReactClient.watchQuery": "IMMEDIATE",
  "ConvexReactClient.prewarmQuery": "IMMEDIATE",
  "ConvexClient.query": "IMMEDIATE",
  "ConvexClient.mutation": "IMMEDIATE",
  "ConvexClient.action": "IMMEDIATE",
  "ConvexClient.onUpdate": "IMMEDIATE",
  "ConvexClient.onPaginatedUpdate_experimental": "IMMEDIATE",
  "ConvexHttpClient.query": "IMMEDIATE",
  "ConvexHttpClient.mutation": "IMMEDIATE",
  "ConvexHttpClient.action": "IMMEDIATE",
  "ConvexHttpClient.consistentQuery": "IMMEDIATE",
  // Server-component helpers (`convex/nextjs`)
  fetchQuery: "IMMEDIATE",
  fetchMutation: "IMMEDIATE",
  fetchAction: "IMMEDIATE",
  preloadQuery: "IMMEDIATE",
  preloadedQueryResult: "LOCAL",
  // Local state, naming and optimistic updates
  getFunctionName: "LOCAL",
  "OptimisticLocalStore.getQuery": "LOCAL",
  "OptimisticLocalStore.setQuery": "LOCAL",
  "OptimisticLocalStore.getAllQueries": "LOCAL",
  insertAtTop: "LOCAL",
  insertAtBottomIfLoaded: "LOCAL",
  insertAtPosition: "LOCAL",
  optimisticallyUpdateValueInPaginatedQuery: "LOCAL",
  "QueriesObserver.getLocalResults": "LOCAL",
  "QueriesObserver.setQueries": "UNSUPPORTED",
  // Backend-only
  "GenericActionCtx.runAction": "SERVER_ONLY",
  "GenericActionCtx.runMutation": "SERVER_ONLY",
  "GenericActionCtx.runQuery": "SERVER_ONLY",
  "GenericMutationCtx.runMutation": "SERVER_ONLY",
  "GenericMutationCtx.runQuery": "SERVER_ONLY",
  "GenericQueryCtx.runQuery": "SERVER_ONLY",
  "Scheduler.runAfter": "SERVER_ONLY",
  "Scheduler.runAt": "SERVER_ONLY",
  "Crons.cron": "SERVER_ONLY",
  "Crons.daily": "SERVER_ONLY",
  "Crons.hourly": "SERVER_ONLY",
  "Crons.interval": "SERVER_ONLY",
  "Crons.monthly": "SERVER_ONLY",
  "Crons.weekly": "SERVER_ONLY",
  createFunctionHandle: "SERVER_ONLY",
};

/**
 * Inventory keys the table does not classify. Empty means every reference-taking
 * export of the pinned package has a decision recorded for it.
 *
 * @param {Iterable<string>} inventoryKeys
 * @param {Record<string, EntryKind>} [table]
 */
export function unclassifiedEntryPoints(inventoryKeys, table = ENTRY_TABLE) {
  return [...inventoryKeys].filter((key) => !(key in table)).sort();
}

/**
 * Where a reference ROOT lives: the generated object, and the mobile app's
 * hand-built one (`makeFunctionReference` per function, same shape). A local
 * variable that merely happens to be called `api` is neither, so it is not a
 * candidate — roots are recognised by DECLARATION, never by name.
 */
const ROOT_DECLARATION_FILES = [
  /(^|\/)convex\/_generated\/api\.(d\.ts|js|ts)$/,
  /(^|\/)apps\/mobile\/src\/convexApi\.ts$/,
];

const DEPENDENCY_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useImperativeHandle",
]);

const SEVERITY = { NON_TRANSMISSION: 0, TRANSMISSION: 1, UNRESOLVED: 2, UNACCOUNTED: 3 };

/**
 * @typedef {{
 *   siteId: string, file: string, line: number, roles: string[],
 *   disposition: "TRANSMISSION"|"NON_TRANSMISSION"|"UNRESOLVED"|"UNACCOUNTED",
 *   reason: string
 * }} Candidate
 */

const toPosix = (p) => p.replace(/\\/g, "/");

/**
 * @param {{
 *   program: import("typescript").Program,
 *   files: string[],
 *   extraction: import("./clientPaths.mjs").Extraction,
 *   entryTable?: Record<string, EntryKind>,
 * }} input
 */
export function runCensus({ program, files, extraction, entryTable = ENTRY_TABLE }) {
  const checker = program.getTypeChecker();
  const inScope = new Set(files.map((f) => normalizeSurfacePath(f)));
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        inScope.has(normalizeSurfacePath(sf.fileName))
    );

  const relFile = (sf) => toPosix(path.relative(process.cwd(), sf.fileName));
  const siteOf = (sf, node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${relFile(sf)}:${line + 1}:${character + 1}`;
  };
  const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  // ── The extractor's records, indexed by site identity ──────────────────────
  const callAt = new Map(extraction.calls.map((c) => [c.siteId, c]));
  const unresolvedAt = new Map(extraction.unresolvedBinders.map((u) => [u.siteId, u]));
  const skipAt = new Map((extraction.provedSkips ?? []).map((s) => [s.siteId, s]));
  const byMap = (list) => {
    const out = new Map();
    for (const r of list) {
      if (!r.mapSiteId) continue;
      if (!out.has(r.mapSiteId)) out.set(r.mapSiteId, []);
      out.get(r.mapSiteId).push(r);
    }
    return out;
  };
  const callsByMap = byMap(extraction.calls);
  const unresolvedByMap = byMap(extraction.unresolvedBinders);
  const skipsByMap = byMap(extraction.provedSkips ?? []);

  // ── Symbol helpers ─────────────────────────────────────────────────────────
  const resolve = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        /* not an alias after all */
      }
    }
    return symbol ?? null;
  };

  // ⚠️ The ROOT is the exported VARIABLE (`api`, `internal`), not everything the
  // declaring file contains. Testing only the file matched every property of
  // the mobile `api` object (`api.directMessages`, `.listConversations`) and
  // every type in that file, turning one reference into thousands of "escapes".
  const isRootSymbol = (symbol) =>
    (symbol?.declarations ?? []).some(
      (d) =>
        ts.isVariableDeclaration(d) &&
        ROOT_DECLARATION_FILES.some((re) => re.test(toPosix(d.getSourceFile().fileName)))
    );

  // True once ANY symbol resolved into the installed `convex` package. A program
  // that never did has not been looked at through the SDK at all (unresolvable
  // `convex` install), so an empty census would be blindness, not cleanliness.
  let sdkResolved = false;

  /** `Owner.method` / `exportName` for a declaration inside the convex package. */
  const sdkKeyOf = (symbol) => {
    for (const d of symbol?.declarations ?? []) {
      if (!/\/node_modules\/convex\//.test(toPosix(d.getSourceFile().fileName))) continue;
      const name = d.name && ts.isIdentifier(d.name) ? d.name.text : symbol.name;
      const parent = d.parent;
      const owner =
        parent && (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name
          ? parent.name.text
          : null;
      sdkResolved = true;
      return owner ? `${owner}.${name}` : name;
    }
    return null;
  };

  const unwrapOut = (node) => {
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
  };

  /** The maximal member chain (through parens and assertions) containing `identifier`. */
  const climb = (identifier) => {
    let current = identifier;
    for (;;) {
      const parent = current.parent;
      if (!parent) break;
      if (
        (ts.isParenthesizedExpression(parent) ||
          ts.isNonNullExpression(parent) ||
          ts.isAssertionExpression(parent) ||
          ts.isSatisfiesExpression?.(parent)) &&
        parent.expression === current
      ) {
        current = parent;
        continue;
      }
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current
      ) {
        current = parent;
        continue;
      }
      break;
    }
    return current;
  };

  const inTypePosition = (node) => {
    for (let n = node; n; n = n.parent) {
      if (ts.isTypeNode(n) || ts.isTypeQueryNode(n)) return true;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n)) {
        return true;
      }
      if (ts.isStatement(n)) return false;
    }
    return false;
  };

  const isDeclarationName = (identifier) => {
    const parent = identifier.parent;
    return Boolean(
      parent &&
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent)) &&
        parent.name === identifier
    );
  };

  // ── Candidate store ────────────────────────────────────────────────────────
  /** @type {Map<string, Candidate>} */
  const candidates = new Map();
  const record = (sf, node, role, disposition, reason) => {
    const siteId = siteOf(sf, node);
    const existing = candidates.get(siteId);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      if (SEVERITY[disposition] > SEVERITY[existing.disposition]) {
        existing.disposition = disposition;
        existing.reason = reason;
      }
      return;
    }
    candidates.set(siteId, {
      siteId,
      file: relFile(sf),
      line: lineOf(sf, node),
      roles: [role],
      disposition,
      reason,
    });
  };

  /** Disposition of a site the extractor is supposed to hold a record for. */
  const reconcile = (sf, node, role, what) => {
    const siteId = siteOf(sf, node);
    const call = callAt.get(siteId);
    if (call) return record(sf, node, role, "TRANSMISSION", `${what}: extractor call ${call.identifier}`);
    const skip = skipAt.get(siteId);
    if (skip) return record(sf, node, role, "NON_TRANSMISSION", skip.reason);
    const unresolved = unresolvedAt.get(siteId);
    if (unresolved) {
      return record(sf, node, role, "UNRESOLVED", `${unresolved.cause}: ${unresolved.reason}`);
    }
    return record(sf, node, role, "UNACCOUNTED", `${what}: the extractor holds no record for this site`);
  };

  // ── Phase 1: alias fixpoint ────────────────────────────────────────────────
  /** @type {Set<import("typescript").Symbol>} */
  const tracked = new Set();
  const isTrackedRoot = (symbol) => Boolean(symbol) && (tracked.has(symbol) || isRootSymbol(symbol));

  const eachFile = (fn) => {
    for (const sf of sourceFiles) {
      const visit = (node) => {
        fn(node, sf);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };

  for (let pass = 0; pass < 12; pass++) {
    let grew = false;
    eachFile((node) => {
      if (!ts.isIdentifier(node) || isDeclarationName(node) || inTypePosition(node)) return;
      if (!isTrackedRoot(resolve(node))) return;
      const chain = climb(node);
      const parent = chain.parent;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        parent.initializer === chain &&
        ts.isIdentifier(parent.name)
      ) {
        const list = parent.parent;
        if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) {
          const symbol = checker.getSymbolAtLocation(parent.name);
          if (symbol && !tracked.has(symbol)) {
            tracked.add(symbol);
            grew = true;
          }
        }
      }
    });
    if (!grew) break;
  }

  // ── Phase 2: SDK entry-point calls ─────────────────────────────────────────
  /** Deferred bindings: bound symbol -> its declaration site. */
  const deferredBindings = new Map();
  /** Reference sites already owned by an SDK role, so the chain pass skips them. */
  const sdkOwnedSites = new Set();

  eachFile((node, sf) => {
    // A reference-taking entry point used as a VALUE (not called) cannot be followed.
    if (ts.isIdentifier(node) && !isDeclarationName(node) && !inTypePosition(node)) {
      const symbol = resolve(node);
      const key = sdkKeyOf(symbol);
      if (key && key in entryTable) {
        const parent = node.parent;
        const callee =
          parent && ts.isCallExpression(parent) && unwrapOut(parent.expression) === node
            ? parent
            : parent &&
                ts.isPropertyAccessExpression(parent) &&
                parent.name === node &&
                parent.parent &&
                ts.isCallExpression(parent.parent) &&
                unwrapOut(parent.parent.expression) === parent
              ? parent.parent
              : null;
        const isMember = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
        // Only module-level exports can be aliased as plain values; a member
        // that is not called is a method reference.
        if (!callee && (!isMember || key.includes("."))) {
          const kind = entryTable[key];
          if (kind !== "LOCAL" && kind !== "SERVER_ONLY") {
            record(sf, node, `value:${key}`, "UNRESOLVED", `${key} is used as a value, not called, so its arguments cannot be followed`);
          }
        }
      }
    }

    if (!ts.isCallExpression(node)) return;
    const callee = unwrapOut(node.expression);
    let symbol = null;
    if (ts.isIdentifier(callee)) symbol = resolve(callee);
    else if (ts.isPropertyAccessExpression(callee)) symbol = resolve(callee.name);
    const key = sdkKeyOf(symbol);
    if (!key) return;
    const kind = entryTable[key];
    // An SDK function the table does not classify is NOT a gap by itself:
    // `useConvexAuth()` or the `loadMore` a paginated hook returns take no
    // function reference. The pinned d.ts inventory (convexInventory.mjs) is
    // what proves every reference-taking export IS classified (drift test), and
    // a function reference handed to an unclassified call is caught by the
    // reference phase below ("passed to ... not a known Convex entry point").
    if (!kind) return;
    const role = `sdk:${key}`;
    const arg0 = node.arguments[0];

    switch (kind) {
      case "IMMEDIATE": {
        if (!arg0) return record(sf, node, role, "UNACCOUNTED", `${key} called with no function reference`);
        sdkOwnedSites.add(siteOf(sf, arg0));
        return reconcile(sf, arg0, role, key);
      }
      case "REQUEST_MAP": {
        const mapNode = arg0 ?? node;
        const mapSite = siteOf(sf, mapNode);
        sdkOwnedSites.add(mapSite);
        const unresolved = unresolvedByMap.get(mapSite) ?? [];
        const calls = callsByMap.get(mapSite) ?? [];
        const skips = skipsByMap.get(mapSite) ?? [];
        if (unresolved.length) {
          return record(sf, mapNode, role, "UNRESOLVED", `${unresolved.length} request-map entr${unresolved.length === 1 ? "y" : "ies"} cannot be followed`);
        }
        if (calls.length) return record(sf, mapNode, role, "TRANSMISSION", `${calls.length} request-map entr${calls.length === 1 ? "y" : "ies"}`);
        if (skips.length) return record(sf, mapNode, role, "NON_TRANSMISSION", "every branch of the request map is empty");
        return record(sf, mapNode, role, "UNACCOUNTED", `${key}: the extractor holds no record for this request map`);
      }
      case "DEFERRED": {
        if (!arg0) return record(sf, node, role, "UNACCOUNTED", `${key} called with no function reference`);
        sdkOwnedSites.add(siteOf(sf, arg0));
        const unresolved = unresolvedAt.get(siteOf(sf, arg0));
        if (unresolved) {
          return record(sf, arg0, role, "UNRESOLVED", `${unresolved.cause}: ${unresolved.reason}`);
        }
        const parent = node.parent;
        if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
          const bound = checker.getSymbolAtLocation(parent.name);
          if (bound) deferredBindings.set(bound, parent.name);
          return record(sf, arg0, role, "NON_TRANSMISSION", "binding only; every use of the bound name is reconciled at its own site");
        }
        return record(sf, arg0, role, "UNACCOUNTED", `${key}: the result is not bound to a simple name and the extractor holds no record`);
      }
      case "LOCAL":
      case "SERVER_ONLY":
        for (const argument of node.arguments) sdkOwnedSites.add(siteOf(sf, argument));
        return record(sf, node, role, "NON_TRANSMISSION", kind === "LOCAL" ? `${key} sends nothing` : `${key} runs inside the backend`);
      case "UNSUPPORTED":
        return record(sf, node, role, "UNRESOLVED", `${key} is not followed by this control`);
      default:
        return undefined;
    }
  });

  // ── Phase 3: every reference chain rooted in the generated api ─────────────
  eachFile((node, sf) => {
    if (!ts.isIdentifier(node) || isDeclarationName(node) || inTypePosition(node)) return;
    const symbol = resolve(node);
    if (!isTrackedRoot(symbol)) return;
    const chain = climb(node);
    const site = siteOf(sf, chain);
    if (sdkOwnedSites.has(site)) return;
    const role = "reference";
    const parent = chain.parent;

    // `const ref = <chain>`: an alias. Its uses are chains of their own.
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === chain) {
      const list = parent.parent;
      const isConst = ts.isVariableDeclarationList(list) && Boolean(list.flags & ts.NodeFlags.Const);
      if (ts.isIdentifier(parent.name) && isConst) {
        return record(sf, chain, role, "NON_TRANSMISSION", "const alias; its uses are reconciled at their own sites");
      }
      return record(sf, chain, role, "UNRESOLVED", "bound by destructuring or a mutable binding, so its uses cannot be followed");
    }
    // A `{ query: <chain> }` request-map entry.
    if (parent && ts.isPropertyAssignment(parent) && parent.initializer === chain && ts.isIdentifier(parent.name) && parent.name.text === "query") {
      return reconcile(sf, chain, role, "request-map entry");
    }
    // A dependency array.
    if (parent && ts.isArrayLiteralExpression(parent)) {
      const call = parent.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        call.arguments.indexOf(parent) >= 1 &&
        (ts.isIdentifier(call.expression)
          ? DEPENDENCY_HOOKS.has(call.expression.text)
          : ts.isPropertyAccessExpression(call.expression) && DEPENDENCY_HOOKS.has(call.expression.name.text))
      ) {
        return record(sf, chain, role, "NON_TRANSMISSION", "dependency array element");
      }
    }
    // The extractor has a record here (e.g. a Form B call on a callee the census
    // does not classify as an SDK entry point).
    const siteHolder = callAt.get(site) ?? unresolvedAt.get(site);
    if (siteHolder) return reconcile(sf, chain, role, "reference");
    // An argument of some other call hands the reference to code we cannot see.
    if (parent && ts.isCallExpression(parent) && parent.arguments.includes(chain)) {
      return record(sf, chain, role, "UNRESOLVED", `passed to ${parent.expression.getText().slice(0, 60)}, which is not a known Convex entry point`);
    }
    return record(sf, chain, role, "UNRESOLVED", "a Convex function reference escapes into an expression the census cannot follow");
  });

  // ── Phase 4: every use of a bound mutation / action ───────────────────────
  for (const [bound, declarationName] of deferredBindings) {
    eachFile((node, sf) => {
      if (!ts.isIdentifier(node) || node === declarationName) return;
      if (resolve(node) !== bound && checker.getSymbolAtLocation(node) !== bound) return;
      if (isDeclarationName(node)) return;
      // `typeof update` / `Parameters<typeof update>` names the binding's TYPE
      // and sends nothing at runtime.
      if (inTypePosition(node)) return;
      const parent = node.parent;
      const isCallee = parent && ts.isCallExpression(parent) && parent.expression === node;
      if (isCallee) return reconcile(sf, node, "invocation", "invocation of a bound Convex function");
      if (parent && ts.isArrayLiteralExpression(parent)) {
        const call = parent.parent;
        if (
          call &&
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          DEPENDENCY_HOOKS.has(call.expression.text)
        ) {
          return record(sf, node, "invocation", "NON_TRANSMISSION", "dependency array element");
        }
      }
      return record(sf, node, "invocation", "UNRESOLVED", "a bound Convex function is passed or returned, so its call sites are not followed");
    });
  }

  // ── Reverse check: records the census has no candidate for ─────────────────
  const known = new Set(candidates.keys());
  const mapSites = new Set();
  for (const c of candidates.values()) mapSites.add(c.siteId);
  /** @type {{siteId: string, kind: string}[]} */
  const orphans = [];
  for (const call of extraction.calls) {
    if (!known.has(call.siteId)) orphans.push({ siteId: call.siteId, kind: `call ${call.identifier}` });
  }
  for (const u of extraction.unresolvedBinders) {
    if (!known.has(u.siteId) && !(u.mapSiteId && mapSites.has(u.mapSiteId))) {
      orphans.push({ siteId: u.siteId, kind: `unresolved ${u.cause}` });
    }
  }

  const list = [...candidates.values()].sort((a, b) => (a.siteId < b.siteId ? -1 : 1));
  const totals = { candidates: list.length, TRANSMISSION: 0, NON_TRANSMISSION: 0, UNRESOLVED: 0, UNACCOUNTED: 0 };
  for (const c of list) totals[c.disposition]++;
  return {
    candidates: list,
    totals,
    unresolved: list.filter((c) => c.disposition === "UNRESOLVED"),
    unaccounted: list.filter((c) => c.disposition === "UNACCOUNTED"),
    orphans,
    sdkResolved,
    // The extractor has calls but the census could not see through the SDK to
    // any of them: it is BLIND, which must never read as "found nothing".
    blind: extraction.calls.length > 0 && !sdkResolved,
    incomplete:
      totals.UNRESOLVED + totals.UNACCOUNTED + orphans.length > 0 ||
      (extraction.calls.length > 0 && !sdkResolved),
  };
}
