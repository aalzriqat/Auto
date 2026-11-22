import ts from "typescript";
import { navigationStatementName, navigationFingerprint } from "./fingerprints";
import { callerLiteral } from "./callerCells";
import { resolve } from "node:path";
import { root } from "./source";
import { CENSUS_DIRECTORY, CENSUS_PIN_FILE, CENSUS_SUITE, EXECUTABLE_CLOSURE } from "./closurePins";
import { createHash } from "node:crypto";
import { EXTERNAL_CLOSURE } from "./externalClosurePins";

function closureStatements(source: ts.SourceFile, file: string): readonly ts.Statement[] {
  if (file !== CENSUS_PIN_FILE) return source.statements;
  const table = assertClosurePinLiteral(source);
  return source.statements.filter(node => node !== table);
}

function assertClosurePinLiteral(source: ts.SourceFile): ts.Statement {
  const statements = source.statements.filter(node => navigationStatementName(node, source) === "EXECUTABLE_CLOSURE");
  const statement = statements[0];
  if (statements.length !== 1 || !statement || !ts.isVariableStatement(statement) ||
    statement.declarationList.flags !== ts.NodeFlags.Const || statement.declarationList.declarations.length !== 1) {
    throw new Error("EXECUTABLE_CLOSURE must be one const literal table");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) throw new Error("EXECUTABLE_CLOSURE must be a literal array");
  if (initializer.elements.length === 0) throw new Error("EXECUTABLE_CLOSURE requires non-empty pins");
  const files = new Set<string>();
  for (const entry of initializer.elements) {
    if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 3) throw new Error("EXECUTABLE_CLOSURE requires file, hashes and textHash literals");
    const fields = new Map<string, unknown>();
    for (const property of entry.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("EXECUTABLE_CLOSURE refuses executable properties");
      fields.set(property.name.text, callerLiteral(property.initializer, "EXECUTABLE_CLOSURE"));
    }
    const file = fields.get("file");
    const hashes = fields.get("hashes");
    const textHash = fields.get("textHash");
    if (typeof file !== "string" || files.has(file) || !Array.isArray(hashes) || hashes.length === 0 ||
      typeof textHash !== "string" || !/^[a-f0-9]{64}$/.test(textHash) ||
      hashes.some((hash: unknown) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error("EXECUTABLE_CLOSURE requires unique files and non-empty SHA-256 literals");
    }
    files.add(file);
  }
  return statement;
}

function closureText(source: ts.SourceFile, file: string): string {
  if (file !== CENSUS_PIN_FILE) return source.text;
  const table = assertClosurePinLiteral(source);
  return source.text.slice(0, table.getStart(source)) + "<REVIEWED_LITERAL_PIN_TABLE>" + source.text.slice(table.end);
}

export function assertStatementClosure(source: ts.SourceFile, file: string, half?: 0 | 1): void {
  if (half !== undefined && half !== 0 && half !== 1) throw new Error("Invalid closure statement half");
  // Git checkouts differ by line endings; ECMAScript normalizes CRLF in templates.
  // Keep every other token/escape and the existing fingerprint implementation.
  source = ts.createSourceFile(source.fileName, source.text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true);
  if (resolve(root, source.fileName) !== resolve(root, file)) throw new Error("EXECUTABLE_CLOSURE source identity mismatch");
  assertLoaderDirectives(source, file);
  const pin = (file === CENSUS_SUITE || file.startsWith(CENSUS_DIRECTORY + "/")
    ? EXECUTABLE_CLOSURE : EXTERNAL_CLOSURE).find(entry => entry.file === file);
  const statements = closureStatements(source, file);
  if (!pin || pin.hashes.length === 0 || statements.length !== pin.hashes.length) {
    throw new Error(file + ": EXECUTABLE_CLOSURE has missing or unpinned statements; review the executable inventory");
  }
  // Comments can instruct Vitest, Vite or the compiler. Pin them as input too.
  if (createHash("sha256").update(closureText(source, file)).digest("hex") !== pin.textHash) {
    throw new Error(file + ": EXECUTABLE_CLOSURE source text changed; review comments and compiler directives as well as statements");
  }
  for (const [index, statement] of statements.entries()) {
    if (half !== undefined && index % 2 !== half) continue;
    // Direct comparison deliberately does not trust a matcher the file could alter.
    if (navigationFingerprint(statement, source) !== pin.hashes[index]) {
      const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
      throw new Error(file + ":" + line + ": EXECUTABLE_CLOSURE changed statement " + index + "; review the body and rerun integrity mutants before updating its literal pin");
    }
  }
}

function assertLoaderDirectives(source: ts.SourceFile, file: string): void {
  // Vitest 4.1.9 detectCodeBlock scans raw test text, including quoted strings.
  // The exact regex categories below include environment options and module tags.
  const prefix = "// @" + "vitest-environment node\n";
  const nodeSuite = ["convex/supplierNavigation.scrum869.test.ts", CENSUS_SUITE].includes(file);
  const text = nodeSuite && source.text.startsWith(prefix) ? source.text.slice(prefix.length) : source.text;
  if (file.endsWith(".test.ts") && (/@(?:vitest|jest)-(?:environment|pool)\b/.test(text) ||
    new RegExp("(//|\\*)\\s*@" + "module-tag\\b").test(text))) {
    throw new Error(file + ": EXECUTABLE_CLOSURE refuses unreviewed loader directives");
  }
}
