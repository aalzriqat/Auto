import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Exists so convex/*.test.ts files need no Node builtin imports (convex-lint "Node API without use node").
export function readSourceRelativeTo(baseUrl: string, rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, baseUrl)), "utf8");
}
