#!/usr/bin/env node
/**
 * Upserts one owner ruling into regression/rulings.json (SCRUM-761 S2a).
 *
 * The repository is public and CI holds no Jira token (owner ruling Q2), so the
 * snapshot is refreshed by an operator who has read the ruling in Jira:
 *
 *   node scripts/regression/refreshRulings.mjs --id SCRUM-407#c21031 --text-file ruling.txt [--date 2026-10-07]
 *
 * Only the id, a sha256 of the whitespace-normalised text and a date are written.
 * The text itself is read from a local file and never stored or printed.
 *
 * This proves the snapshot matches the text the operator supplied, not that the
 * text matches live Jira: the operator is the evidence boundary (limitation C4).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULING_ID = /^SCRUM-\d{1,6}#c\d{1,8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Must stay identical to digestRulingText in scenarioRecord.ts (pinned by a test). */
export function digestRulingText(text) {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export function upsertRuling(snapshot, { id, text, date }) {
  if (!RULING_ID.test(id)) throw new Error(`ruling id must look like SCRUM-n#cN, got ${JSON.stringify(id)}`);
  if (!DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
  if (text.trim() === "") throw new Error("ruling text is empty");
  const entry = { id, digest: digestRulingText(text), date };
  const next = snapshot.filter((e) => e.id !== id);
  next.push(entry);
  next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return next;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = arg("id");
  const textFile = arg("text-file");
  if (!id || !textFile) {
    console.error("usage: refreshRulings.mjs --id SCRUM-n#cN --text-file <file> [--date YYYY-MM-DD]");
    process.exit(2);
  }
  const target = resolve(dirname(fileURLToPath(import.meta.url)), "../../regression/rulings.json");
  const repoRoot = resolve(dirname(target), "..");
  const rel = relative(repoRoot, resolve(textFile));
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    // The repo is public: a ruling text file left inside it can be committed by a stray `git add -A`.
    console.error("refusing --text-file inside the repository; keep ruling text outside the working tree");
    process.exit(2);
  }
  const current = JSON.parse(readFileSync(target, "utf8"));
  const date = arg("date") ?? new Date().toISOString().slice(0, 10);
  const next = upsertRuling(current, { id, text: readFileSync(textFile, "utf8"), date });
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`rulings.json: ${id} -> ${next.find((e) => e.id === id).digest.slice(0, 12)}… (${next.length} total)`);
}
