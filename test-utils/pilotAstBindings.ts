import ts from "typescript";

export function unwrap(expr: ts.Expression | undefined): ts.Expression | undefined {
  let current = expr;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))) {
    current = current.expression;
  }
  return current;
}

export function originalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && originalSymbol(symbol, checker);
}
