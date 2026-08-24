/**
 * Rebasing the mobile LCOV's `SF:` paths onto the repository root.
 *
 * jest writes `SF:` paths relative to its own `rootDir`, which is `apps/mobile`
 * — so the mobile report says `SF:app/_layout.tsx`. Sonar resolves coverage
 * paths against the PROJECT base directory, the repository root, where no `app/`
 * of that shape exists. Left alone the whole mobile report resolves to nothing,
 * and it does so SILENTLY: the scan still succeeds, the files just stay
 * uncovered, which is indistinguishable from having no tests. The Convex report
 * needs none of this — vitest already runs at the repository root.
 *
 * ⚠️ This was `sed -i 's|^SF:|SF:apps/mobile/|'` inline in the workflow. That is
 * correct for the paths jest actually emits today and wrong for everything else
 * (SCRUM-185 review): an absolute path gets a prefix glued in front of it, an
 * already-rebased path gets a second prefix, and running it twice produces
 * `apps/mobile/apps/mobile/...`. Nothing re-runs it today, so the defect was
 * latent — but "latent" is a property of the current workflow, not of the
 * rewrite, and the next person to add a retry around it inherits a silent
 * coverage loss. So the rules are explicit here, and tested.
 *
 * Traversal is allowed when it stays inside the repository and refused when it
 * does not. `../../packages/shared/src/index.ts` is a real path jest can emit
 * for a workspace import: joined and normalised it becomes
 * `packages/shared/src/index.ts`, which is a genuine repository file. What is
 * refused is a path that escapes the repository root, or an absolute path,
 * because neither can be a coverage record about this repository.
 */
import path from "node:path";

export const MOBILE_PREFIX = "apps/mobile/";

/** Windows separators are an artefact of the writer, not part of the path. */
function toPosix(file) {
  return file.replace(/\\/g, "/");
}

function isAbsolute(file) {
  return file.startsWith("/") || /^[A-Za-z]:/.test(file);
}

/**
 * Rebase one path. Returns `{ path }` on success or `{ error }` on refusal.
 *
 * Idempotent by construction: a path already under `apps/mobile/` is returned
 * unchanged, so applying this twice is the same as applying it once. The tests
 * assert that rather than trusting the reading.
 */
export function normalizeMobilePath(rawFile) {
  const file = toPosix(rawFile).trim();

  if (file === "") return { error: "empty SF: path" };

  if (isAbsolute(file)) {
    return {
      error: `absolute path "${rawFile}" cannot be rebased onto the repository root — a coverage record must name a file inside this repository`,
    };
  }

  // Already rebased: leave it exactly as it is. This is what makes the whole
  // operation idempotent, and it is why a second pass cannot double the prefix.
  const candidate = file.startsWith(MOBILE_PREFIX) ? file : MOBILE_PREFIX + file;

  const normalized = path.posix.normalize(candidate);

  if (normalized.startsWith("../") || normalized === ".." || isAbsolute(normalized)) {
    return {
      error: `path "${rawFile}" escapes the repository root (resolves to "${normalized}") — refusing to write a coverage record that points outside the repository`,
    };
  }

  return { path: normalized };
}

/**
 * Rebase every `SF:` line in an LCOV document.
 *
 * Returns `{ text, rewritten, unchanged, errors }`. Errors do not throw: the
 * caller decides, and it needs the count of every problem rather than the first.
 */
export function normalizeMobileCoverage(text) {
  const errors = [];
  let rewritten = 0;
  let unchanged = 0;

  const lines = text.split(/\r?\n/).map((line) => {
    if (!line.startsWith("SF:")) return line;

    const original = line.slice(3);
    const result = normalizeMobilePath(original);

    if (result.error) {
      errors.push(result.error);
      return line;
    }

    if (result.path === toPosix(original).trim()) unchanged += 1;
    else rewritten += 1;

    return `SF:${result.path}`;
  });

  return { text: lines.join("\n"), rewritten, unchanged, errors };
}
