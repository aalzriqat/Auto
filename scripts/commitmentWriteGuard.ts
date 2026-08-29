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
export function findUnchokedWrites(source: string, file: string): UnchokedWrite[] {
  if (CHOKE_MODULES.has(file)) return [];

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

/** `file::field` counts, the stable shape the ratchet is pinned on. */
export function summarize(writes: UnchokedWrite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of writes) {
    const key = `${w.file}::${w.field}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
