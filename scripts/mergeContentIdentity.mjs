#!/usr/bin/env node
/**
 * Merge CONTENT identity for the trusted Sonar PR workflow (SCRUM-494).
 *
 * GitHub regenerates refs/pull/N/merge with an identical tree and identical
 * parents but a new committer date, hence a new commit SHA. Comparing merge
 * commit SHAs therefore refuses coverage that was produced from exactly the
 * content Sonar analyses. The identity that matters is the ordered triple
 * (tree, first parent, second parent). This module is the single definition
 * of that identity; every comparison in .github/workflows/sonar-pr-report.yml
 * goes through it.
 *
 * Fails closed: any input that is not a 40-hex SHA of a commit present in the
 * repository, or a commit that is not an exact two-parent merge, throws. The
 * commit object is read with `git cat-file`; nothing is executed or evaluated.
 *
 * CLI (repo defaults to the cwd):
 *   node mergeContentIdentity.mjs [--repo <dir>] identity <sha>
 *   node mergeContentIdentity.mjs [--repo <dir>] same <shaA> <shaB>
 * `same` exits 0 only when both identities are equal; every failure exits 1.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/i;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Returns { tree, first, second } (lower-cased) or throws. */
export function contentIdentity(repo, sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error("merge SHA is not a 40-hex commit id");
  }
  let type;
  try {
    type = git(repo, ["cat-file", "-t", sha]).trim();
  } catch {
    throw new Error(`commit ${sha} is not present in the repository`);
  }
  if (type !== "commit") throw new Error(`object ${sha} is a ${type}, not a commit`);

  const header = git(repo, ["cat-file", "commit", sha]).split("\n\n", 1)[0];
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
  let repo = ".";
  const args = [...argv];
  if (args[0] === "--repo") {
    repo = args[1];
    args.splice(0, 2);
  }
  const [cmd, ...rest] = args;
  try {
    if (cmd === "identity" && rest.length === 1) {
      const id = contentIdentity(repo, rest[0]);
      console.log(`${id.tree} ${id.first} ${id.second}`);
      return 0;
    }
    if (cmd === "same" && rest.length === 2) {
      if (sameContentIdentity(repo, rest[0], rest[1])) return 0;
      console.error("merge content identities differ (tree or parents)");
      return 1;
    }
    console.error("usage: mergeContentIdentity.mjs [--repo <dir>] identity <sha> | same <shaA> <shaB>");
    return 2;
  } catch (error) {
    console.error(`mergeContentIdentity: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
