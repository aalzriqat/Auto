/**
 * The economic-command census (SCRUM-313).
 *
 * The release instrument for "which public mutations can move money, and what
 * stops each of them happening twice". It replaces reasoning about
 * `runWithIdempotency` callers, which was only ever a SUBSET: the old 31-command
 * SCRUM-57 manifest is contained in this population, not equal to it.
 *
 * The population is derived in BOTH directions and the two must agree exactly:
 *   forward  public mutation -> financial sink
 *   reverse  financial sink  -> public mutation   (over reversed edges)
 * Agreement is asserted, not assumed — see the test beside this file.
 *
 * ── Seven blind spots this analyzer has already had, each of which produced a
 * WRONG census before it was caught. All seven are pinned as regression tests in
 * `economicCommandCensus.test.ts`; do not "simplify" any of them away.
 *
 *  1. BARE-NAME CALLEE RESOLUTION fuses this graph. `create`, `add` and
 *     `update` are symbol names in dozens of modules, so resolving a callee by
 *     name alone linked every module to every other and reported 348 of 349
 *     public mutations as economic. Edges resolve through real import
 *     statements.
 *
 *  2. "ECONOMIC" IS NOT "INSERTS A LEDGER ROW". Defining a sink as a journal /
 *     accountingEvents insert DROPPED seven already-protected commands
 *     (deposits.release, paymentIntents.create, the three financeDealCosts.*,
 *     and two applications.*SupplierDisbursement*). They are at-most-once money
 *     commands that never post. A sink is any write to a MONEY-BEARING table.
 *
 *  3. `ctx.db.patch` / `ctx.db.replace` TAKE A DOCUMENT ID, NEVER A TABLE NAME.
 *     A regex on the call site can therefore only ever see inserts, which made
 *     sink detection silently insert-only and hid every command that moves money
 *     by mutating an existing row.
 *
 *  4. MINT-AND-POST DETECTION MUST BE TRANSITIVE. A command that delegates to a
 *     helper — `partnerEquity.add` -> `recordMovement`, which mints the
 *     transactions row and posts — is invisible to a check that reads only the
 *     command's own body. A local-only check called 13 further commands safe.
 *
 *  5. COMMENT TEXT IS NOT A CALL. A body is sliced to the next declaration, so
 *     the next function's JSDoc sits in the previous body, and matching call /
 *     hook tokens over raw text turned a JSDoc naming a hook into a false money
 *     edge (SCRUM-738). Edge extraction reads comment-free text (`stripComments`,
 *     TypeScript-aware so strings, templates and regexes are not mistaken for
 *     comments). Sinks and mint/post checks deliberately still read raw bodies.
 *
 *  6. A FACTORY-BUILT HOOK IS A REAL CALL. Edge text started on the line AFTER
 *     the declaration, so `export const hookX = makeHook("X", ...)` and
 *     `makeReversalHook<T>({` had no edge to their factory; comment-derived edges
 *     had been hiding that (SCRUM-738 review F1). The declaration line's code
 *     after the first `=` is read for `const`/`let`, with the Convex builder
 *     calls blanked so a command does not link to the `mutation` wrapper, and a
 *     call may carry a type-argument list. (In practice only `const` lines reach
 *     this read: the DECL matcher never matches `let`, so the `let` branch in
 *     `declarationEdgeText` is currently unreachable. Documented, not changed.)
 *
 *  7. A CONVEX FUNCTION REFERENCE IS A DELEGATION (SCRUM-743). `ctx.runMutation(
 *     internal.m.f, …)` and `scheduler.runAfter(0, internal.m.f)` reach `m.f`
 *     without a call expression, and a public ACTION (not only a mutation) is a
 *     client-callable command. Neither was in the graph: six public mutations and
 *     one action reached money through references alone (136 -> 143).
 *
 * ── KNOWN under-inclusive gaps. The list is NOT exhaustive of what a regex call
 *   graph can miss; known gaps include:
 *   SCRUM-742 (regex shapes, pinned as KNOWN GAP tests, guarded by a tripwire):
 *   (a) a generic call whose type argument contains parentheses, e.g.
 *       `make<{ cb: (x: number) => void }>()`, gets no edge (the type-argument
 *       pattern cannot span `(`);
 *   (b) ANY call on a top-level `function` declaration line, i.e. a parameter
 *       default (`function w(ctx, x = sink(ctx))`) or a one-line body
 *       (`function w(ctx) { hookX(ctx); }`), gets no edge (the line is not read).
 *   SCRUM-743 closed the Convex function REFERENCE gap (blind spot 7:
 *       `ctx.runMutation/runAction(internal.…)`, `ctx.scheduler.runAfter/runAt(…,
 *       internal.…|api.…)` are edges; public ACTIONS are entrypoints).
 *   Still not modelled (SCRUM-742, NOT guarded by any tripwire): `httpAction`
 *   route handlers (`http.route`), namespace/default imports, re-exports, and
 *   function values passed without being called (other than `hook*` names), and
 *   a function reference held in a variable.
 *   No SCRUM-742 shape is on a current money path; the `SCRUM-742 tripwire` test
 *   in `economicCommandCensus.test.ts` fails if one appears in convex/. The fix
 *   is a TypeScript-AST rewrite of edge extraction (SCRUM-742).
 *
 * The design OBJECTIVE is an OVER-INCLUSIVE bias: a false positive costs one
 * explicit classification; a false negative hides a command that can duplicate
 * money on a retry. That objective is NOT a guarantee or a proof of
 * completeness: this is a regex call graph, and the gaps listed above are where
 * it errs the other way.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Bucket = "IDENTITY_GUARDED" | "STATE_GUARDED" | "NON_ECONOMIC" | "RETIRED";

export interface SymbolRecord {
  id: string;
  file: string;
  name: string;
  kind: string;
  body: string;
  line: number;
}

/**
 * A row in one of these represents money posted, owed, held, paid or committed.
 * Writing one is an economic effect even when no journal row is produced in the
 * same call (blind spot 2).
 */
