import ts from "typescript";

/**
 * Tool-enumerated permission matrix (SCRUM-616, SCRUM-760 gate G6): for every
 * public Convex query / mutation / action, which guard its OWN handler calls.
 * Read from the TypeScript syntax tree, never typed from memory. Pure: callers
 * pass file text in.
 *
 * Only the exported builder call's own subtree is inspected, so a neighbouring
 * export, an internal function or a comment can never lend it a guard.
 *
 *  - "permission": requireTenantAuth(ctx, org, <permissions>) — a literal list yields
 *                  PERMISSIONS keys, a named constant yields "$NAME"
 *  - "platform":   requireSuperAdmin / requireSupportAgent / requireOwner / requireRealOwner
 *  - "member":     requireTenantAuth(ctx, org) with no permission argument, no PERMISSIONS reference
 *  - "inline":     requireTenantAuth(ctx, org) with no permission argument, but the handler reads
 *                  PERMISSIONS.X itself (the check is not proven by this scanner)
 *  - "authed":     requireAuth / requireOrCreateAuthenticatedUser only: any signed-in user of ANY org
 *  - "none":       no recognised guard. Not a defect by itself (public marketplace, stubs,
 *                  guards delegated to a helper); the allowlist records each on purpose.
 * Validation helpers (assertX, requireFeature, requireOwnedRow ...) are NOT guards.
 */

export type Guard = "permission" | "platform" | "member" | "inline" | "authed" | "none";
export type Kind = "query" | "mutation" | "action";

export type FnGuard = {
  file: string;
  name: string;
  kind: Kind;
  guard: Guard;
  permissions: string[]; // PERMISSIONS keys, e.g. VIEW_LEADS, or "$CONSTANT"
};

const BUILDERS = new Set<string>(["query", "mutation", "action"]);
const PLATFORM = new Set(["requireSuperAdmin", "requireSupportAgent", "requireOwner", "requireRealOwner"]);
const AUTHED = new Set(["requireAuth", "requireOrCreateAuthenticatedUser"]);

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined;

function classify(node: ts.Node, sf: ts.SourceFile): { guard: Guard; permissions: string[] } {
  const permissions = new Set<string>();
  let permissionCall = false;
  let tenantCall = false;
  let platform = false;
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
          else permissions.add(`$${arg.getText(sf).replace(/^\[?\s*\.\.\./, "").replace(/\]$/, "").trim()}`);
        } else tenantCall = true;
      } else if (name && PLATFORM.has(name)) platform = true;
      else if (name && AUTHED.has(name)) authed = true;
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "PERMISSIONS") inlinePermission = true;
    ts.forEachChild(n, visit);
  };
  visit(node);

  const sorted = [...permissions].sort((a, b) => a.localeCompare(b));
  if (permissionCall) return { guard: "permission", permissions: sorted };
  if (platform) return { guard: "platform", permissions: [] };
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
      if (!builder || !BUILDERS.has(builder)) continue;
      out.push({ file, name: decl.name.text, kind: builder as Kind, ...classify(init, sf) });
    }
  }
  return out;
}

/** Stable id used by the allowlists and in findings. */
export const fnId = (g: Pick<FnGuard, "file" | "name">) => `${g.file}:${g.name}`;
