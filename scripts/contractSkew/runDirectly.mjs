/**
 * Whether a module is the program Node was started on (`node path/to/module.mjs`).
 *
 * The ESM idiom `import.meta.url === pathToFileURL(process.argv[1]).href` compares a REAL path (the loader
 * resolves symlinks and junctions before it sets `import.meta.url`) with the path as TYPED. Started through a
 * symlink or junction (a `node_modules` link, a `C:\h*` worktree link) they differ, the guarded `main()` never
 * runs, and the process exits 0 having checked nothing: fail-open in a required gate. Both sides are therefore
 * reduced to their canonical real path before they are compared (Node docs: "ES modules, `import.meta.url`" and
 * `fs.realpath`; `import.meta.main` does the same but needs Node >= 22.18, CI pins 22.21.1 and developers vary).
 *
 * @param {string} moduleUrl  the caller's `import.meta.url`
 * @param {string | undefined} [entry]  defaults to `process.argv[1]`
 * @returns {boolean}
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function isRunDirectly(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