export const MONEY_TABLES: readonly string[] = [
  "accountingEvents", "journalEntries", "journalLines", "pendingAccountingEvents",
  "accountBalanceSnapshots",
  "receivables", "collectionPayments", "paymentAllocations", "canonicalPayments",
  "receiptApplications", "receiptMovements", "receiptRetainedPositions", "postDatedCheques",
  "deposits", "depositApplications",
  "vehicleSupplierPayables", "vehicleSupplierReceivables", "paymentVouchers",
  "supplierCostRecoveries", "supplierCostRecoveryReceipts",
  "payrollRuns", "payrollItems", "employeeAdvances", "employeeAdvanceRecoveries",
  "expenses", "prepaidExpenseSchedules", "prepaidScheduleCorrections",
  "fixedAssets", "fixedAssetEvents", "partnerEquity", "partnerEquityTransactions",
  "cashMovements", "cashDrawerSessions", "cashierReconciliations",
  "financeDealFees", "financeDealCustody", "financeDealCustodyEntries",
  "paymentIntents",
  "vehicleCostCorrections", "vehicleLandedCosts",
  "sales", "transactions",
  "manualJournalDrafts", "openingBalanceDrafts", "consignedSaleCorrections",
  "financeApplications",
];

const DECL =
  /^export\s+const\s+(\w+)\s*=|^const\s+(\w+)\s*=|^export\s+(?:async\s+)?function\s+(\w+)|^(?:async\s+)?function\s+(\w+)/;

const POSTING_CALL =
  /\b(hook[A-Z]\w*|post[A-Z]\w*|enqueuePending\w*|recordRetainedApplication|sealReceiptMovement|postOrEnqueue|postDomainEvent)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "_generated") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

export interface Graph {
  symbols: Map<string, SymbolRecord>;
  edges: Map<string, Set<string>>;
  rEdges: Map<string, Set<string>>;
  sinks: Set<string>;
}

