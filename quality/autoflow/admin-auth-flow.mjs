import ts from "typescript";

import {
  identifierName,
  memberName,
  memberObject,
  unwrapExpression,
} from "./ast-utils.mjs";
import { parameterInitializersAreInert } from "./admin-parameters.mjs";

function firstRuntimeStatement(block) {
  return block.statements.find(
    (statement) =>
      !ts.isEmptyStatement(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement),
  );
}

function authCall(expression, authContext) {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return false;
  if (authContext.adminBindings.isDirectAuthTarget(current.expression)) {
    return (
      current.arguments.length > 0 &&
      identifierName(current.arguments[0]) === authContext.ctxName
    );
  }

  if (memberName(current.expression) !== "runQuery") return false;
  const receiver = memberObject(current.expression);
  if (
    !receiver ||
    identifierName(receiver) !== authContext.ctxName ||
    current.arguments.length === 0
  ) {
    return false;
  }
  const reference = authContext.adminBindings.internalReference(
    current.arguments[0],
  );
  if (!reference) return false;
  return (
    reference.moduleName === authContext.currentModuleName &&
    authContext.delegatedAuthFunctions.has(reference.functionName)
  );
}

function awaitedAuthExpression(expression, authContext) {
  const current = unwrapExpression(expression);
  return (
    ts.isAwaitExpression(current) && authCall(current.expression, authContext)
  );
}

function firstRuntimeStatementTerminates(block) {
  const first = firstRuntimeStatement(block);
  return Boolean(
    first && (ts.isReturnStatement(first) || ts.isThrowStatement(first)),
  );
}

function isNullishOrFalse(expression) {
  if (!expression) return true;
  const current = unwrapExpression(expression);
  return (
    current.kind === ts.SyntaxKind.NullKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(current) && current.text === "undefined") ||
    (ts.isVoidExpression(current) && ts.isNumericLiteral(current.expression))
  );
}

function authFailureBlockTerminatesSafely(block) {
  const first = firstRuntimeStatement(block);
  if (!first) return false;
  if (ts.isThrowStatement(first)) return true;
  return ts.isReturnStatement(first) && isNullishOrFalse(first.expression);
}

function tryStatementAuthenticates(statement, authContext) {
  const first = firstRuntimeStatement(statement.tryBlock);
  if (!first || !statementAuthenticates(first, authContext)) return false;
  if (statement.finallyBlock && firstRuntimeStatement(statement.finallyBlock)) {
    return false;
  }
  return (
    !statement.catchClause ||
    authFailureBlockTerminatesSafely(statement.catchClause.block)
  );
}

function statementAuthenticates(statement, authContext) {
  if (ts.isTryStatement(statement)) {
    return tryStatementAuthenticates(statement, authContext);
  }
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    return (
      declarations.length === 1 &&
      Boolean(
        declarations[0].initializer &&
        awaitedAuthExpression(declarations[0].initializer, authContext),
      )
    );
  }
  if (ts.isExpressionStatement(statement)) {
    return awaitedAuthExpression(statement.expression, authContext);
  }
  return Boolean(
    ts.isReturnStatement(statement) &&
    statement.expression &&
    awaitedAuthExpression(statement.expression, authContext),
  );
}

function caughtAuthBinding(statement, authContext) {
  if (!ts.isVariableStatement(statement)) return undefined;
  const declarations = statement.declarationList.declarations;
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0].name)) {
    return undefined;
  }
  const initializer = declarations[0].initializer
    ? unwrapExpression(declarations[0].initializer)
    : undefined;
  if (!initializer || !ts.isAwaitExpression(initializer)) return undefined;
  const caughtCall = unwrapExpression(initializer.expression);
  const recovery = catchRecovery(caughtCall);
  if (!recovery) return undefined;
  const recoveryIsNullish = ts.isBlock(recovery.body)
    ? authFailureBlockTerminatesSafely(recovery.body)
    : isNullishOrFalse(recovery.body);
  if (!recoveryIsNullish) return undefined;
  const authPromise = memberObject(caughtCall.expression);
  return authPromise && authCall(authPromise, authContext)
    ? declarations[0].name.text
    : undefined;
}

function catchRecovery(caughtCall) {
  if (
    !ts.isCallExpression(caughtCall) ||
    memberName(caughtCall.expression) !== "catch"
  ) {
    return undefined;
  }
  const recovery = caughtCall.arguments[0];
  return recovery &&
    (ts.isArrowFunction(recovery) || ts.isFunctionExpression(recovery))
    ? recovery
    : undefined;
}

function isImmediateNullReturnGuard(statement, bindingName) {
  if (!ts.isIfStatement(statement)) return false;
  const condition = unwrapExpression(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    identifierName(condition.operand) !== bindingName
  ) {
    return false;
  }
  const guarded = statement.thenStatement;
  if (ts.isReturnStatement(guarded) || ts.isThrowStatement(guarded))
    return true;
  return ts.isBlock(guarded) && firstRuntimeStatementTerminates(guarded);
}

/** Proves that the handler's first runtime path performs super-admin auth. */
export function handlerAuthenticates(
  handler,
  adminBindings,
  delegatedAuthFunctions,
  currentModuleName,
) {
  if (!parameterInitializersAreInert(handler)) return false;
  const firstParameter = handler.parameters[0]?.name;
  if (!firstParameter || !ts.isIdentifier(firstParameter)) return false;
  const authContext = {
    ctxName: firstParameter.text,
    adminBindings,
    delegatedAuthFunctions,
    currentModuleName,
  };

  if (!handler.body) return false;
  if (!ts.isBlock(handler.body)) {
    return awaitedAuthExpression(handler.body, authContext);
  }
  const runtimeStatements = handler.body.statements.filter(
    (statement) =>
      !ts.isEmptyStatement(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement),
  );
  const first = runtimeStatements[0];
  if (!first) return false;
  if (statementAuthenticates(first, authContext)) return true;
  const bindingName = caughtAuthBinding(first, authContext);
  return Boolean(
    bindingName &&
    runtimeStatements[1] &&
    isImmediateNullReturnGuard(runtimeStatements[1], bindingName),
  );
}
