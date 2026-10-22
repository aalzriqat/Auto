import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const states = ["denied-expenses", "deposit-loading", "deposit-empty", "lead-source", "sales-empty", "quote-choice", "lead-reader", "marketplace-reply"];
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
    return entry.isDirectory() ? filesWithin(file, depth + 1) : entry.isFile() ? [file] : [];
  });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const errors = roleFrameErrors(filesWithin(path.resolve(process.argv[2] ?? "test-results/deal-cockpit-visual")));
    for (const error of errors) console.error(error);
    console.log(`role screen frame inventory: expected ${EXPECTED_ROLE_FRAMES.length}; ${errors.length ? "FAIL" : "PASS"}. Inventory only; no authenticated or pixel certification.`);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "Role frame inventory unavailable"); process.exitCode = 1; }
}