/**
 * Blind spot 5. Returns `src` with every comment replaced by spaces, keeping
 * every newline (so line numbers match) and never fusing neighbours
 * (`foo/**\/bar` becomes `foo      bar`).
 *
 * It parses with TypeScript rather than scanning characters because a comment
 * marker is only a comment in code position: `//` inside a string, a template
 * text, or a regex literal (`/["']\/\//`) is not one, and a call inside a
 * `${...}` template expression is real code. Every token's leading trivia
 * (the gap between its full start and its real start) holds only whitespace and
 * comments, so those gaps are the complete set of comments in the file.
 * Used for EDGE EXTRACTION only; sinks and mint/post checks read raw bodies.
 */
export function stripComments(src: string): string {
  const sf = ts.createSourceFile("census.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chars = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  };
  const trivia = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      if (src[i] === "/" && src[i + 1] === "/") {
        let e = i;
        while (e < to && src[e] !== "\n" && src[e] !== "\r") e++;
        blank(i, e);
        i = e;
      } else if (src[i] === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        const e = close === -1 || close + 2 > to ? to : close + 2;
        blank(i, e);
        i = e;
      } else i++;
    }
  };
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    // A token is a leaf even when it has children: a JSDoc that ends the file is
    // attached to the EndOfFileToken as a child, which `kids.length === 0` missed.
    const isToken = node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken;
    const kids = isToken ? [] : node.getChildren(sf);
    if (kids.length === 0) {
      trivia(node.pos, node.getStart(sf));
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  return chars.join("");
}

