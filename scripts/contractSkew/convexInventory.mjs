/**
 * Which exports of the PINNED `convex` package take a Convex function reference.
 *
 * ⚠️ THIS IS DERIVED FROM THE PACKAGE'S OWN DECLARATIONS, NOT FROM A LIST WE
 * WROTE. The census (`census.mjs`) classifies every SDK entry point by kind, and
 * that table is hand-maintained — so the thing that stops it silently going
 * stale is this scan, which reads the installed `.d.ts` files and returns every
 * function or method whose signature takes a function-reference TYPE. A test
 * fails the day a Convex upgrade adds one the table has not classified.
 *
 * ⚠️ BY MEANING, NOT BY SPELLING (CS2-4). The first version matched a regex over
 * the parameter's source TEXT, so `type RefArg = FunctionReference<"query">;
 * declare function newHook(ref: RefArg)` was missed: the word never appears in
 * the signature. This version builds a TypeScript program over the package's
 * declarations and asks the checker whether a parameter's RESOLVED type is, or
 * contains (through aliases, unions, intersections, generic constraints, type
 * arguments and anonymous object members), one of the reference types.
 *
 * Keys are `exportName` for a module-level function and `Owner.method` for a
 * class or interface member.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

/** The types that ARE a function reference (or a handle to / preload of one). */
const REFERENCE_TYPE_NAMES = new Set([
  "FunctionReference",
  "PaginatedQueryReference",
  "RequestForQueries",
  "FunctionHandle",
  "PreloadedQuery",
  "Preloaded",
]);

/** Directories of the package that are not a client/server runtime API. */
const EXCLUDED_DIRS = new Set(["cli", "bundler", "test", "vendor", "esbuild-plugins", "dashboard"]);

/** How far into nested object members / type arguments a parameter is searched. */
const MAX_TYPE_DEPTH = 6;

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

  /** @type {string[]} */
  const declarationFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name === "node_modules") continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".d.ts")) {
        declarationFiles.push(path.join(dir, entry.name));
      }
    }
  };
  walk(packageDir);

  const program = ts.createProgram(declarationFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    // Only the package's own declarations are of interest; a missing @types
    // package must not change what a parameter RESOLVES to inside the package.
    types: [],
  });
  const checker = program.getTypeChecker();

  /**
   * Is this type, or anything it is built from, a function-reference type?
   *
   * @param {import("typescript").Type} type
   * @param {Set<import("typescript").Type>} seen
   * @param {number} depth
   * @returns {boolean}
   */
  const containsReference = (type, seen, depth) => {
    if (!type || seen.has(type) || depth > MAX_TYPE_DEPTH) return false;
    seen.add(type);

    if (type.aliasSymbol && REFERENCE_TYPE_NAMES.has(type.aliasSymbol.name)) return true;
    const symbol = type.getSymbol();
    if (symbol && REFERENCE_TYPE_NAMES.has(symbol.name)) return true;

    // STRUCTURAL: whatever it is called (`SchedulableFunctionReference`,
    // `AnyFunctionReference`, a consumer alias), a function reference is the
    // object type carrying `_visibility` and `_args`.
    if (type.flags & ts.TypeFlags.Object && type.getProperty("_visibility") && type.getProperty("_args")) {
      return true;
    }

    // A conditional / indexed type (`FunctionArgs<M>`, `FunctionReturnType<M>`)
    // is DERIVED from a reference, it does not take one: it is not followed.
    if (type.flags & (ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Substitution)) {
      return false;
    }

    // Unions and intersections: any member.
    if (type.isUnionOrIntersection()) {
      return type.types.some((member) => containsReference(member, seen, depth + 1));
    }
    // A generic parameter is what its constraint allows.
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint ? containsReference(constraint, seen, depth + 1) : false;
    }
    // `Array<Ref>`, `Record<string, Ref>`, `Promise<Ref>`, tuples: the arguments.
    const aliasArguments = type.aliasTypeArguments ?? [];
    if (aliasArguments.some((argument) => containsReference(argument, seen, depth + 1))) return true;
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = /** @type {import("typescript").ObjectType} */ (type);
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const args = checker.getTypeArguments(/** @type {import("typescript").TypeReference} */ (objectType));
        if (args.some((argument) => containsReference(argument, seen, depth + 1))) return true;
      }
      // An ANONYMOUS object type (`{ query: Ref }`) is searched member by member.
      // A NAMED class / interface is not: it is its own entry point, and walking
      // every member of every named parameter type would find unrelated clients.
      if (objectType.objectFlags & ts.ObjectFlags.Anonymous && !symbol?.name?.startsWith("__")) {
        return false;
      }
      if (objectType.objectFlags & ts.ObjectFlags.Anonymous) {
        return checker
          .getPropertiesOfType(type)
          .some((property) => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            if (!declaration) return false;
            return containsReference(checker.getTypeOfSymbolAtLocation(property, declaration), seen, depth + 1);
          });
      }
    }
    return false;
  };

  /** Does any PARAMETER of this signature-bearing node take a reference? */
  const takesReference = (node) => {
    for (const parameter of node.parameters ?? []) {
      if (containsReference(checker.getTypeAtLocation(parameter), new Set(), 0)) return true;
    }
    return false;
  };

  /** @type {Map<string,string>} */
  const keys = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) continue;
    const absolute = path.resolve(sourceFile.fileName);
    // Only the package's own (non-excluded) declarations are inventoried.
    if (!declarationFiles.some((f) => path.resolve(f) === absolute)) continue;
    const rel = path.relative(packageDir, absolute).replace(/\\/g, "/");
    const add = (key) => {
      if (!keys.has(key)) keys.set(key, rel);
    };
    const visit = (node, owner) => {
      if (ts.isFunctionDeclaration(node) && node.name && takesReference(node)) {
        add(owner ? `${owner}.${node.name.text}` : node.name.text);
      }
      if (
        (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
        owner &&
        ts.isIdentifier(node.name) &&
        takesReference(node)
      ) {
        add(`${owner}.${node.name.text}`);
      }
      // A function-typed property: `readonly x: (ref: FunctionReference<...>) => ...`
      if (ts.isPropertySignature(node) && owner && node.type && ts.isFunctionTypeNode(node.type)) {
        if (ts.isIdentifier(node.name) && takesReference(node.type)) {
          add(`${owner}.${node.name.text}`);
        }
      }
      // `export declare const useX: (ref: FunctionReference) => ...`
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !owner) {
        const type = node.type;
        if (type && ts.isFunctionTypeNode(type) && takesReference(type)) add(node.name.text);
      }
      const nextOwner =
        (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name
          ? node.name.text
          : owner;
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(sourceFile, null);
  }

  return { version, packageDir, keys };
}
