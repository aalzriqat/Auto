import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function directForwardedCall(handler: ts.Expression): ts.Identifier | undefined {
  if (!ts.isArrowFunction(handler) || !ts.isCallExpression(handler.body)) return undefined;
  const { expression, arguments: forwarded } = handler.body;
  if (!ts.isIdentifier(expression) || handler.parameters.length !== 2 || forwarded.length !== 2) return undefined;
  const forwardsBothParameters = handler.parameters.every((parameter, index) => {
    const argument = forwarded[index];
    return ts.isIdentifier(parameter.name) && argument && ts.isIdentifier(argument) &&
      parameter.name.text === argument.text;
  });
  return forwardsBothParameters ? expression : undefined;
}

const BUILDERS = new Set([
  "query", "internalQuery", "mutation", "internalMutation", "socialBulkMutation", "action", "internalAction",
]);

/**
 * A direct delegation keeps the registered validator at the entry and passes
 * the same context and arguments to one imported function. Recover its body
 * so moving it out of the registration cannot hide the checks and writes it runs.
 * Other callback shapes and transitive calls remain outside this check.
 */
export function directImportedHandlers(file: string, source: string): Map<string, ts.Block> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { module: string; name: string }>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!modulePath.startsWith(".") || clause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      imports.set(element.name.text, { module: modulePath, name: (element.propertyName ?? element.name).text });
    }
  }

  const handlers = new Map<string, ts.Block>();
  const implementations = new Map<string, ts.SourceFile>();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !call || !ts.isCallExpression(call)) continue;
      if (!ts.isIdentifier(call.expression) || !BUILDERS.has(call.expression.text)) continue;
      const options = call.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) continue;
      const handler = options.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "handler"
      )?.initializer;
      const delegated = handler && directForwardedCall(handler);
      const imported = delegated && imports.get(delegated.text);
      if (!imported) continue;

      const target = path.resolve(path.dirname(file), imported.module.replace(/\.js$/, ""));
      const targetFile = [target + ".ts", path.join(target, "index.ts")].find((candidate) => fs.existsSync(candidate));
      if (!targetFile) continue;
      let implementation = implementations.get(targetFile);
      if (!implementation) {
        implementation = ts.createSourceFile(targetFile, fs.readFileSync(targetFile, "utf8"), ts.ScriptTarget.Latest, true);
        implementations.set(targetFile, implementation);
      }
      const operation = implementation.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === imported.name &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      );
      if (!operation?.body || operation.parameters[0]?.name.getText(implementation) !== "ctx" ||
        operation.parameters[1]?.name.getText(implementation) !== "args") continue;
      handlers.set(declaration.name.text, operation.body);
    }
  }
  return handlers;
}
