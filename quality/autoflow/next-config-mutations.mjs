import ts from "typescript";

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function memberObject(expression) {
  const current = unwrapExpression(expression);
  return ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
    ? current.expression
    : undefined;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const expression = unwrapExpression(name.expression);
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : undefined;
}

function staticMemberName(expression, state) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (!ts.isElementAccessExpression(current)) return undefined;
  const argument = current.argumentExpression
    ? state.resolveAlias(current.argumentExpression, state.context)
    : undefined;
  return argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function pageExtensionsExpression(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

function collectExtensionArrays(expression, state) {
  const current = state.resolveAlias(expression, state.context);
  if (!current || !ts.isArrayLiteralExpression(current)) return;
  if (state.extensionArrays.has(current)) return;
  state.extensionArrays.add(current);
  for (const element of current.elements) {
    if (ts.isSpreadElement(element)) {
      collectExtensionArrays(element.expression, state);
    }
  }
}

function collectConfigObjects(objectLiteral, state) {
  if (state.configObjects.has(objectLiteral)) return;
  state.configObjects.add(objectLiteral);
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = state.resolveConfigObject(
        property.expression,
        state.context,
      );
      if (spread) collectConfigObjects(spread, state);
      continue;
    }
    if (staticPropertyName(property.name) !== "pageExtensions") continue;
    const expression = pageExtensionsExpression(property);
    if (expression) collectExtensionArrays(expression, state);
  }
}

function isConfigExpression(expression, state) {
  const object = state.resolveConfigObject(expression, state.context);
  return Boolean(object && state.configObjects.has(object));
}

function isExtensionArrayExpression(expression, state) {
  const current = state.resolveAlias(expression, state.context);
  if (current && state.extensionArrays.has(current)) return true;
  if (
    !current ||
    (!ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current))
  ) {
    return false;
  }
  return (
    staticMemberName(current, state) === "pageExtensions" &&
    Boolean(memberObject(current)) &&
    isConfigExpression(memberObject(current), state)
  );
}

function expressionTouchesProtectedValue(expression, state) {
  const seen = new Set();
  function touches(candidate) {
    let current = state.resolveAlias(candidate, state.context);
    if (!current) current = unwrapExpression(candidate);
    if (!current || seen.has(current)) return false;
    seen.add(current);
    if (
      isExtensionArrayExpression(current, state) ||
      isConfigExpression(current, state)
    ) {
      return true;
    }
    if (ts.isFunctionLike(current)) return false;
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.some((element) => {
        if (
          ts.isSpreadElement(element) &&
          isExtensionArrayExpression(element.expression, state)
        ) {
          return false;
        }
        return touches(element);
      });
    }
    let childTouches = false;
    ts.forEachChild(current, (child) => {
      if (!childTouches && touches(child)) childTouches = true;
    });
    return childTouches;
  }
  return touches(expression);
}

function variableDeclarationExposesProtectedValue(node, state) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) {
    return false;
  }
  if (ts.isIdentifier(node.name)) {
    const trackedInitializer = state.context.bindings.get(node.name.text);
    if (trackedInitializer === node.initializer) return false;
  }
  return expressionTouchesProtectedValue(node.initializer, state);
}

function controlFlowExposesProtectedValue(node, state) {
  let expression;
  if (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isYieldExpression(node)
  ) {
    expression = node.expression;
  } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    expression = node.expression;
  }
  return Boolean(
    expression && expressionTouchesProtectedValue(expression, state),
  );
}

function runtimeInitializerExposesProtectedValue(node, state) {
  const initializer =
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isPropertyDeclaration(node)
      ? node.initializer
      : undefined;
  return Boolean(
    initializer && expressionTouchesProtectedValue(initializer, state),
  );
}

