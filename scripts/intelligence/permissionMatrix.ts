import ts from "typescript";

/**
 * Tool-enumerated permission matrix (SCRUM-616, SCRUM-760 gate G6): for every
 * public Convex query / mutation / action, which guard calls appear in its OWN handler.
 * Read from the TypeScript syntax tree, never typed from memory. Pure: callers
 * pass file text in.
 *
 * Only the exported builder call's own subtree is inspected, so a neighbouring
 * export, an internal function or a comment can never lend it a guard. It proves a
 * guard call is PRESENT in the handler, not that it runs on every path (a guard in a
 * dead branch, a swallowed try, or after a write still counts), and a permission list
 * is not pinned: changing the keys keeps the class "permission". When several
 * requireTenantAuth calls exist their keys are merged, which can read as "needs all"
 * when either suffices.
 *
 *  - "permission": requireTenantAuth(ctx, org, <permissions>) — a literal list yields
 *                  PERMISSIONS keys, a named constant yields "$NAME"
 *  - "platform":   requireSuperAdmin / requireSupportAgent
 *  - "owner":      requireOwner / requireRealOwner (organization owner, not a cross-tenant role)
 *  - "member":     requireTenantAuth(ctx, org) with no permission argument, no PERMISSIONS reference
 *  - "inline":     requireTenantAuth(ctx, org) with no permission argument, but the handler reads
 *                  PERMISSIONS.X itself (the check is not proven by this scanner)
 *  - "authed":     requireAuth / requireOrCreateAuthenticatedUser only: any signed-in user of ANY org
 *  - "none":       no recognised guard. Not a defect by itself (public marketplace, stubs,
 *                  guards delegated to a helper); the allowlist records each on purpose.
 * Validation helpers (assertX, requireFeature, requireOwnedRow ...) are NOT guards.
 */

export type Guard = "permission" | "platform" | "owner" | "member" | "inline" | "authed" | "none";
export type Kind = "query" | "mutation" | "action";

export type FnGuard = {
  file: string;
  name: string;
  kind: Kind;
  guard: Guard;
  permissions: string[]; // PERMISSIONS keys, e.g. VIEW_LEADS, or "$CONSTANT"
};

/**
 * Public function builders and the kind each registers. `socialBulkMutation` is the
 * wrapper exported by convex/functions.ts (PR #512 NEW-1); the test fails if that file
 * ever exports another public builder that is not listed here.
 */
export const BUILDERS: Record<string, Kind> = { query: "query", mutation: "mutation", action: "action", socialBulkMutation: "mutation" };
const PLATFORM = new Set(["requireSuperAdmin", "requireSupportAgent"]);
const OWNER = new Set(["requireOwner", "requireRealOwner"]);
const AUTHED = new Set(["requireAuth", "requireOrCreateAuthenticatedUser"]);

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined;

function classify(node: ts.Node, sf: ts.SourceFile): { guard: Guard; permissions: string[] } {
  const permissions = new Set<string>();
  let permissionCall = false;
  let tenantCall = false;
  let platform = false;
  let owner = false;
  let authed = false;
  let inlinePermission = false;

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === "requireTenantAuth") {
        const arg = n.arguments[2];
        if (arg) {
          permissionCall = true;
          const keys: string[] = [];
          const collect = (x: ts.Node) => {
            if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "PERMISSIONS") keys.push(x.name.text);
            ts.forEachChild(x, collect);
          };
          collect(arg);
          if (keys.length > 0) keys.forEach((k) => permissions.add(k));
          else {
            const text = arg.getText(sf).trim();
            permissions.add(`$${text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).replace(/^\s*\.\.\./, "").trim() : text}`);
          }
        } else tenantCall = true;
      } else if (name && PLATFORM.has(name)) platform = true;
      else if (name && OWNER.has(name)) owner = true;
      else if (name && AUTHED.has(name)) authed = true;
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "PERMISSIONS") inlinePermission = true;
    ts.forEachChild(n, visit);
  };
  visit(node);

  const sorted = [...permissions].sort((a, b) => a.localeCompare(b));
  if (permissionCall) return { guard: "permission", permissions: sorted };
  if (platform) return { guard: "platform", permissions: [] };
  if (owner) return { guard: "owner", permissions: [] };
  if (tenantCall) return { guard: inlinePermission ? "inline" : "member", permissions: [] };
  if (authed) return { guard: "authed", permissions: [] };
  return { guard: "none", permissions: [] };
}

export function extractGuards(file: string, source: string): FnGuard[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: FnGuard[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(decl.name)) continue;
      const builder = calleeName(init);
      if (!builder || !(builder in BUILDERS)) continue;
      out.push({ file, name: decl.name.text, kind: BUILDERS[builder], ...classify(init, sf) });
    }
  }
  return out;
}

/** Stable id used by the allowlists and in findings. */
export const fnId = (g: Pick<FnGuard, "file" | "name">) => `${g.file}:${g.name}`;
