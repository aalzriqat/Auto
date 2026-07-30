/**
 * Static guard for the defect shape that produced two Criticals in the
 * 2026-07-29 architectural audit.
 *
 * The shape: a Convex mutation takes an `orgId` **and** a caller-supplied
 * document id, guards with `requireTenantAuth` / `requireOwner` — which only
 * prove the caller may act inside the org they named — and then patches or
 * deletes that id without ever proving the row belongs to that org. An
 * authenticated member of org A passes their own orgId and a foreign id, and
 * writes to org B's rows.
 *
 * Nothing else in the toolchain can see it. `orgCustomFields` and
 * `orgPipelineStages` shipped broken while three structurally identical sibling
 * modules were correct; TypeScript, ESLint, the test suite, and human review all
 * passed both. This analyzer is the only control that scales past fixing the two
 * known instances — it is what stops the sixth `org*` module from shipping the
 * same way.
 *
 * Deliberately a source-text analyzer rather than an ESLint rule: it has to run
 * in CI as a plain vitest assertion with no plugin packaging or eslint-config
 * wiring, and the shape is coarse enough that full type information buys nothing.
 * Precision comes from being narrow — see `findUnguardedTenantWrites` below for
 * exactly what it does and does not claim.
 */
import fs from "node:fs";
import path from "node:path";

export interface UnguardedWrite {
  /** Path relative to the convex root, POSIX separators. */
  file: string;
  /** Exported function name, e.g. "update". */
  functionName: string;
  /** "mutation" | "internalMutation" — internal ones are not client-reachable. */
  kind: string;
  /** The offending calls, e.g. `patch(args.fieldId)`. */
  writes: string[];
}

const WRITE_METHODS = ["patch", "delete", "replace"] as const;

/**
 * Proof that the row about to be written was tied back to the caller's org.
 *
 * `requireOwnedRow` is the sanctioned form. The two hand-written forms are
 * accepted because they are what the correct modules already used and are
 * exactly equivalent; `requireSuperAdmin` is accepted because the /admin surface
 * is cross-tenant by design.
 */
const PROOF_PATTERNS: RegExp[] = [
  /requireOwnedRow\s*\(/,
  /\.orgId\s*!==/,
  /\.orgId\s*===/,
  /requireSuperAdmin\s*\(/,
];

/** Reads the first argument expression of a call, starting just after its "(". */
function firstArgument(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source.slice(start, i);
      depth--;
    } else if (c === "," && depth === 0) return source.slice(start, i);
  }
  return "";
}

/**
 * Names that hold a caller-supplied document id inside this handler: the id
 * args themselves plus anything bound directly from one. Covers the three
 * binding forms the codebase actually uses — `const x = args.y`,
 * `const { y } = args`, and `for (const x of args.ys)` — plus direct
 * `args.ys[i]` indexing, which needs no binding at all.
 */
function taintedIdentifiers(chunk: string, idArgs: Set<string>): Set<string> {
  const tainted = new Set(idArgs);
  for (const m of chunk.matchAll(/const\s+(\w+)\s*=\s*args\.(\w+)/g)) {
    if (tainted.has(m[2])) tainted.add(m[1]);
  }
  for (const m of chunk.matchAll(/const\s*\{([^}]*)\}\s*=\s*args\b/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (idArgs.has(name)) tainted.add(name);
    }
  }
  for (const m of chunk.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+args\.(\w+)/g)) {
    if (tainted.has(m[2])) tainted.add(m[1]);
  }
  return tainted;
}

/**
 * The caller-supplied document-id arguments of an org-scoped handler, or null if
 * this is not one: no `args` block, no `orgId`, or no id arguments at all.
 */
