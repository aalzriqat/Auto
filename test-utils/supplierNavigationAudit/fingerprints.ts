import ts from "typescript";
import { createHash } from "node:crypto";

export function navigationStatementName(node: ts.Statement, source: ts.SourceFile): string {
  if (ts.isImportDeclaration(node)) return `import:${(node.moduleSpecifier as ts.StringLiteral).text}`;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => declaration.name.getText(source)).join(",");
  if (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name?.text ?? ts.SyntaxKind[node.kind];
  return ts.SyntaxKind[node.kind];
}

export function navigationTokens(node: ts.Node, source: ts.SourceFile): string[] {
  if (ts.isJSDoc(node)) return [];
  if (ts.isToken(node)) return [node.getText(source)];
  return node.getChildren(source).flatMap(child => navigationTokens(child, source));
}

export function navigationFingerprint(node: ts.Statement, source: ts.SourceFile): string {
  const printed = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Unspecified, node, source);
  const normalized = ts.createSourceFile(source.fileName, printed, ts.ScriptTarget.Latest, true);
  // Pin source tokens as well: the printer can normalize an omitted semicolon or an escaped identifier.
  // AST tokens preserve literal/template whitespace, while comments and formatting stay outside the hash.
  return createHash("sha256").update(JSON.stringify([navigationTokens(normalized, normalized), navigationTokens(node, source)])).digest("hex");
}
