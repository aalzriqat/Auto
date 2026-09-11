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
 * ── Four blind spots this analyzer has already had, each of which produced a
 * WRONG census before it was caught. All four are pinned as regression tests in
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
 * Bias is deliberately OVER-INCLUSIVE throughout. A false positive costs one
 * explicit classification; a false negative hides a command that can duplicate
 * money on a retry.
 */
import fs from "node:fs";
import path from "node:path";

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

/** Parses the convex tree into symbols and an import-resolved call graph. */
export function buildGraph(convexRoot: string): Graph {
  const symbols = new Map<string, SymbolRecord>();
  const perFile = new Map<string, Map<string, string>>();
  const importsOf = new Map<string, Map<string, string>>();

  for (const file of walk(convexRoot)) {
    const rel = path.relative(convexRoot, file).replace(/\\/g, "/").replace(/\.ts$/, "");
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);

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
    const body = s.body.split("\n").slice(1).join("\n");
    const local = perFile.get(s.file)!;
    const imap = importsOf.get(s.file)!;
    const names = new Set<string>();
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) names.add(m[1]);
    for (const m of body.matchAll(/\b(hook[A-Z]\w*)\b/g)) names.add(m[1]);
    for (const n of names) {
      if (local.has(n)) link(s.id, local.get(n)!);
      else if (imap.has(n)) {
        const tm = perFile.get(imap.get(n)!);
        if (tm?.has(n)) link(s.id, tm.get(n)!);
      }
    }
  }

  return { symbols, edges, rEdges, sinks: findSinks(symbols) };
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

/** Forward: every public mutation from which a sink is reachable. */
export function censusForward(g: Graph): Set<string> {
  const out = new Set<string>();
  for (const s of g.symbols.values()) {
    if (s.kind !== "publicMutation") continue;
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

/** Reverse: every public mutation reachable from a sink over reversed edges. */
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
  for (const id of seen) if (g.symbols.get(id)?.kind === "publicMutation") out.add(id);
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