function assignmentMutatesProtectedValue(node, state) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
    node.operatorToken.kind > ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  const left = unwrapExpression(node.left);
  if (
    !ts.isPropertyAccessExpression(left) &&
    !ts.isElementAccessExpression(left)
  ) {
    return false;
  }
  const owner = memberObject(left);
  if (owner && isExtensionArrayExpression(owner, state)) return true;
  if (
    Boolean(owner) &&
    isConfigExpression(owner, state) &&
    (staticMemberName(left, state) === undefined ||
      staticMemberName(left, state) === "pageExtensions")
  ) {
    return true;
  }
  const member = staticMemberName(left, state);
  return member === undefined || member === "pageExtensions";
}

function isModuleExportsTarget(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return (
      ts.isIdentifier(current.expression) &&
      current.expression.text === "module" &&
      current.name.text === "exports"
    );
  }
  if (!ts.isElementAccessExpression(current)) return false;
  const owner = unwrapExpression(current.expression);
  const member = current.argumentExpression
    ? unwrapExpression(current.argumentExpression)
    : undefined;
  return Boolean(
    ts.isIdentifier(owner) &&
    owner.text === "module" &&
    member &&
    (ts.isStringLiteral(member) ||
      ts.isNoSubstitutionTemplateLiteral(member)) &&
    member.text === "exports",
  );
}

function assignmentExposesProtectedValue(node, state) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    !isModuleExportsTarget(node.left) &&
    expressionTouchesProtectedValue(node.right, state)
  );
}

function unaryMutatesProtectedValue(node, state) {
  const target = ts.isDeleteExpression(node)
    ? node.expression
    : ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? node.operand
      : undefined;
  if (!target) return false;
  const current = unwrapExpression(target);
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return false;
  }
  const owner = memberObject(current);
  return Boolean(
    owner &&
    (isExtensionArrayExpression(owner, state) ||
      (isConfigExpression(owner, state) &&
        staticMemberName(current, state) === "pageExtensions")),
  );
}

function localFunctionDeclarations(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
        ? unwrapExpression(declaration.initializer)
        : undefined;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer))
      ) {
        declarations.set(declaration.name.text, initializer);
      }
    }
  }
  return declarations;
}

function localFunction(expression, state) {
  const current = state.resolveAlias(expression, state.context);
  if (
    current &&
    (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
  ) {
    return current;
  }
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped)
    ? state.localFunctions.get(unwrapped.text)
    : undefined;
}

function callsLocalFunction(call, state) {
  const callee = unwrapExpression(call.expression);
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
    return true;
  }
  return ts.isIdentifier(callee) && state.localFunctions.has(callee.text);
}

function expressionReferencesEval(expression, state, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (seen.has(current)) return false;
  seen.add(current);
  if (ts.isIdentifier(current)) {
    if (current.text === "eval") return true;
    const initializer = state.context.bindings.get(current.text);
    return Boolean(
      initializer && expressionReferencesEval(initializer, state, seen),
    );
  }
  if (staticMemberName(current, state) === "eval") return true;
  let referencesEval = false;
  ts.forEachChild(current, (child) => {
    if (!referencesEval && expressionReferencesEval(child, state, seen)) {
      referencesEval = true;
    }
  });
  return referencesEval;
}

const RUNTIME_LOADER_NAMES = new Set([
  "_load",
  "createRequire",
  "getBuiltinModule",
  "require",
]);

function expressionReferencesRuntimeLoader(
  expression,
  state,
  seen = new Set(),
) {
  const current = unwrapExpression(expression);
  if (seen.has(current)) return false;
  seen.add(current);
  if (current.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(current)) {
    if (RUNTIME_LOADER_NAMES.has(current.text)) return true;
    const initializer = state.context.bindings.get(current.text);
    return Boolean(
      initializer &&
      expressionReferencesRuntimeLoader(initializer, state, seen),
    );
  }
  const member = staticMemberName(current, state);
  if (member && RUNTIME_LOADER_NAMES.has(member)) return true;
  let referencesLoader = false;
  ts.forEachChild(current, (child) => {
    if (
      !referencesLoader &&
      expressionReferencesRuntimeLoader(child, state, seen)
    ) {
      referencesLoader = true;
    }
  });
  return referencesLoader;
}

