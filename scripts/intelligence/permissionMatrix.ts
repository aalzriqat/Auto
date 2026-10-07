/**
 * Tool-enumerated permission matrix (SCRUM-616, SCRUM-760 gate G6): for every
 * public Convex query/mutation, which guard its source calls. Read from the
 * source, never typed from memory, so a reviewer can trust the list is complete
 * for the exports it can see. Pure: callers pass file text in.
 *
 * Classification is by what the handler's own text contains:
 *  - "permission": requireTenantAuth(ctx, org, <permissions>) — gated; a literal list yields PERMISSIONS keys, a named constant yields "$NAME"
 *  - "member":     requireTenantAuth(ctx, org) with no permission argument and no PERMISSIONS reference — any active member
 *  - "inline":     requireTenantAuth(ctx, org) with no permission argument, but the function names PERMISSIONS.X itself (checked by hand; verify)
 *  - "other":      another requireX / assertX guard but no requireTenantAuth
 *  - "none":       no recognisable guard in the function text
 * "none" is NOT a defect by itself (public marketplace reads, webhooks); the
 * checked-in allowlist records each one on purpose and may only shrink.
 */

export type Guard = "permission" | "member" | "inline" | "other" | "none";

export type FnGuard = {
  file: string;
  name: string;
  kind: "query" | "mutation";
  guard: Guard;
  permissions: string[]; // PERMISSIONS keys, e.g. VIEW_LEADS
};

const EXPORT_RE = /export const (\w+)\s*=\s*(query|mutation)\(/g;

/** Split a call's argument text on commas that are not inside brackets/parens/braces. */
function topLevelArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function extractGuards(file: string, source: string): FnGuard[] {
  const starts = [...source.matchAll(EXPORT_RE)];
  return starts.map((m, i) => {
    const body = source.slice(m.index ?? 0, i + 1 < starts.length ? starts[i + 1].index : source.length);
    const calls = [...body.matchAll(/requireTenantAuth\(([^;]*?)\);/gs)];
    const withPerms = calls.filter((c) => topLevelArgs(c[1]).length >= 3);
    const permissions = [
      ...new Set(
        withPerms.flatMap((c) => {
          const arg = topLevelArgs(c[1])[2];
          const keys = [...arg.matchAll(/PERMISSIONS\.(\w+)/g)].map((p) => p[1]);
          return keys.length > 0 ? keys : [`$${arg.replace(/^\[?\.\.\./, "").replace(/\]$/, "").trim()}`];
        }),
      ),
    ].sort();
    const guard: Guard =
      withPerms.length > 0
        ? "permission"
        : calls.length > 0
          ? /PERMISSIONS\./.test(body)
            ? "inline"
            : "member"
          : /\b(require|assert)[A-Z]\w*\(/.test(body)
            ? "other"
            : "none";
    return { file, name: m[1], kind: m[2] as "query" | "mutation", guard, permissions };
  });
}

/** Stable id used by the allowlist and in findings. */
export const fnId = (g: Pick<FnGuard, "file" | "name">) => `${g.file}:${g.name}`;
