/**
 * SCRUM-883. Skip only known frontend/documentation inputs. Unknown paths run.
 * The staged backend includes convex/, lib/, packages/shared/src/ and the
 * dependency/configuration surface in intelligence/stageCandidateBackend.mjs.
 * Everything else (including harness helpers and both workflows) runs unless
 * explicitly excluded here. This module performs no I/O or candidate execution.
 */
const NON_BACKEND_PREFIXES = [
  "app/", "components/", "hooks/", "contexts/", "providers/", "public/",
  "styles/", "messages/", "locales/", "docs/", "scripts/contractSkew/",
];

/** @param {{paths: unknown, complete: boolean}} evidence */
export function accountingRehearsalPathGate({ paths, complete }) {
  if (complete !== true || !Array.isArray(paths) || paths.length === 0) {
    return { run: true, reason: "Changed-file evidence unavailable, empty or incomplete" };
  }
  for (const path of paths) {
    if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split("/").some(part => !part || part === "." || part === "..")) {
      return { run: true, reason: "Ambiguous changed path" };
    }
    if (!NON_BACKEND_PREFIXES.some(prefix => path.startsWith(prefix)) &&
        !/^[^/]+\.md$/.test(path)) {
      return { run: true, reason: "Backend or unknown input changed" };
    }
  }
  return { run: false, reason: "NOT_APPLICABLE: no backend input changed" };
}
