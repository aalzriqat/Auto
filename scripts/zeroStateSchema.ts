import ts from "typescript";

const schemaFile = "convex/schema.ts";

function refuse(reason: string): never {
  throw new Error(`Cannot enumerate the repository schema tables: ${reason}`);
}

/** The explicit table names in the default Convex schema export. */
export function schemaTableNames(text: string): string[] {
  const { diagnostics } = ts.transpileModule(text, {
    fileName: schemaFile,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    refuse("invalid TypeScript");
  }

  const source = ts.createSourceFile(schemaFile, text, ts.ScriptTarget.Latest, true);
  const defaults = source.statements.filter(ts.isExportAssignment);
  const assignment = defaults[0];
  if (defaults.length !== 1 || !assignment || assignment.isExportEquals) {
    refuse("expected one default schema export");
  }

  const call = assignment.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "defineSchema") {
    refuse("the default export must call defineSchema");
  }
  const tables = call.arguments[0];
  if (!tables || !ts.isObjectLiteralExpression(tables) || tables.properties.length === 0) {
    refuse("defineSchema requires a non-empty inline table registry");
  }

  const names = new Set<string>();
  for (const table of tables.properties) {
    if (
      (!ts.isPropertyAssignment(table) && !ts.isShorthandPropertyAssignment(table)) ||
      (!ts.isIdentifier(table.name) && !ts.isStringLiteral(table.name))
    ) {
      refuse("the registry contains a table name that is not a literal");
    }
    if (names.has(table.name.text)) refuse(`duplicate table: ${table.name.text}`);
    names.add(table.name.text);
  }
  return [...names];
}
