/**
 * SCRUM-208 — static guard for writes to commitment liveness fields made
 * outside the writer choke.
 *
 * ## The shape
 *
 * A module that is not the deposit or commitment authority reaches in and
 * patches a liveness flag directly — `ctx.db.patch(reservation.depositId,
 * { holdActive: false })` from `vehicles.ts`, which is what three live sites
 * did until this guard was written. Nothing else in the toolchain can see it:
 * it typechecks, it lints, and it is individually correct at each site. What
 * it is not is *cascaded*, and a stale `holdActive: true` leaves a vehicle
 * STUCK OPEN with nobody holding it and no operator door able to release it.
 *
 * ## Why it is not a copy of `tenantWriteGuard`
 *
 * That guard records a deliberate blind spot: *"only `patch`/`delete`/`replace`
 * are analysed. `ctx.db.insert` is not"* — which is why the `test_drives.create`
 * salesperson leak was invisible to it for as long as it existed.
 *
 * For this defect class an insert-blind guard would be worthless, because
 * **liveness is born at insert**: `depositVehicleHolds` rows are inserted
 * `active: true`, deposits are created `holdActive: true`, and reservations
 * are inserted ACTIVE. A patch-only guard would miss every birth of a live
 * hold and still report green. So `insert` is analysed here, by table name as
 * well as by field.
 *
 * ## What it claims, precisely
 *
 * - It flags `ctx.db.insert` / `patch` / `replace` whose object literal names
 *   a guarded field, and inserts into a guarded table, in any convex module
 *   outside `CHOKE_MODULES`.
 * - It does NOT resolve types. A `patch` whose object names no guarded field
 *   is invisible to it — see the recorded blind spot below.
 * - It is not flow-sensitive and makes no claim about reachability.
 *
 * ## ⚠️ RECORDED BLIND SPOT
 *
 * `depositVehicleHolds.active` and `deposits.status` cannot be distinguished
 * from any other table's `active`/`status` in a `patch`, because the target
 * table is only known from the id's type and this is a source-text analyzer.
 * Inserts into those tables ARE caught (the table name is a literal); patches
 * are caught only when the same object also names a guarded field.
 *
 * Recording it rather than papering over it, for the same reason
 * `tenantWriteGuard` records its own: a green result that means "nothing
 * examined" is indistinguishable from "nothing wrong".
 *
 * ## ⚠️ SECOND RECORDED BLIND SPOT — string literals are NOT blanked
 *
 * Comments are blanked before analysis; string literals deliberately are not,
 * because the table name in `insert("commitmentRoots", …)` IS a string literal
 * and blanking strings would disable table detection entirely. A string whose
 * CONTENTS spell out a guarded write therefore reports a false positive.
 *
 * That direction is the safe one — it fails loud and a human deletes the
 * offending prose — and it is why the rule is documented in comments, which
 * are blanked, rather than in string constants.
 */
import fs from "node:fs";
import path from "node:path";

export interface UnchokedWrite {
  /** Path relative to the convex root, POSIX separators. */
  file: string;
  method: "insert" | "patch" | "replace";
  /** The guarded field written, or `insert:<table>` for a guarded insert. */
  field: string;
}

/**
 * Fields whose names are distinctive enough to identify their table from the
 * source text alone. A generic `active:` or `status:` is deliberately absent —
 * matching those would flag every unrelated table in the backend.
 */
export const GUARDED_FIELDS = [
  "holdActive",
  "usesVehicleHoldRows",
  "singleVehicleCommitmentClaimId",
  "currentCommitmentClaimId",
  "currentCommitmentClaims",
  "lineageRootId",
  "lineageGeneration",
  "restoredFromRootId",
  "commitmentAuthorityVersion",
] as const;

/** Tables whose every row is a commitment fact. Any insert is a liveness write. */
export const GUARDED_INSERT_TABLES = [
  "depositVehicleHolds",
  "commitmentRoots",
  "vehicleCommitmentClaims",
] as const;

/**
 * The modules allowed to write these fields.
 *
 * `commitments.ts` is already a single-module choke for roots and claims and
 * has never drifted — it is the model the deposit fields lack, not an
 * exception to the rule.
 */
export const CHOKE_MODULES = new Set([
  "commitments.ts",
  "utils/commitmentWriters.ts",
  "utils/commitmentKernel.ts",
]);

/**
 * Blanks out comments, preserving every byte offset and line break.
 *
 * ⚠️ WITHOUT THIS THE ANALYZERS READ PROSE AS CODE. A doc comment that
 * mentions `ctx.db.insert("commitmentRoots", …)` — as the one on `RootOpening`
 * legitimately does, explaining why a second insert is forbidden — was counted
 * as a real insert site. Documenting the rule would have broken the check that
 * enforces it.
 *
 * Replacement rather than deletion so every reported offset still lines up
 * with the original source, and quote-aware so a `//` inside a string literal
 * (a URL, a refusal message) is not mistaken for a comment.
 */
