/**
 * The component inventory the zero-state verifier must read (SCRUM-231 /
 * SCRUM-313 B4, SCRUM-807).
 *
 * The CLI addresses a component by its path — `workflow` or `workflow/workpool`
 * (`convex data --component <path>`) — and a mount's own table listing never
 * names its children. So the scope is derived from the code that defines it:
 * `convex/convex.config.ts`, then each mounted package's own installed
 * `convex.config.js`, recursively, each child resolved from its PARENT's real
 * location (not from the repository root, whose copy of a package may differ
 * from the one the parent actually depends on).
 *
 * Fail closed: the inventory is read from the syntax tree, not by pattern, and
 * anything it cannot establish exactly throws. A `.use(...)` call it cannot
 * parse (a constant or computed name, a spread, a non-default import, a call on
 * some other receiver, a reference to `.use` that is not a call) must never be
 * silently omitted — a component whose tables were never read would certify as
 * empty. Comments and string literals cannot create or hide a mount.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const MAX_DEPTH = 6;

interface Mount {
  specifier: string;
  /** The `name:` option, when given as a string literal. */
  name: string | null;
}
interface ParsedConfig {
  /** `defineComponent("<name>")`; null for the app. */
  name: string | null;
  mounts: Mount[];
}

function stringValue(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** Reads one `convex.config` file's own identity and `.use(...)` mounts, or throws. */
export function parseComponentConfig(source: string, file: string, kind: "app" | "component"): ParsedConfig {
  // createSourceFile recovers an AST even from invalid syntax. Validate through
  // the supported compiler API before trusting that recovered tree as evidence.
  const diagnostics = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (!diagnostics || diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`${file}: configuration syntax cannot be validated.`);
  }
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const definer = kind === "app" ? "defineApp" : "defineComponent";
  const imports = new Map<string, string>();
  const definerCalls: ts.CallExpression[] = [];
  const useCalls: ts.CallExpression[] = [];
  const calleeAccesses = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.name && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.set(node.importClause.name.text, node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === definer) definerCalls.push(node);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "use") {
        useCalls.push(node);
        calleeAccesses.add(node.expression);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "use" && !calleeAccesses.has(node)) {
      throw new Error(`${file}: a reference to .use that is not a direct call cannot be inventoried.`);
    }
    if (ts.isElementAccessExpression(node)) {
      const property = stringValue(node.argumentExpression);
      if (property === null || property === "use") {
        throw new Error(`${file}: a dynamic property or computed .use access cannot be inventoried.`);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const property = node.propertyName ?? node.name;
      if (
        node.dotDotDotToken ||
        ts.isComputedPropertyName(property) ||
        (ts.isIdentifier(property) && property.text === "use") ||
        stringValue(property) === "use"
      ) {
        throw new Error(`${file}: a destructured component method cannot be inventoried.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (definerCalls.length !== 1) {
    throw new Error(`${file}: expected exactly one ${definer}(...) call, found ${definerCalls.length}.`);
  }
  const name = kind === "component" ? stringValue(definerCalls[0].arguments[0]) : null;
  if (kind === "component" && name === null) throw new Error(`${file}: the component's name is not a string literal.`);

  const holder = definerCalls[0].parent;
  const receiver = ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null;

  const mounts: Mount[] = [];
  for (const call of useCalls) {
    const callee = call.expression as ts.PropertyAccessExpression;
    if (receiver === null || !ts.isIdentifier(callee.expression) || callee.expression.text !== receiver) {
      throw new Error(`${file}: a .use(...) call on something other than the ${definer} result cannot be inventoried.`);
    }
    const [target, options, ...rest] = call.arguments;
    if (!target || !ts.isIdentifier(target) || rest.length > 0) {
      throw new Error(`${file}: a .use(...) call that is not (importedComponent[, { options }]) cannot be inventoried.`);
    }
    const specifier = imports.get(target.text);
    if (specifier === undefined) {
      throw new Error(`${file}: .use(${target.text}) is not a default import, so its package is unknown.`);
    }
    let mountName: string | null = null;
    if (options !== undefined) {
      if (!ts.isObjectLiteralExpression(options)) {
        throw new Error(`${file}: the options of .use(${target.text}, ...) are not an object literal.`);
      }
      for (const property of options.properties) {
        if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) {
          throw new Error(`${file}: .use(${target.text}, ...) has a spread or computed option that could carry a name.`);
        }
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key !== "name") continue;
        const literal = ts.isPropertyAssignment(property) ? stringValue(property.initializer) : null;
        if (literal === null) throw new Error(`${file}: the name of .use(${target.text}, ...) is not a string literal.`);
        mountName = literal;
      }
    }
    mounts.push({ specifier, name: mountName });
  }
  return { name, mounts };
}

function resolveFrom(specifier: string, fromFile: string): string {
  try {
    return fs.realpathSync(createRequire(fromFile).resolve(specifier));
  } catch {
    throw new Error(`Component package ${specifier} cannot be resolved from ${fromFile}, so its tables cannot be inventoried.`);
  }
}

function walk(parsed: ParsedConfig, file: string, prefix: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) throw new Error(`Component mounts nest deeper than ${MAX_DEPTH} levels at ${prefix}.`);
  for (const mount of parsed.mounts) {
    const childFile = resolveFrom(mount.specifier, file);
    const child = parseComponentConfig(fs.readFileSync(childFile, "utf8"), childFile, "component");
    const name = mount.name ?? child.name;
    if (name === null) throw new Error(`${childFile}: the mounted component has no name.`);
    const componentPath = prefix === "" ? name : `${prefix}/${name}`;
    if (out.includes(componentPath)) throw new Error(`Component path ${componentPath} is mounted twice.`);
    out.push(componentPath);
    walk(child, childFile, componentPath, depth + 1, out);
  }
}

/**
 * Every component path the app mounts, nested ones included, each parent before
 * its children. `source` is injectable so tests can present synthetic configs;
 * package specifiers always resolve from `configFile`'s real location.
 */
export function componentPaths(configFile: string, source: string = fs.readFileSync(configFile, "utf8")): string[] {
  const out: string[] = [];
  walk(parseComponentConfig(source, configFile, "app"), fs.realpathSync(configFile), "", 0, out);
  return out;
}
