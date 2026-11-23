import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function readSource(file: string) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

export function readFinanceDealCostCommands(file: string, source = readFileSync(file, "utf8")) {
  const entry = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const modules = new Map<string, ts.SourceFile>();
  const imports = new Map<string, { file: string; exportedName: string }>();
  for (const statement of entry.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const file = path.resolve(path.dirname(entry.fileName), statement.moduleSpecifier.text + ".ts");
    const relativeDirectory = path.relative(path.dirname(entry.fileName), file);
    if (!relativeDirectory.startsWith(path.join("utils", "financeDealCosts") + path.sep)) continue;
    for (const binding of bindings.elements) {
      imports.set(binding.name.text, { file, exportedName: binding.propertyName?.text ?? binding.name.text });
    }
  }

  const commands = new Map<string, { builder: string; registration: string; body: ts.Block }>();
  if (imports.size === 0) return commands;
  for (const statement of entry.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const registration = declaration.initializer;
      if (!registration || !ts.isCallExpression(registration) || !ts.isIdentifier(registration.expression)) continue;
      const builder = registration.expression.text;
      if (builder !== "mutation" && builder !== "query") continue;
      const [options] = registration.arguments;
      if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("Expected inline cost mutation options");
      const handler = options.properties.find((option) => option.name?.getText(entry) === "handler");
      if (!handler || !ts.isPropertyAssignment(handler) || !ts.isArrowFunction(handler.initializer)) {
        throw new Error("Expected a cost mutation handler in " + declaration.name.getText(entry));
      }

      const call = handler.initializer.body;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) ||
        call.arguments[0]?.getText(entry) !== "ctx" || call.arguments[1]?.getText(entry) !== "args") {
        throw new Error("Cannot trace cost mutation handler " + declaration.name.getText(entry));
      }
      const target = imports.get(call.expression.text);
      if (!target) {
        throw new Error("Cannot resolve cost mutation command " + call.expression.text);
      }

      const command = modules.get(target.file) ?? readSource(target.file);
      modules.set(target.file, command);
      const implementation = command.statements.find(
        (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === target.exportedName,
      );
      if (!implementation?.body || !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
        implementation.parameters[0]?.name.getText(command) !== "ctx" ||
        implementation.parameters[1]?.name.getText(command) !== "args") {
        throw new Error("Cannot trace cost mutation parameters to " + target.exportedName);
      }
      commands.set(declaration.name.getText(entry), { builder, registration: statement.getText(entry), body: implementation.body });
    }
  }
  return commands;
}

export function readEconomicCommandSourceLines(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (path.basename(file) !== "financeDealCosts.ts") return source.split(/\r?\n/);
  return [...readFinanceDealCostCommands(file, source).values()]
    .map(({ registration, body }) => registration + "\n" + body.getText())
    .join("\n")
    .split(/\r?\n/);
}

const ACCOUNTING_PARAMETER = "accounting";

/** The concrete imports supplied by the registered cost module to its commands. */
export function readFinanceAccountingBindings(file: string, source: string) {
  const entry = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { module: string; name: string }>();
  for (const statement of entry.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!specifier.startsWith("./") || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue;
      imports.set(binding.name.text, {
        module: path.posix.normalize(specifier).replace(/\.[jt]s$/, ""),
        name: binding.propertyName?.text ?? binding.name.text,
      });
    }
  }

  const accounting = new Map<string, { module: string; name: string }>();
  for (const statement of entry.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const constFlag = statement.declarationList.flags & ts.NodeFlags.Const;
    if (constFlag !== ts.NodeFlags.Const) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== ACCOUNTING_PARAMETER) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isObjectLiteralExpression(initializer) || initializer.properties.length === 0) {
        throw new Error("Finance accounting dependencies must be a non-empty object literal");
      }
      for (const property of initializer.properties) {
        const name = ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer ? property.name.text : undefined;
        const imported = name && imports.get(name);
        if (!name || !imported || accounting.has(name)) throw new Error("Finance accounting dependency must resolve to a unique import");
        accounting.set(name, imported);
      }
    }
  }
  return accounting;
}

/** Recognize method calls on the typed accounting parameter of a cost command. */
export function readFinanceAccountingCalls(file: string, source: string) {
  const ownership = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls = new Map<string, Set<string>>();
  for (const statement of ownership.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const parameter = statement.parameters.at(-1);
    if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== ACCOUNTING_PARAMETER ||
        parameter.type?.getText(ownership) !== "DealCostAccounting") continue;
    const methods = new Set<string>();
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === ACCOUNTING_PARAMETER) {
        methods.add(node.expression.name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(statement.body);
    if (methods.size > 0) calls.set(statement.name.text, methods);
  }
  return calls;
}
