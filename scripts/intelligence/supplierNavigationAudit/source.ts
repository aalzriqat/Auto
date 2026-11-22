import { join } from "node:path";
import ts from "typescript";

export const root = join(__dirname, "..", "..", "..");

export const updateTable = "Update scripts/intelligence/supplierNavigationDoors.test.ts and its public-query test rows";

// Files stay unchanged during one test process. Share their syntax trees read-only;
// each injected probe below still parses its own distinct source text.
const parsedSources = new Map<string, ts.SourceFile>();

export function parse(file: string): ts.SourceFile {
  const cached = parsedSources.get(file);
  if (cached) return cached;
  // Bypass Vitest module mocks: setup must not serve an old source image to its own guard.
  const source = ts.createSourceFile(file, process.getBuiltinModule("fs").readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  parsedSources.set(file, source);
  return source;
}
