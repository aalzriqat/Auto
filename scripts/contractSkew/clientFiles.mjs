/**
 * Which files count as "the client" for skew purposes — and which do not.
 *
 * Shared by the baseline scanner and the CLI so the two cannot silently
 * disagree about scope: a coverage denominator means nothing if the numerator
 * was measured over a different set of files.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * A client surface is a set of directories PLUS the tsconfig that types them.
 * They are separate programs because they genuinely are: the root tsconfig
 * excludes `apps`, and the mobile app extends `expo/tsconfig.base`. Scanning
 * mobile files under the web program would resolve their types against the
 * wrong lib and produce confident nonsense.
 */
export const CLIENT_SURFACES = [
  {
    name: "web",
    dirs: ["app", "components", "lib", "hooks"],
    tsconfig: "tsconfig.json",
    ships: "Vercel GitHub integration, on merge to main",
  },
  {
    name: "mobile",
    // ⚠️ BOTH directories. `apps/mobile/app` holds the Expo Router route groups
    // — real screens, including org finance and admin tabs. It calls no Convex
    // function today, which is exactly why a hand-written list missed it: the
    // omission was invisible until someone looked. Screen-level hooks are
    // idiomatic in Expo Router, so the first one added there would otherwise
    // have gone unscanned.
    dirs: ["apps/mobile/src", "apps/mobile/app"],
    tsconfig: "apps/mobile/tsconfig.json",
    // ⚠️ The worse half of the skew surface, not the lesser one. An EAS OTA
    // update publishes to devices with NO Convex deploy involved at all, so the
    // mobile client can move ahead of the backend without anything resembling a
    // merge — even less coupling than the SCRUM-177 path had.
    ships: "EAS OTA update, which publishes without any Convex deploy",
  },
];

/** Kept for callers that only want the web dirs (the historical default). */
export const CLIENT_DIRS = CLIENT_SURFACES[0].dirs;

const EXTS = new Set([".ts", ".tsx"]);

/**
 * Any of these in a file's text means it talks to Convex from a client.
 * Deliberately excludes `ctx.runMutation` and friends: those are
 * Convex-to-Convex calls, which ship with their callee in one `convex deploy`
 * and cannot skew at all.
 */
const CONVEX_CALL_MARKERS =
  /\buse(Mutation|Query|PaginatedQuery|Action)\b|\b(fetchQuery|fetchMutation|fetchAction|preloadQuery)\b/;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "playwright-report",
  "test-results",
  "convex", // backend; its calls ship with their callee
  // Tooling and test harnesses. None of these is shipped to a user, so a Convex
  // call inside them cannot skew against production for anybody. Without this,
  // the derived scan reported THIS TOOL'S OWN test fixture as an unscanned
  // client surface — a control accusing itself.
  "scripts",
  "playwright",
  "cypress",
  "e2e",
  "testsprite_tests",
]);

function isScannableSourceFile(name) {
  return (
    EXTS.has(path.extname(name)) &&
    !name.endsWith(".d.ts") &&
    // ⚠️ Tests are not shipped clients. Counting them inflates coverage and
    // manufactures findings: the first run flagged a call in
    // QuoteDepositManager.test.tsx as a production skew, which no user can
    // ever reach.
    !/\.test\.tsx?$/.test(name) &&
    !/\.spec\.tsx?$/.test(name)
  );
}

function walkFiles(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walkFiles(full, onFile);
    } else if (isScannableSourceFile(entry.name)) {
      onFile(full);
    }
  }
}

/** Files belonging to one surface. */
export function listSurfaceFiles(root, surface) {
  const out = [];
  for (const dir of surface.dirs) walkFiles(path.resolve(root, dir), (f) => out.push(f));
  return out;
}

/**
 * ⚠️ CASE-FOLD ONLY WHERE THE FILESYSTEM ACTUALLY IS CASE-INSENSITIVE.
 *
 * This lowercased unconditionally. On Linux — which is what CI runs —
 * `app/Foo.tsx` and `app/foo.tsx` are DIFFERENT files that collapsed to one
 * key, so if either had been scanned the other was treated as scanned and
 * dropped from the gap report. The run then exited 0 for a client file the
 * control never examined, which is the exact failure the comment above
 * describes.
 *
 * Only win32 is folded, deliberately not darwin: APFS can be configured either
 * way. Being wrong there produces a false GAP (a scanned file reported as
 * unscanned), which denies PASS and is loud. Folding when we should not
 * produces a false PASS, which is silent. When the two error directions are
 * unequal, take the loud one.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32";
const normalize = (p) => {
  const abs = path.resolve(p).split(path.sep).join("/");
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
};

/**
 * Client files that call Convex and are NOT covered by any surface — DERIVED by
 * walking the repository rather than listed by hand.
 *
 * ⚠️ A hand-maintained list of "things we do not scan" is only correct on the
 * day it is written. `apps/mobile` was invisible to this control until someone
 * happened to look; deriving the answer means the next client surface added
 * anywhere in the repository downgrades the verdict by itself, on its first
 * run, without anyone remembering to update a constant.
 *
 * @param {string} root
 * @param {string[]} scannedFiles absolute paths that WERE scanned
 * @returns {{ file: string }[]}
 */
export function unscannedConvexClients(root, scannedFiles) {
  const scanned = new Set(scannedFiles.map(normalize));
  const missed = [];
  walkFiles(path.resolve(root), (file) => {
    if (scanned.has(normalize(file))) return;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (CONVEX_CALL_MARKERS.test(text)) {
      missed.push({ file: path.relative(root, file).split(path.sep).join("/") });
    }
  });
  return missed;
}