export function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      if (i + 1 < source.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Reads a balanced `{...}` literal starting at `open`, or "" if unbalanced. */
function objectLiteral(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

const WRITE_CALL = /ctx\.db\.(insert|patch|replace)\(/g;

/** Scans one module's source for writes outside the choke. */
export function findUnchokedWrites(rawSource: string, file: string): UnchokedWrite[] {
  if (CHOKE_MODULES.has(file)) return [];

  const source = blankComments(rawSource);
  const found: UnchokedWrite[] = [];
  for (const m of source.matchAll(WRITE_CALL)) {
    const method = m[1] as UnchokedWrite["method"];
    const afterOpen = m.index! + m[0].length;

    if (method === "insert") {
      const table = source.slice(afterOpen).match(/^\s*"(\w+)"/)?.[1];
      if (table && (GUARDED_INSERT_TABLES as readonly string[]).includes(table)) {
        found.push({ file, method, field: `insert:${table}` });
        continue;
      }
    }

    const brace = source.indexOf("{", afterOpen);
    if (brace === -1) continue;
    // Only an object literal that starts within this call's own argument list.
    // A `{` several statements away belongs to something else entirely.
    if (source.slice(afterOpen, brace).includes(";")) continue;

    const literal = objectLiteral(source, brace);
    if (!literal) continue;

    for (const field of GUARDED_FIELDS) {
      if (new RegExp(`(^|[{,\\s])${field}\\s*:`).test(literal)) {
        found.push({ file, method, field });
      }
    }
  }
  return found;
}

/** Every non-generated, non-test `.ts` module under `convexRoot`. */
export function convexSourceFiles(convexRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "_generated") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(convexRoot);
  return out;
}

export function auditCommitmentWrites(convexRoot: string): UnchokedWrite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findUnchokedWrites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

export interface RootInsertSite {
  file: string;
  /** The function the insert is lexically inside. */
  enclosingFunction: string;
}

/**
 * SCRUM-208 — WHERE ROOTS ARE CREATED.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FIELD GUARD ABOVE COULD NOT SEE THE DEFECT.
 * `CHOKE_MODULES` exempts `commitments.ts` wholesale, so a second — or third —
 * `ctx.db.insert("commitmentRoots", …)` inside that very file passes the field
 * guard automatically. That is not hypothetical: the first version of the
 * Phase-3 succession work added exactly such an insert in `openSuccessorRoot`,
 * and this analyzer was green throughout.
 *
 * Module-level exemption is the right granularity for "who may write this
 * field" and the WRONG granularity for "how many places may create a root".
 * The root-creation invariant (M1: one place decides, one place opens) needs a
 * check that counts SITES, and that deliberately ignores the choke list.
 */
export function findRootInsertSites(rawSource: string, file: string): RootInsertSite[] {
  const source = blankComments(rawSource);
  const sites: RootInsertSite[] = [];
  for (const m of source.matchAll(/ctx\.db\.insert\(\s*"commitmentRoots"/g)) {
    const before = source.slice(0, m.index!);
    const declarations = [
      ...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g),
    ];
    const last = declarations[declarations.length - 1];
    sites.push({
      file,
      enclosingFunction: last ? (last[1] ?? last[2]) : "<top level>",
    });
  }
  return sites;
}

/**
 * SCRUM-208 — WHO CAN ASK FOR A SUCCESSOR ROOT.
 *
 * ⚠️ A COMMENT IS NOT AN ENFORCEMENT BOUNDARY. A first correction moved
 * succession out of its own writer and into an optional `successorOf`
 * parameter on the EXPORTED `acquireVehicle`, documented as "only
 * `restoreCommitment` supplies this". Any backend caller could still have
 * passed a terminal root with unrelated evidence and reached successor
 * creation without ever going through the restoration resolver.
 *
 * Module privacy is the boundary. This check pins it: the successor opening
 * shape may only be constructed inside the unexported executor, and the
 * executor may not be exported.
 */
export interface SuccessorTopology {
  /**
   * Enclosing function of every `opening: { … }` argument construction — the
   * shape actually handed to the private `openRoot`.
   *
   * Deliberately NOT every `kind: "SUCCESSOR"` token: the discriminated-union
   * TYPE declaration and the executor's internal `target` descriptor both use
   * that literal without opening anything, and counting them would make the
   * check fire on declarations rather than on writes.
   */
  openingSites: string[];
  /** Names of any exported function taking a caller-supplied successor root. */
  exportedSuccessorParams: string[];
}

export function analyzeSuccessorTopology(rawSource: string): SuccessorTopology {
  const source = blankComments(rawSource);
  const openingSites: string[] = [];
  for (const m of source.matchAll(/opening:\s*\{/g)) {
    const before = source.slice(0, m.index!);
    const declarations = [
      ...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g),
    ];
    const last = declarations[declarations.length - 1];
    openingSites.push(last ? (last[1] ?? last[2]) : "<top level>");
  }

  const exportedSuccessorParams: string[] = [];
  for (const m of source.matchAll(
    /export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\n\)/g
  )) {
    if (/successorOf\s*\??\s*:/.test(m[2])) exportedSuccessorParams.push(m[1]);
  }
  return { openingSites, exportedSuccessorParams };
}

export function auditRootInserts(convexRoot: string): RootInsertSite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findRootInsertSites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

/** `file::field` counts, the stable shape the ratchet is pinned on. */
export function summarize(writes: UnchokedWrite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of writes) {
    const key = `${w.file}::${w.field}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
