import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const EXCLUDED = new Set(["node_modules", "_generated", "coverage", "playwright-report", "test-results"]);
let snapshot: ReadonlyMap<string, string> | undefined;

/** One whole-root source snapshot for binding discovery and the switch census. I/O failures throw. */
export function pilotSourceSnapshot(): ReadonlyMap<string, string> {
  if (snapshot) return snapshot;
  const sources = new Map<string, string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(path.join(ROOT, dir))) {
      if (entry.startsWith(".") || EXCLUDED.has(entry)) continue;
      const rel = dir ? `${dir}/${entry}` : entry;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
        sources.set(rel, readFileSync(path.join(ROOT, rel), "utf8"));
      }
    }
  }
  walk("");
  snapshot = sources;
  return snapshot;
}
