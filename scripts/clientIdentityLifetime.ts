/**
 * The client-boundary identity census (SCRUM-313).
 *
 * The server census (`economicCommandCensus.ts`) proves the BACKEND requires an
 * identity. It says nothing about whether the client supplies a STABLE one, and
 * a required identity that the client regenerates per attempt is not a guard —
 * it is a slower way to post twice.
 *
 * Two lifetimes must hold at every caller, not one:
 *
 *   1. KEY LIFETIME — the idempotencyKey survives an unknown/lost response and
 *      is retired only on confirmed success (or an explicit new/cancelled
 *      intent). A key minted inside the submit call is minted per ATTEMPT.
 *
 *   2. CANONICAL-REQUEST LIFETIME — every FINGERPRINTED argument survives with
 *      it. This is the half that is easy to miss and it changes the failure
 *      rather than removing it: `expenses.create` fingerprints `date`, and the
 *      mobile caller sent `date: Date.now()`. Retaining only the key gives
 *          key A + date T1 -> unknown response
 *          key A + date T2 -> server correctly REFUSES as different content
 *      i.e. a silent double-post becomes a hard rejection the operator cannot
 *      clear. Freezing the key without freezing the snapshot is not a fix.
 *
 * Not every identity-guarded command has a UI caller. Server-only and
 * orchestrated paths are reported EXPLICITLY as such rather than being assumed
 * safe by absence — an unenumerated absence is not a finding.
 */
import fs from "node:fs";
import path from "node:path";

export type KeyLifetime =
  | "RETAINED"
  | "PER_ATTEMPT"
  | "LITERAL_OR_DERIVED"
  | "VIA_SPREAD"
  | "ABSENT";

export interface CallerFinding {
  command: string;
  file: string;
  line: number;
  keyLifetime: KeyLifetime;
  keyExpression: string;
  /** Fingerprinted args whose call-site expression is recomputed per attempt. */
  volatileFingerprintArgs: string[];
}

