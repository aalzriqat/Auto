import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stages the PR candidate's Convex backend as DATA for a trusted deploy
 * (SCRUM-350 Option C).
 *
 * The Convex preview credential is project-wide (run 36114902831), so the
 * candidate backend may only be deployed by code the candidate cannot change.
 * This runs with no credential at all and produces a directory the trusted CLI
 * deploys from inside a container that sees nothing else:
 *
 * - only `convex/` and `lib/` are taken from the candidate — the backend's
 *   measured import closure (every non-test import leaving convex/ lands in
 *   lib/). Anything else it reaches for is absent, so the bundle fails closed;
 * - every dependency and CLI-configuration file is TRUSTED's copy, and the
 *   candidate's must be byte-identical to it. A PR that changes dependencies
 *   cannot be deployed this way, because its lockfile would decide which code
 *   runs beside the key;
 * - symlinks, hard links and special files are refused (a link is how a file
 *   outside the stage gets read into the bundle), as are `.wasm` files (the
 *   Convex bundler loads them as raw bytes) and nested `package.json` files
 *   (they change module resolution inside the tree).
 *
 * Refusals name a fixed reason and a repository-relative path, never file
 * contents: the output reaches public Actions logs.
 */

export const STAGED_DIRECTORIES = Object.freeze(["convex", "lib"]);
export const DEPENDENCY_SURFACE = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "convex.json",
]);
// Trusted copies the CLI and esbuild read from the stage root.
const TRUSTED_ROOT_FILES = Object.freeze([...DEPENDENCY_SURFACE, "tsconfig.json"]);

export class StageRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "StageRefusal";
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertDependencySurfaceUnchanged(candidateRoot, trustedRoot) {
  for (const name of DEPENDENCY_SURFACE) {
    const candidatePath = path.join(candidateRoot, name);
    const trustedPath = path.join(trustedRoot, name);
    const candidateExists = existsSync(candidatePath);
    const trustedExists = existsSync(trustedPath);
    if (candidateExists !== trustedExists) {
      throw new StageRefusal(
        "Candidate " + (candidateExists ? "adds" : "removes") + " " + name +
          "; the trusted lane deploys only with trusted dependencies.",
      );
    }
    if (!candidateExists) continue;
    const candidateStat = lstatSync(candidatePath);
    if (!candidateStat.isFile()) {
      throw new StageRefusal("Candidate " + name + " is not a regular file.");
    }
    if (!readFileSync(candidatePath).equals(readFileSync(trustedPath))) {
      throw new StageRefusal(
        "Candidate changes " + name +
          "; the trusted lane deploys only with trusted dependencies.",
      );
    }
  }
}

function collectFiles(candidateRoot, relativeDir, files) {
  const absoluteDir = path.join(candidateRoot, relativeDir);
  const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relative = relativeDir + "/" + entry.name;
    if (entry.name === "." || entry.name === ".." || /[\\/\0]/.test(entry.name)) {
      throw new StageRefusal("Candidate path has an unsafe name: " + relative);
    }
    const stat = lstatSync(path.join(candidateRoot, relative));
    if (stat.isSymbolicLink()) {
      throw new StageRefusal("Candidate backend contains a symlink: " + relative);
    }
    if (stat.isDirectory()) {
      if (entry.name === "node_modules") {
        throw new StageRefusal("Candidate backend contains node_modules: " + relative);
      }
      collectFiles(candidateRoot, relative, files);
      continue;
    }
    if (!stat.isFile()) {
      throw new StageRefusal("Candidate backend contains a special file: " + relative);
    }
    if (stat.nlink !== 1) {
      throw new StageRefusal("Candidate backend contains a hard link: " + relative);
    }
    if (entry.name === "package.json") {
      throw new StageRefusal("Candidate backend contains a nested package.json: " + relative);
    }
    if (entry.name.toLowerCase().endsWith(".wasm")) {
      throw new StageRefusal("Candidate backend contains a .wasm file: " + relative);
    }
    files.push(relative);
  }
}

/**
 * @param {{ candidateRoot: string, trustedRoot: string, stageRoot: string, testedSha?: string }} options
 * @returns {{ version: 1, testedSha: string | null, files: Array<{ path: string, sha256: string, bytes: number }> }}
 */
export function stageCandidateBackend({ candidateRoot, trustedRoot, stageRoot, testedSha }) {
  for (const [label, value] of [
    ["CANDIDATE_ROOT", candidateRoot],
    ["TRUSTED_ROOT", trustedRoot],
    ["STAGE_ROOT", stageRoot],
  ]) {
    if (!value || !path.isAbsolute(value)) {
      throw new StageRefusal(label + " must be an absolute path.");
    }
  }
  if (existsSync(stageRoot) && readdirSync(stageRoot).length > 0) {
    throw new StageRefusal("STAGE_ROOT must be empty; refusing to mix stages.");
  }

  assertDependencySurfaceUnchanged(candidateRoot, trustedRoot);

  const files = [];
  for (const directory of STAGED_DIRECTORIES) {
    const stat = lstatSync(path.join(candidateRoot, directory));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new StageRefusal("Candidate " + directory + "/ is not a plain directory.");
    }
    collectFiles(candidateRoot, directory, files);
  }

  const manifest = [];
  for (const relative of files) {
    const source = path.join(candidateRoot, relative);
    const target = path.join(stageRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    const bytes = readFileSync(source);
    writeFileSync(target, bytes, { flag: "wx" });
    manifest.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
  }
  for (const name of TRUSTED_ROOT_FILES) {
    const trustedPath = path.join(trustedRoot, name);
    if (existsSync(trustedPath)) copyFileSync(trustedPath, path.join(stageRoot, name));
  }
  // The mount point for the trusted node_modules. Created here so docker never
  // has to create it inside a read-only bind.
  mkdirSync(path.join(stageRoot, "node_modules"), { recursive: true });

  return { version: 1, testedSha: testedSha ?? null, files: manifest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const manifest = stageCandidateBackend({
      candidateRoot: process.env.CANDIDATE_ROOT ?? "",
      trustedRoot: process.env.TRUSTED_ROOT ?? "",
      stageRoot: process.env.STAGE_ROOT ?? "",
      testedSha: process.env.TESTED_SHA,
    });
    if (process.env.STAGE_MANIFEST_PATH) {
      writeFileSync(process.env.STAGE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    }
    process.stdout.write(
      "Staged " + manifest.files.length + " candidate backend files from " +
        STAGED_DIRECTORIES.join("/, ") + "/ with trusted dependencies.\n",
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof StageRefusal
        ? error.message
        : "Staging failed unexpectedly (" + String(error?.code ?? "no code") + ").") + "\n",
    );
    process.exit(1);
  }
}
