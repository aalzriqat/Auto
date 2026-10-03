/**
 * Which exports of the PINNED `convex` package take a Convex function reference.
 *
 * ⚠️ THIS IS DERIVED FROM THE PACKAGE'S OWN DECLARATIONS, NOT FROM A LIST WE
 * WROTE. The census (`census.mjs`) classifies every SDK entry point by kind, and
 * that table is hand-maintained — so the thing that stops it silently going
 * stale is this scan, which reads the installed `.d.ts` files and returns every
 * function or method whose signature mentions a function-reference type. A test
 * fails the day a Convex upgrade adds one the table has not classified.
 *
 * Keys are `exportName` for a module-level function and `Owner.method` for a
 * class or interface member.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

/** A parameter or type-parameter constraint that names a function reference. */
const REFERENCE_TYPE = /FunctionReference|PaginatedQueryReference|RequestForQueries|FunctionHandle|PreloadedQuery|Preloaded</;

/** Directories of the package that are not a client/server runtime API. */
const EXCLUDED_DIRS = new Set(["cli", "bundler", "test", "vendor", "esbuild-plugins", "dashboard"]);

/**
 * @param {string} projectRoot  directory whose node_modules holds `convex`
 * @returns {{ version: string, packageDir: string, keys: Map<string,string> }}
 *   keys: inventory key -> the d.ts file it was found in (relative to the package)
 */
export function inventoryConvexEntryPoints(projectRoot) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  const packageJson = require.resolve("convex/package.json");
  const packageDir = path.dirname(packageJson);
  const version = JSON.parse(fs.readFileSync(packageJson, "utf8")).version;

  /** @type {Map<string,string>} */
  const keys = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".d.ts")) {
        scanDeclarationFile(path.join(dir, entry.name));
      }
    }
  };

  const mentionsReference = (node) => {
    const parts = [];
    for (const parameter of node.parameters ?? []) parts.push(parameter.getText());
    for (const typeParameter of node.typeParameters ?? []) parts.push(typeParameter.getText());
    return REFERENCE_TYPE.test(parts.join(" "));
  };

  const scanDeclarationFile = (file) => {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(packageDir, file).replace(/\\/g, "/");
    const add = (key) => {
      if (!keys.has(key)) keys.set(key, rel);
    };
    const visit = (node, owner) => {
      if (ts.isFunctionDeclaration(node) && node.name && mentionsReference(node)) {
        add(owner ? `${owner}.${node.name.text}` : node.name.text);
      }
      if (
        (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
        owner &&
        ts.isIdentifier(node.name) &&
        mentionsReference(node)
      ) {
        add(`${owner}.${node.name.text}`);
      }
      // A function-typed property: `readonly x: (ref: FunctionReference<...>) => ...`
      if (ts.isPropertySignature(node) && owner && node.type && ts.isFunctionTypeNode(node.type)) {
        if (ts.isIdentifier(node.name) && mentionsReference(node.type)) {
          add(`${owner}.${node.name.text}`);
        }
      }
      // `export declare const useX: (ref: FunctionReference) => ...`
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !owner) {
        const type = node.type;
        if (type && ts.isFunctionTypeNode(type) && mentionsReference(type)) add(node.name.text);
      }
      const nextOwner =
        (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name
          ? node.name.text
          : owner;
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(source, null);
  };

  walk(packageDir);
  return { version, packageDir, keys };
}
