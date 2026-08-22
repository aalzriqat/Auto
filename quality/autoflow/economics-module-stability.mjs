import ts from "typescript";

import { unwrapExpression } from "./ast-utils.mjs";

const ASSIGNMENT_OPERATORS = new Set(
  Array.from(
    {
      length: ts.SyntaxKind.LastAssignment - ts.SyntaxKind.FirstAssignment + 1,
    },
    (_, index) => ts.SyntaxKind.FirstAssignment + index,
  ),
);

function updateExpression(node) {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function eagerEffect(node) {
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isSpreadElement(node) ||
    ts.isSpreadAssignment(node) ||
    ts.isDeleteExpression(node) ||
    updateExpression(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) &&
    ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
  );
}

function initializerHasEffect(initializer) {
  let found = false;
  const visit = (node) => {
    if (found || ts.isFunctionLike(node)) return;
    if (eagerEffect(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(unwrapExpression(initializer));
  return found;
}

function variableEffects(statement) {
  return statement.declarationList.declarations.some(
    (declaration) =>
      declaration.initializer &&
      (!ts.isIdentifier(declaration.name) ||
        initializerHasEffect(declaration.initializer)),
  );
}

function statementHasEffect(statement) {
  if (
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  ) {
    return false;
  }
  if (ts.isVariableStatement(statement)) return variableEffects(statement);
  if (ts.isExportAssignment(statement)) {
    return initializerHasEffect(statement.expression);
  }
  return true;
}

/** Whether module initialization executes code beyond passive declarations. */
export function moduleHasExecutableEffects(record) {
  return record.sourceFile.statements.some(statementHasEffect);
}
