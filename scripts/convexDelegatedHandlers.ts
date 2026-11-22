import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const WRITE_BUILDERS = new Set(["mutation", "internalMutation", "socialBulkMutation"]);

/**
 * A direct delegation keeps the registered validator at the entry and passes
 * the same context and arguments to one imported function. Recover its body
 * so moving it out of the registration cannot hide existing caller-ID writes.
 * Other callback shapes and transitive calls remain outside this check.
 */
export function directImportedHandlerBodies(file: string, source: string): Map<string, string> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { module: string; name: string }>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!module.startsWith(".") || clause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      imports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
    }
  }

  const handlers = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !call || !ts.isCallExpression(call)) continue;
      if (!ts.isIdentifier(call.expression) || !WRITE_BUILDERS.has(call.expression.text)) continue;
      const options = call.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) continue;
      const handler = options.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "handler"
      )?.initializer;
      if (!handler || !ts.isArrowFunction(handler) || !ts.isCallExpression(handler.body)) continue;
      const { expression, arguments: forwarded } = handler.body;
      if (!ts.isIdentifier(expression) || handler.parameters.length !== 2 || forwarded.length !== 2) continue;
      if (!handler.parameters.every((parameter, index) =>
        ts.isIdentifier(parameter.name) && parameter.name.getText(parsed) === forwarded[index]?.getText(parsed)
      )) continue;
      const imported = imports.get(expression.text);
      if (!imported) continue;

      const target = path.resolve(path.dirname(file), imported.module.replace(/\.js$/, ""));
      const targetFile = [target + ".ts", path.join(target, "index.ts")].find((candidate) => fs.existsSync(candidate));
      if (!targetFile) continue;
      const implementation = ts.createSourceFile(targetFile, fs.readFileSync(targetFile, "utf8"), ts.ScriptTarget.Latest, true);
      const operation = implementation.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === imported.name &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      );
      if (!operation?.body || operation.parameters[0]?.name.getText(implementation) !== "ctx" ||
        operation.parameters[1]?.name.getText(implementation) !== "args") continue;
      handlers.set(declaration.name.text, operation.body.getText(implementation));
    }
  }
  return handlers;
}
