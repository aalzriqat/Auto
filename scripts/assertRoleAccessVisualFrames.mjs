import { lstatSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const states = ["denied-expenses", "deposit-loading", "deposit-empty", "lead-source", "sales-empty", "quote-choice", "lead-reader", "lead-reader-detail", "marketplace-reply", "lead-source-loading", "quote-status-loading", "marketplace-default"];
export const EXPECTED_ROLE_FRAMES = states.flatMap(state => ["en", "ar"].flatMap(locale =>
  [375, 1440].map(width => `role-access-${state}-${locale}-${width}.png`)));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Inventory only: exact names, nonempty PNG signatures. No pixel or auth claim. */
export function roleFrameErrors(files) {
  const frames = files.filter(file => path.basename(file).startsWith("role-access-"));
  const errors = [];
  for (const name of EXPECTED_ROLE_FRAMES) {
    const matches = frames.filter(file => path.basename(file) === name);
    if (matches.length !== 1) errors.push(`${name}: expected one frame, found ${matches.length}`);
    else {
      const bytes = readFileSync(matches[0]);
      if (bytes.length <= signature.length || !bytes.subarray(0, signature.length).equals(signature)) errors.push(`${name}: empty or invalid PNG signature`);
    }
  }
  for (const file of frames) if (!EXPECTED_ROLE_FRAMES.includes(path.basename(file))) errors.push(`unexpected role frame: ${path.basename(file)}`);
  return errors;
}

function filesWithin(directory, depth = 0) {
  if (depth > 3) throw new Error("Role frame inventory exceeds supported artifact depth");
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlink is not an owned visual artifact");
    if (entry.isDirectory()) return filesWithin(file, depth + 1);
    return entry.isFile() ? [file] : [];
  });
}
/** Validate actual artifacts under the caller's repository; CLI pins its own root. */
export function roleArtifactErrors(repositoryPath, args = []) {
  const relativeRoot = "test-results/deal-cockpit-visual";
  if (args.length > 1 || (args[0] !== undefined && args[0] !== relativeRoot)) {
    throw new Error("Only the repository visual artifact directory is allowed");
  }
  const repository = realpathSync(repositoryPath);
  const parent = path.join(repository, "test-results");
  const root = path.join(parent, "deal-cockpit-visual");
  for (const directory of [parent, root]) {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Symlink is not an owned visual artifact");
  }
  if (path.relative(repository, realpathSync(root)) !== path.join("test-results", "deal-cockpit-visual")) {
    throw new Error("Visual artifacts must remain inside the repository");
  }
  return roleFrameErrors(filesWithin(root));
}

/** Return the real command status; errors and absent evidence always refuse. */
export function runRoleFrameCheck(repository, args) {
  try {
    const errors = roleArtifactErrors(repository, args);
    for (const error of errors) console.error(error);
    console.log(`role screen frame inventory: expected ${EXPECTED_ROLE_FRAMES.length}; ${errors.length ? "FAIL" : "PASS"}. Inventory only; no authenticated or pixel certification.`);
    return errors.length ? 1 : 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "Role frame inventory unavailable"); return 1; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = runRoleFrameCheck(repository, process.argv.slice(2));
}