/** Expressions that produce a different value on every evaluation. */
const VOLATILE = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(|\bMath\.random\s*\(|\brandomUUID\s*\(/;

/** A key expression that CALLS something is minted at that moment. */
const MINTS_INLINE = /randomUUID\s*\(|idempotencyKey\s*\(|uuid\s*\(|nanoid\s*\(/;

/** A key read from a retained holder survives the attempt. */
const RETAINED = /\w*[Kk]eyRef\s*\.\s*current|\w*Ref\s*\.\s*current/;

/**
 * Commands that carry identity under a DIFFERENT argument name. Named
 * explicitly rather than weakening the check for everyone: `vehicles.importBulk`
 * identifies an upload with `importId`, reused for every chunk and every retry,
 * and the server refuses a purchase import outright without it.
 */
export const ALTERNATE_IDENTITY_ARG: Record<string, string> = {
  "vehicles.importBulk": "importId",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", "_generated", "dist", "build", ".expo"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Balanced-brace slice starting at the `{` at or after `from`. */
function objectAt(src: string, from: number): { text: string; end: number } | null {
  const brace = src.indexOf("{", from);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(brace, i + 1), end: i };
    }
  }
  return null;
}

/** Top-level `key: value` pairs of an object literal (nested objects skipped). */
function topLevelProps(objText: string): Map<string, string> {
  const out = new Map<string, string>();
  // Comments MUST be stripped before splitting on commas. A line comment
  // containing a comma ("a fresh identity per seeded vehicle, so repeated ...")
  // splits into fragments, and the fragment carrying `idempotencyKey:` then
  // parses with the comment tail glued onto its key — which reported
  // playwright/utils.ts as having NO identity when it plainly has one.
  const body = objText
    .slice(1, -1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const raw of parts) {
    const p = raw.trim();
    if (!p || p.startsWith("//")) continue;
    if (p.startsWith("...")) {
      // A spread may CARRY the identity (CollectionsTab builds a `common`
      // object holding the key). Record it so the caller is reported as
      // VIA_SPREAD — needing a human read — rather than as ABSENT, which would
      // be a fabricated finding.
      out.set("...spread", p);
      continue;
    }
    const colon = p.indexOf(":");
    if (colon === -1) {
      const m = p.match(/^(\w+)$/); // shorthand
      if (m) out.set(m[1], m[1]);
      continue;
    }
    out.set(p.slice(0, colon).trim(), p.slice(colon + 1).trim());
  }
  return out;
}

/** Extracts the fingerprinted ARG NAMES for each identity-guarded command. */
export function serverFingerprints(convexRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of walk(convexRoot)) {
    const src = fs.readFileSync(file, "utf8");
    const mod = path.relative(convexRoot, file).replace(/\\/g, "/").replace(/\.ts$/, "");
    for (const m of src.matchAll(/operation:\s*["']([\w.]+)["']/g)) {
      const command = m[1];
      const fpAt = src.indexOf("fingerprint:", m.index!);
      if (fpAt === -1) continue;
      const obj = objectAt(src, fpAt);
      if (!obj) continue;
      const args = new Set<string>();
      for (const a of obj.text.matchAll(/\bargs\.(\w+)/g)) args.add(a[1]);
      // Fields whose VALUE is a local (e.g. `status`, `paymentMethod` resolved
      // above) still derive from the request; record the field name too, since
      // the client sends it under that name.
      for (const [k] of topLevelProps(obj.text)) args.add(k);
      // Explicit comparator: a bare `.sort()` orders by UTF-16 code unit, not
      // alphabetically, so the ordering these names are compared and reported in
      // would not be the one it appears to be (Sonar typescript:S2871).
      out.set(command, [...args].sort((a, b) => a.localeCompare(b)));
      void mod;
    }
  }
  return out;
}

/** Every client call site of an identity-guarded command. */
export function auditClientCallers(
  repoRoot: string,
  identityGuarded: readonly string[],
  fingerprints: Map<string, string[]>
): { findings: CallerFinding[]; commandsWithNoClientCaller: string[] } {
  const roots = ["components", "app", "hooks", "lib", "apps/mobile/src", "playwright", "cypress"];
  const files: string[] = [];
  for (const r of roots) walk(path.join(repoRoot, r), files);

  const findings: CallerFinding[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("api.")) continue;
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");

    // local variable -> api path, via useMutation(api.a.b)
    const varToCommand = new Map<string, string>();
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*useMutation\(\s*api\.([\w.]+)\s*\)/g)) {
      varToCommand.set(m[1], m[2]);
    }

    const sites: { command: string; at: number }[] = [];
    for (const [v, command] of varToCommand) {
      for (const m of src.matchAll(new RegExp(`\\b${v}\\s*\\(`, "g"))) {
        sites.push({ command, at: m.index! + m[0].length - 1 });
      }
    }
    // direct form: client.mutation(api.a.b, { ... })
    for (const m of src.matchAll(/\.mutation\(\s*api\.([\w.]+)\s*,/g)) {
      sites.push({ command: m[1], at: m.index! + m[0].length });
    }

    for (const site of sites) {
      if (!identityGuarded.includes(site.command)) continue;
      const obj = objectAt(src, site.at);
      if (!obj) continue;
      const props = topLevelProps(obj.text);
      const altArg = ALTERNATE_IDENTITY_ARG[site.command];
      const keyExpr = props.get("idempotencyKey") ?? (altArg ? props.get(altArg) : undefined);
      const line = src.slice(0, site.at).split(/\r?\n/).length;
      const id = `${rel}:${line}:${site.command}`;
      if (seen.has(id)) continue;
      seen.add(id);

      let keyLifetime: KeyLifetime;
      if (!keyExpr && props.has("...spread")) keyLifetime = "VIA_SPREAD";
      else if (!keyExpr) keyLifetime = "ABSENT";
      else if (RETAINED.test(keyExpr)) keyLifetime = "RETAINED";
      else if (MINTS_INLINE.test(keyExpr)) keyLifetime = "PER_ATTEMPT";
      else keyLifetime = "LITERAL_OR_DERIVED";

      const fpArgs = fingerprints.get(site.command) ?? [];
      const volatileFingerprintArgs: string[] = [];
      for (const [k, v] of props) {
        if (k === "idempotencyKey") continue;
        if (!fpArgs.includes(k)) continue;
        if (VOLATILE.test(v)) volatileFingerprintArgs.push(k);
      }

      findings.push({
        command: site.command,
        file: rel,
        line,
        keyLifetime,
        keyExpression: (keyExpr ?? "<absent>").replace(/\s+/g, " ").slice(0, 60),
        volatileFingerprintArgs,
      });
    }
  }

  const called = new Set(findings.map((f) => f.command));
  // Explicit comparator — see the note in `serverFingerprints`. This list is
  // asserted verbatim by the ratchet, so its order must be the stated one.
  const commandsWithNoClientCaller = identityGuarded
    .filter((c) => !called.has(c))
    .sort((a, b) => a.localeCompare(b));
  return { findings, commandsWithNoClientCaller };
}

/** A caller is unsafe if either lifetime is broken. */
export function isUnsafe(f: CallerFinding): boolean {
  return f.keyLifetime === "PER_ATTEMPT" || f.keyLifetime === "ABSENT" || f.volatileFingerprintArgs.length > 0;
}

/** VIA_SPREAD cannot be decided mechanically and must be read by a human. */
export function needsManualRead(f: CallerFinding): boolean {
  return f.keyLifetime === "VIA_SPREAD";
}