const BUILDER_CALL =
  /\b(?:mutation|internalMutation|query|internalQuery|action|internalAction|httpAction)\b(?=\s*[(<])/g;

/**
 * Blind spot 6. The part of a declaration line that can hold a real callee:
 * for `const`/`let`, the comment-free text AFTER the first `=` (so a factory-built
 * hook, `const hookX = makeHook("X")`, keeps its edge to `makeHook`), with the
 * Convex builder calls blanked (`= mutation({` must not link every command to the
 * `mutation` wrapper symbol, blind spot 1). `function` declarations contribute
 * nothing: the WHOLE declaration line is unread, so a call in a parameter default
 * AND a call in a body that opens and closes on that same line
 * (`function f(ctx) { hookX(ctx); }`) both get no edge. Reading the line would
 * add the function's own signature types as noise. That omission is the KNOWN GAP
 * (b) of SCRUM-742, guarded by a tripwire test over convex/. Likewise the `let` alternative
 * below is currently UNREACHABLE: DECL only matches `const`, never `let`, so no
 * `let` declaration line ever arrives here (SCRUM-738 N3).
 */
function declarationEdgeText(codeLine: string): string {
  if (!/^(?:export\s+)?(?:const|let)\s/.test(codeLine)) return "";
  const eq = codeLine.indexOf("=");
  if (eq === -1) return "";
  return codeLine.slice(eq + 1).replace(BUILDER_CALL, (m) => " ".repeat(m.length));
}

/** Parses the convex tree into symbols and an import-resolved call graph. */
export function buildGraph(convexRoot: string): Graph {
  const symbols = new Map<string, SymbolRecord>();
  const perFile = new Map<string, Map<string, string>>();
  const importsOf = new Map<string, Map<string, string>>();
  const edgeText = new Map<string, string>();

  for (const file of walk(convexRoot)) {
    const rel = path.relative(convexRoot, file).replace(/\\/g, "/").replace(/\.ts$/, "");
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);
    // Comment-free twin of `lines`, same line count, for edge extraction only.
    const codeLines = stripComments(src).split(/\r?\n/);

    // Blind spot 1: edges resolve through real import statements, never by name.
    const imap = new Map<string, string>();
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      const spec = m[2];
      if (!spec.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.js$/, "");
      for (const piece of m[1].split(",")) {
        const t = piece.trim();
        if (!t) continue;
        const mm = t.match(/^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/);
        if (mm) imap.set(mm[2] || mm[1], target);
      }
    }
    importsOf.set(rel, imap);

    const starts: { name: string; i: number }[] = [];
    lines.forEach((l, i) => {
      const m = l.match(DECL);
      if (m) {
        const name = m[1] || m[2] || m[3] || m[4];
        if (name) starts.push({ name, i });
      }
    });

    const nameMap = new Map<string, string>();
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
      const body = lines.slice(s.i, end).join("\n");
      const head = lines.slice(s.i, Math.min(s.i + 3, end)).join("\n");
      let kind = "helper";
      if (/=\s*mutation\s*\(/.test(head)) kind = "publicMutation";
      else if (/=\s*internalMutation\s*\(/.test(head)) kind = "internalMutation";
      else if (/=\s*action\s*\(/.test(head)) kind = "publicAction";
      else if (/=\s*internalAction\s*\(/.test(head)) kind = "internalAction";
      else if (/=\s*(internalQuery|query)\s*\(/.test(head)) kind = "query";
      const id = `${rel}.${s.name}`;
      symbols.set(id, { id, file: rel, name: s.name, kind, body, line: s.i + 1 });
      edgeText.set(id, [declarationEdgeText(codeLines[s.i] ?? ""), ...codeLines.slice(s.i + 1, end)].join("\n"));
      nameMap.set(s.name, id);
    });
    perFile.set(rel, nameMap);
  }

  const edges = new Map<string, Set<string>>();
  const rEdges = new Map<string, Set<string>>();
  for (const id of symbols.keys()) {
    edges.set(id, new Set());
    rEdges.set(id, new Set());
  }
  const link = (a: string, b: string) => {
    if (!symbols.has(b) || a === b) return;
    edges.get(a)!.add(b);
    rEdges.get(b)!.add(a);
  };

  for (const s of symbols.values()) {
    const body = edgeText.get(s.id) ?? "";
    const local = perFile.get(s.file)!;
    const imap = importsOf.get(s.file)!;
    const names = new Set<string>();
    // A call may carry a type-argument list (`makeHook<T>(`); `a < b && c(` is
    // not one, because the `<...>` must close before the `(` with no parens inside.
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*\(/g)) names.add(m[1]);
    for (const m of body.matchAll(/\b(hook[A-Z]\w*)\b/g)) names.add(m[1]);
    for (const n of names) {
      if (local.has(n)) link(s.id, local.get(n)!);
      else if (imap.has(n)) {
        const tm = perFile.get(imap.get(n)!);
        if (tm?.has(n)) link(s.id, tm.get(n)!);
      }
    }
    // Blind spot 7: delegation through a Convex function reference.
    for (const target of functionReferenceTargets(body)) link(s.id, target);
  }

  return { symbols, edges, rEdges, sinks: findSinks(symbols) };
}

/**
 * Blind spot 7 (SCRUM-743). `ctx.runMutation(internal.m.f, …)`,
 * `ctx.scheduler.runAfter(0, internal.m.f, …)`, `runAt` and `runAction` reach
 * `m.f` through a FUNCTION REFERENCE, never a call expression, so the bare-call
 * edges above cannot see them. `internal.a.b.f` / `api.a.b.f` names module
 * `a/b`, export `f`. Every occurrence links, whatever wraps it — over-inclusive,
 * like the rest of this file. Comments are stripped first: a reference named
 * in prose is not a delegation (`accountingPeriods.lock` was a false positive
 * from exactly that).
 *
 * KNOWN GAP (SCRUM-742): references held in a variable, namespace/default
 * imports, re-exports and httpAction handlers are not resolved.
 */
const FUNCTION_REFERENCE = /\b(?:internal|api)\.((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*)/g;

export function functionReferenceTargets(body: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(body).matchAll(FUNCTION_REFERENCE)) {
    const parts = m[1].split(".");
    const name = parts.pop()!;
    out.push(`${parts.join("/")}.${name}`);
  }
  return out;
}

/**
 * A client-callable entrypoint. Public ACTIONS are included (SCRUM-743 ruling
 * A): an action is a public command that can delegate to a money-moving
 * internal mutation, and a retried action replays that delegation.
 */
export function isPublicEntrypoint(kind: string): boolean {
  return kind === "publicMutation" || kind === "publicAction";
}

/**
 * Blind spots 2 and 3. A sink writes a money-bearing table. `patch`/`replace`
 * carry a document id rather than a table name, so they are detected by the
 * function ALSO naming a money table in a typed id, a query or an insert —
 * deliberately over-inclusive, because the alternative is not seeing them.
 */
export function findSinks(symbols: Map<string, SymbolRecord>): Set<string> {
  const out = new Set<string>();
  for (const s of symbols.values()) {
    const inserts = MONEY_TABLES.some((t) =>
      new RegExp(`ctx\\.db\\.insert\\(\\s*["']${t}["']`).test(s.body)
    );
    if (inserts) {
      out.add(s.id);
      continue;
    }
    const mutates = /ctx\.db\.(patch|replace)\s*\(/.test(s.body);
    const namesMoney = MONEY_TABLES.some(
      (t) => new RegExp(`["']${t}["']`).test(s.body) || new RegExp(`Id<\\s*["']${t}["']\\s*>`).test(s.body)
    );
    if (mutates && namesMoney) out.add(s.id);
  }
  return out;
}

/** Forward: every public entrypoint from which a sink is reachable. */
export function censusForward(g: Graph): Set<string> {
  const out = new Set<string>();
  for (const s of g.symbols.values()) {
    if (!isPublicEntrypoint(s.kind)) continue;
    const seen = new Set([s.id]);
    const stack = [s.id];
    let hit = g.sinks.has(s.id);
    while (stack.length && !hit) {
      const cur = stack.pop()!;
      for (const n of g.edges.get(cur) ?? []) {
        if (seen.has(n)) continue;
        if (g.sinks.has(n)) { hit = true; break; }
        seen.add(n);
        stack.push(n);
      }
    }
    if (hit) out.add(s.id);
  }
  return out;
}

/** Reverse: every public entrypoint reachable from a sink over reversed edges. */
export function censusReverse(g: Graph): Set<string> {
  const seen = new Set(g.sinks);
  const q = [...g.sinks];
  while (q.length) {
    const cur = q.shift()!;
    for (const prev of g.rEdges.get(cur) ?? []) {
      if (!seen.has(prev)) { seen.add(prev); q.push(prev); }
    }
  }
  const out = new Set<string>();
  for (const id of seen) if (isPublicEntrypoint(g.symbols.get(id)?.kind ?? "")) out.add(id);
  return out;
}

/** Does this body mint a document id and then reference it near a posting call? */
export function mintsAndPostsLocally(body: string): boolean {
  const minted = [...body.matchAll(/const\s+(\w+)\s*=\s*await\s+ctx\.db\.insert\(/g)].map((m) => m[1]);
  if (!minted.length) return false;
  if (!new RegExp(POSTING_CALL.source).test(body)) return false;
  return minted.some((l) => [...body.matchAll(new RegExp(`(^|[^.\\w])${l}\\b`, "g"))].length > 1);
}

/**
 * Blind spot 4. Transitive: a command that delegates the mint-and-post to a
 * helper is the exact shape that hid `partnerEquity.add`.
 */
export function mintsAndPostsTransitively(g: Graph, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const s = g.symbols.get(id);
  if (!s) return false;
  if (mintsAndPostsLocally(s.body)) return true;
  for (const next of g.edges.get(id) ?? []) {
    if (mintsAndPostsTransitively(g, next, seen)) return true;
  }
  return false;
}

/** True when the command carries command-level identity via runWithIdempotency. */
export function hasCommandIdentity(body: string): boolean {
  return /economic:\s*true/.test(body);
}
