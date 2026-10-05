/**
 * Source analyser behind `convex/economicsRevisionGuard.test.ts` (SCRUM-703).
 *
 * `registerVehicleHandover` refuses a confirmation whose `economicsStamp` no
 * longer matches the deal, and that stamp is `economicsRevision` and nothing
 * else. So the guarantee holds only while every write that moves the deal's
 * economics also ADVANCES the counter. A forgotten bump fails OPEN: the stamp
 * keeps comparing equal and a confirmation taken against figures that have
 * since changed seals anyway.
 *
 * This is a source scan, a change-control ratchet, not a proof. It lives here
 * rather than in `convex/` because it needs `node:fs`, and the convex-lint hook
 * treats everything under `convex/` as Convex runtime code. The real guarantee
 * is the behavioural stale-stamp tests; this only stops the obvious regressions.
 *
 * Known limits, pinned by `economicsRevisionAnalyzer.test.ts` so they are
 * decisions rather than accidents: it follows ONE level of local object literal
 * through a spread, and cannot see a payload built elsewhere.
 */
import fs from "node:fs";
import path from "node:path";

export const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

/**
 * The figures a handover confirmation is about. A write that moves any of them
 * invalidates a confirmation an operator is holding.
 */
export const ECONOMICS_FIELDS = [
  "approvedDealerPurchaseAmountMinor",
  "financeCompanyFundedPortionMinor",
  "dealerContributionMinor",
  "unfinancedPortionMinor",
  // The funding split is recomputed from the customer's first payment, so a
  // confirmation depends on it as much as on the approved amount.
  "customerFirstPaymentMinor",
  // Nested inside `manualApproval`; moved post-handover by the manual approval.
  "dealerSendsMinor",
];

export type Offence = { file: string; snippet: string };

/**
 * The write primitives that can move a stored field. `replace` appears nowhere
 * in the backend today; it is scanned anyway because omitting it costs the whole
 * guarantee the first time somebody reaches for it.
 */
const WRITE_PRIMITIVES = ["ctx.db.patch(", "ctx.db.replace("];

/**
 * Every write payload in the source, as text. Brace-matched rather than
 * regex-terminated: payloads contain nested objects and spreads, and a pattern
 * that stopped at the first `}` would read half a patch.
 */
export function patchPayloads(source: string): string[] {
  const payloads: string[] = [];
  for (const marker of WRITE_PRIMITIVES) {
    let cursor = source.indexOf(marker);
    while (cursor !== -1) {
      const open = source.indexOf("{", cursor);
      if (open === -1) break;
      const payload = objectLiteralFrom(source, open);
      payloads.push(payload);
      cursor = source.indexOf(marker, open + payload.length);
    }
  }
  return payloads;
}

function objectLiteralFrom(source: string, open: number): string {
  let depth = 0;
  for (let end = open; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}" && --depth === 0) return source.slice(open, end + 1);
  }
  return source.slice(open);
}

/**
 * Every backend source file under `convex/`, at any depth. RECURSIVE: a
 * non-recursive walk clears a nested writer without ever opening it.
 */
export function backendSourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    // `_generated` is codegen: scanning it would fail this on a regenerated API
    // rather than on a defect.
    if (entry.isDirectory()) return entry.name === "_generated" ? [] : backendSourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/**
 * A patch WRITES a figure when the field appears as a key, in shorthand, or via
 * a spread of a local literal that does. A patch that merely READS one into a
 * different key (`...ApprovedAtRecordingMinor: app.approvedDealerPurchaseAmountMinor`)
 * is copying evidence, not moving the deal.
 */
export function movesEconomics(payload: string, source = ""): boolean {
  const keyed = ECONOMICS_FIELDS.some((field) =>
    new RegExp(`(^|[\\s{,])${field}\\s*:`, "m").test(payload)
  );
  const shorthand = ECONOMICS_FIELDS.some((field) =>
    new RegExp(`[{,]\\s*${field}\\s*(?=[,}])`).test(payload)
  );
  return keyed || shorthand || spreadsLocalEconomicsLiteral(payload, source);
}

/**
 * `{ ...delta }` where `delta` is an object literal declared in the same file
 * that itself moves a figure. One level of data flow, deliberately.
 */
function spreadsLocalEconomicsLiteral(payload: string, source: string): boolean {
  for (const m of payload.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[.(])/g)) {
    const decl = new RegExp(`(?:const|let)\\s+${m[1]}\\b[^=]*=\\s*\\{`).exec(source);
    if (!decl) continue;
    if (movesEconomics(objectLiteralFrom(source, decl.index + decl[0].length - 1))) return true;
  }
  return false;
}

/**
 * The bump must ADVANCE the counter. Presence of the key is not enough:
 * `economicsRevision: app.economicsRevision` leaves a held confirmation
 * comparing equal, and `economicsRevision: 0` rewinds it onto an old stamp.
 */
export function bumpsRevision(payload: string): boolean {
  return /economicsRevision\s*:\s*\(?[^,}]*\beconomicsRevision\b[^,}]*\+\s*1\b/.test(payload);
}

export function findUnbumpedEconomicsWrites(source: string, file: string, snippetLength = 160): Offence[] {
  return patchPayloads(source)
    .filter((payload) => movesEconomics(payload, source) && !bumpsRevision(payload))
    .map((payload) => ({ file, snippet: payload.slice(0, snippetLength) }));
}

/**
 * Writes the scan flags that a human has reviewed. Every entry is a DECISION:
 * it names the file, a fragment that identifies the one payload, and why the
 * missing in-payload bump is acceptable (or tracked). An entry that no longer
 * matches anything must be deleted — `staleExceptions` makes CI say so — so the
 * list cannot quietly outlive the code it excuses.
 */
export const REVIEWED_EXCEPTIONS: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: "financingEconomics.ts",
    contains: 'resolveDealCurrency(ctx, app, "recording this quotation")',
    reason:
      "recordSubmittedQuotation delegates the bump: it calls recomputeAndPatchEconomics in the same transaction, and that recompute advances economicsRevision on BOTH of its branches. Pinned behaviourally in financingEconomics.test.ts (SCRUM-703).",
  },
  {
    file: "applications.ts",
    contains: "app.customerFirstPaymentMinor === undefined",
    reason:
      "KNOWN OPEN DEFECT, SCRUM-394: repairQuoteEconomicsLineage fills an unknown first payment without bumping economicsRevision or recomputing the split. Excused here only so the ratchet stays green while the fix goes through the invariant-first financial path; remove this entry in that fix.",
  },
];

const isReviewed = (o: Offence) =>
  REVIEWED_EXCEPTIONS.some((e) => o.file === e.file && o.snippet.includes(e.contains));

/** Scan every handwritten backend file; paths are relative to `convex/`. */
export function scanBackendForUnbumpedEconomicsWrites(root = CONVEX_ROOT): Offence[] {
  return scanAll(root).filter((o) => !isReviewed(o));
}

/** Exceptions that excuse nothing any more. Must be empty. */
export function staleExceptions(root = CONVEX_ROOT): string[] {
  const all = scanAll(root);
  return REVIEWED_EXCEPTIONS.filter((e) => !all.some((o) => o.file === e.file && o.snippet.includes(e.contains))).map(
    (e) => `${e.file}: ${e.contains}`
  );
}

function scanAll(root: string): Offence[] {
  return backendSourceFiles(root).flatMap((file) =>
    findUnbumpedEconomicsWrites(fs.readFileSync(file, "utf8"), path.relative(root, file), 4000)
  );
}