function orgScopedIdArgs(chunk: string): Set<string> | null {
  const argsSource = chunk.match(/args:\s*\{([\s\S]*?)\n\s*handler:/)?.[1];
  if (!argsSource) return null;
  // `v.optional(...)` counts: an org-scoped handler is no less org-scoped for
  // taking the id optionally, and two live mutations are written that way.
  if (!/\borgId:\s*(v\.optional\()?v\.id\("organizations"\)/.test(argsSource)) return null;

  const idArgs = new Set<string>();
  for (const m of argsSource.matchAll(/(\w+):\s*[^,\n]*v\.id\("(\w+)"\)/g)) {
    if (m[1] !== "orgId") idArgs.add(m[1]);
  }
  return idArgs.size > 0 ? idArgs : null;
}

/**
 * Built once from a fixed method list, not from any caller input — the pattern
 * is effectively a literal.
 */
const WRITE_CALL = new RegExp(`ctx\\.db\\.(${WRITE_METHODS.join("|")})\\(`, "g");

/** `ctx.db.patch|delete|replace` calls whose id traces back to a tainted name. */
function collectTaintedWrites(chunk: string, tainted: Set<string>): string[] {
  const writes: string[] = [];
  for (const m of chunk.matchAll(WRITE_CALL)) {
    const argument = firstArgument(chunk, m.index! + m[0].length).trim();
    const root = argument.replace(/^args\./, "").match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (root && tainted.has(root)) writes.push(`${m[1]}(${argument})`);
  }
  return writes;
}

/**
 * Scans one Convex module's source for the shape.
 *
 * Scope, stated precisely so the result is not over-read:
 * - Only `mutation` / `internalMutation` exports. Queries cannot write, and the
 *   read-side half of the same defect is a different signature (entering a
 *   non-org-scoped index), not covered here.
 * - Only handlers whose `args` declare `orgId: v.id("organizations")` — that is
 *   what makes "the caller named an org but the row was never tied to it"
 *   meaningful.
 * - Only writes whose id traces to a `v.id(...)` argument. A write to an id the
 *   handler itself looked up is not caller-supplied and is out of scope.
 * - Proof is looked for anywhere in the same handler, not flow-sensitively. A
 *   handler that checks one id's ownership and writes a *different* unchecked id
 *   passes. That is a deliberate precision/recall trade: the alternative is
 *   false positives across ~220 correct sites, and this still catches the shape
 *   that actually shipped twice.
 */
export function findUnguardedTenantWrites(source: string, file: string): UnguardedWrite[] {
  const found: UnguardedWrite[] = [];
  // Top-level `export const` boundaries delimit one Convex function each.
  const chunks = source.split(/\nexport const /).slice(1);

  for (const raw of chunks) {
    const chunk = "export const " + raw;
    const functionName = raw.match(/^(\w+)/)?.[1];
    const kind = chunk.match(/=\s*(internalMutation|mutation)\(/)?.[1];
    if (!functionName || !kind) continue;

    const idArgs = orgScopedIdArgs(chunk);
    if (!idArgs) continue;

    const writes = collectTaintedWrites(chunk, taintedIdentifiers(chunk, idArgs));
    if (writes.length === 0) continue;

    if (PROOF_PATTERNS.some((p) => p.test(chunk))) continue;

    found.push({ file, functionName, kind, writes });
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

/** Runs the scan across the whole backend. */
export function auditConvexBackend(convexRoot: string): UnguardedWrite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findUnguardedTenantWrites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

/**
 * How much of the backend this analyzer actually looks at.
 *
 * The guard disables itself silently on any shape it cannot parse — args hoisted
 * into a shared validator const, or no inline `args` block — and says nothing.
 * That is the same failure mode the mobile contract check just had: a green
 * result meaning "nothing examined" is indistinguishable from "nothing wrong".
 * `scripts/tenantWriteGuard.test.ts` pins these numbers, so a refactor that
 * shrinks the analysed surface fails CI instead of passing quietly.
 *
 * KNOWN BLIND SPOT, deliberately recorded rather than papered over: only
 * `patch`/`delete`/`replace` are analysed. `ctx.db.insert` is not, because a
 * caller-supplied id reaches an insert as a *field value* rather than as the
 * call's subject. That is why the `test_drives.create` salesperson leak (audit
 * H-6) was invisible here for as long as it existed. User-reference args are
 * guarded by `requireOrgMember` at the call sites instead; extending this
 * analyzer to cover them is follow-up work, not something this file claims.
 */
export interface GuardCoverage {
  totalMutations: number;
  analysed: number;
  skippedNoArgsBlock: number;
  skippedNoOrgId: number;
}

export function summarizeCoverage(convexRoot: string): GuardCoverage {
  const coverage: GuardCoverage = {
    totalMutations: 0,
    analysed: 0,
    skippedNoArgsBlock: 0,
    skippedNoOrgId: 0,
  };

  for (const file of convexSourceFiles(convexRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const raw of source.split(/\nexport const /).slice(1)) {
      const chunk = "export const " + raw;
      if (!/=\s*(internalMutation|mutation)\(/.test(chunk)) continue;
      coverage.totalMutations++;

      const argsSource = chunk.match(/args:\s*\{([\s\S]*?)\n\s*handler:/)?.[1];
      if (!argsSource) {
        coverage.skippedNoArgsBlock++;
        continue;
      }
      if (/\borgId:\s*(v\.optional\()?v\.id\("organizations"\)/.test(argsSource)) {
        coverage.analysed++;
      } else {
        coverage.skippedNoOrgId++;
      }
    }
  }

  return coverage;
}