function hasUnsupportedRuntimeImport(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) continue;
    if (importClause.name) return true;
    const bindings = importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) return true;
    const runtimeImports = bindings.elements.filter(
      (element) => !element.isTypeOnly,
    );
    if (runtimeImports.length === 0) continue;
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    const trustedSentryImport =
      moduleName === "@sentry/nextjs" &&
      runtimeImports.every(
        (element) =>
          (element.propertyName ?? element.name).text === "withSentryConfig",
      );
    if (!trustedSentryImport) return true;
  }
  return false;
}

export function hasSideEffectImport(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    const clause = statement.importClause;
    if (!clause) return true;
    return Boolean(
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length === 0,
    );
  });
}

function functionMutatesProtectedValue(functionNode, state) {
  if (state.functionMutations.has(functionNode)) {
    return state.functionMutations.get(functionNode);
  }
  if (state.checkingFunctions.has(functionNode)) return true;
  state.checkingFunctions.add(functionNode);
  let mutates = false;
  function visit(node) {
    if (mutates || (node !== functionNode && ts.isFunctionLike(node))) return;
    if (nodeCanMutateProtectedValue(node, state)) {
      mutates = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionNode);
  state.checkingFunctions.delete(functionNode);
  state.functionMutations.set(functionNode, mutates);
  return mutates;
}

function callCanMutateProtectedValue(call, state) {
  if (expressionReferencesEval(call.expression, state)) return true;
  if (expressionReferencesRuntimeLoader(call.expression, state)) return true;
  if (state.isConfigWrapperCall(call, state.context)) return false;
  if (callsLocalFunction(call, state)) return true;
  if (expressionTouchesProtectedValue(call.expression, state)) return true;
  return call.arguments.some((argument) => {
    if (expressionTouchesProtectedValue(argument, state)) return true;
    const callback = localFunction(argument, state);
    return Boolean(callback && functionMutatesProtectedValue(callback, state));
  });
}

function constructionCanMutateProtectedValue(node, state) {
  return Boolean(
    node.arguments?.some((argument) =>
      expressionTouchesProtectedValue(argument, state),
    ),
  );
}

function taggedTemplateCanMutateProtectedValue(node, state) {
  return (
    expressionTouchesProtectedValue(node.tag, state) ||
    expressionTouchesProtectedValue(node.template, state)
  );
}

function nodeCanMutateProtectedValue(node, state) {
  return (
    variableDeclarationExposesProtectedValue(node, state) ||
    controlFlowExposesProtectedValue(node, state) ||
    runtimeInitializerExposesProtectedValue(node, state) ||
    assignmentExposesProtectedValue(node, state) ||
    assignmentMutatesProtectedValue(node, state) ||
    unaryMutatesProtectedValue(node, state) ||
    (ts.isCallExpression(node) && callCanMutateProtectedValue(node, state)) ||
    (ts.isNewExpression(node) &&
      constructionCanMutateProtectedValue(node, state)) ||
    (ts.isTaggedTemplateExpression(node) &&
      taggedTemplateCanMutateProtectedValue(node, state))
  );
}

/** Rejects runtime operations that can change a statically resolved config. */
export function hasAmbiguousConfigMutation({
  sourceFile,
  context,
  configObject,
  resolveAlias,
  resolveConfigObject,
  isConfigWrapperCall,
}) {
  if (hasUnsupportedRuntimeImport(sourceFile)) return true;
  const state = {
    sourceFile,
    context,
    resolveAlias,
    resolveConfigObject,
    isConfigWrapperCall,
    configObjects: new Set(),
    extensionArrays: new Set(),
    localFunctions: localFunctionDeclarations(sourceFile),
    checkingFunctions: new Set(),
    functionMutations: new Map(),
  };
  collectConfigObjects(configObject, state);

  let ambiguous = false;
  function visit(node) {
    if (ambiguous) return;
    if (node !== sourceFile && ts.isFunctionLike(node)) {
      ambiguous = functionMutatesProtectedValue(node, state);
      return;
    }
    if (nodeCanMutateProtectedValue(node, state)) {
      ambiguous = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return ambiguous;
}
