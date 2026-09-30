#!/usr/bin/env node
/**
 * Merge CONTENT identity for the trusted Sonar PR workflow (SCRUM-494).
 * GitHub regenerates refs/pull/N/merge with the same tree and parents but a new
 * commit date/SHA, so merges are compared by (tree, first parent, second parent).
 * Fails closed: anything that is not a 40-hex SHA of a present, exact two-parent
 * merge commit throws. CLI: mergeContentIdentity.mjs [--repo <dir>] same <a> <b>
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/i;

/** Returns { tree, first, second } (lower-cased) or throws. */
export function contentIdentity(repo, sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error("merge SHA is not a 40-hex commit id");
  }
  let raw;
  try {
    raw = execFileSync("git", ["-C", repo, "cat-file", "commit", sha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`${sha} is not a commit present in the repository`);
  }
  const header = raw.split("\n\n", 1)[0];
  let tree = null;
  const parents = [];
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }
  if (!tree || !SHA_RE.test(tree)) throw new Error(`commit ${sha} has no valid tree`);
  if (parents.length !== 2 || !parents.every((p) => SHA_RE.test(p))) {
    throw new Error(`commit ${sha} is not an exact two-parent merge`);
  }
  return { tree: tree.toLowerCase(), first: parents[0].toLowerCase(), second: parents[1].toLowerCase() };
}

/** True only when tree, first parent and second parent (in order) all match. */
export function sameContentIdentity(repo, shaA, shaB) {
  const a = contentIdentity(repo, shaA);
  const b = contentIdentity(repo, shaB);
  return a.tree === b.tree && a.first === b.first && a.second === b.second;
}

function main(argv) {
  const args = [...argv];
  let repo = ".";
  if (args[0] === "--repo") {
    repo = args[1];
    args.splice(0, 2);
  }
  const [cmd, shaA, shaB] = args;
  if (cmd !== "same" || args.length !== 3) {
    console.error("usage: mergeContentIdentity.mjs [--repo <dir>] same <shaA> <shaB>");
    return 2;
  }
  try {
    if (sameContentIdentity(repo, shaA, shaB)) return 0;
    console.error("merge content identities differ (tree or parents)");
  } catch (error) {
    console.error(`mergeContentIdentity: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
