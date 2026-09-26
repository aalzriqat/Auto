/**
 * Every access to the `secrets` context in a parsed GitHub workflow, found the
 * way GitHub evaluates expressions rather than by one spelling of them.
 *
 * GitHub accepts `secrets.NAME`, `secrets['NAME']` and `secrets["NAME"]`, in
 * any letter case, anywhere inside `${{ }}`, and in `if:` values without the
 * braces. A check for the text `secrets.CONVEX_` alone let the index form
 * through (Sol R4 on PR #341). Anything that is not a literal name — an
 * index computed at run time, or the whole context as in `toJSON(secrets)` —
 * is reported as dynamic, so a caller can fail closed on it.
 *
 * Where an expression ENDS is deliberately not decided here. A `}}` inside a
 * quoted string ended the span early, hiding `${{ format('a}}b', secrets.X) }}`
 * (Sonnet on PR #341), and matching GitHub's own lexer exactly is a bet on
 * rules this file cannot observe. So a string is scanned from its first `${{`
 * to its end: a superset of every span any terminator rule could produce.
 */

export type SecretReferences = { names: string[]; dynamic: boolean; inherits: boolean };

const SECRETS_TOKEN = /(^|[^A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/gi;
const PROPERTY = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)/;
const INDEX = /^\s*\[\s*(['"])([^'"]*)\1\s*\]/;

function scanExpression(expression: string, found: SecretReferences): void {
  for (const match of expression.matchAll(SECRETS_TOKEN)) {
    const rest = expression.slice((match.index ?? 0) + match[0].length);
    const name = PROPERTY.exec(rest)?.[1] ?? INDEX.exec(rest)?.[2];
    if (name) found.names.push(name.toUpperCase());
    else found.dynamic = true;
  }
}

function visit(value: unknown, key: string | undefined, found: SecretReferences): void {
  if (typeof value === "string") {
    // `if:` is an expression even without `${{ }}`.
    if (key === "if") scanExpression(value, found);
    else if (value.includes("${{")) scanExpression(value.slice(value.indexOf("${{") + 3), found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, undefined, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "secrets" && child === "inherit") found.inherits = true;
      visit(child, childKey, found);
    }
  }
}

export function secretReferences(value: unknown): SecretReferences {
  const found: SecretReferences = { names: [], dynamic: false, inherits: false };
  visit(value, undefined, found);
  return found;
}

/** Could this value hand a Convex credential to what it runs? Unknowable access counts as yes. */
export function referencesConvexSecret(value: unknown): boolean {
  const found = secretReferences(value);
  return found.dynamic || found.inherits || found.names.some((name) => name.startsWith("CONVEX_"));
}
