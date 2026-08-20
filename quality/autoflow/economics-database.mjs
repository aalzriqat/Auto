import ts from "typescript";

import {
  memberObject,
  propertyNameText,
  staticString,
  unwrapExpression,
} from "./ast-utils.mjs";

const DATABASE_OPERATIONS = new Set(["get", "patch", "replace"]);

export function staticMemberName(expression, values) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, values);
  }
  return undefined;
}

export function canonicalExpression(expression, values, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return current.text;
    const resolved = values.resolveAt(current.text, current);
    if (!resolved || resolved === current) return current.text;
    return canonicalExpression(
      resolved,
      values,
      new Set([...seen, current.text]),
    );
  }
  if (ts.isPropertyAccessExpression(current)) {
    const owner = canonicalExpression(current.expression, values, seen);
    return owner ? `${owner}.${current.name.text}` : undefined;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const owner = canonicalExpression(current.expression, values, seen);
    const name = staticString(current.argumentExpression, values);
    return owner && name !== undefined ? `${owner}.${name}` : undefined;
  }
  return current.getText().replaceAll(/\s+/g, "");
}

function addMapEntry(map, key, value) {
  if (!key || value === undefined || map.has(key)) return false;
  map.set(key, value);
  return true;
}

function databaseKeyFor(expression, state) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return state.databases.get(current.text);
  const contained = immutableMemberValue(current, state);
  if (contained) return databaseKeyFor(contained, state);
  if (staticMemberName(current, state.values) !== "db") return undefined;
  const owner = memberObject(current);
  const ownerKey = owner ? canonicalExpression(owner, state.values) : undefined;
  return ownerKey ? `${ownerKey}.db` : undefined;
}

function resolvedObjectLiteral(expression, state, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(current)) return current;
  if (!ts.isIdentifier(current) || seen.has(current.text)) return undefined;
  const resolved = state.values.resolveAt(current.text, current);
  return resolved
    ? resolvedObjectLiteral(resolved, state, new Set([...seen, current.text]))
    : undefined;
}

function immutableMemberValue(expression, state) {
  const current = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return undefined;
  }
  const object = resolvedObjectLiteral(current.expression, state);
  const name = staticMemberName(current, state.values);
  const property = object?.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) ||
        ts.isShorthandPropertyAssignment(candidate)) &&
      propertyNameText(candidate.name, state.values) === name,
  );
  if (property && ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  return property && ts.isShorthandPropertyAssignment(property)
    ? property.name
    : undefined;
}

function memberDatabaseMethod(expression, state) {
  const operation = staticMemberName(expression, state.values);
  if (!DATABASE_OPERATIONS.has(operation)) return undefined;
  const receiver = memberObject(expression);
  const databaseKey = receiver ? databaseKeyFor(receiver, state) : undefined;
  return databaseKey ? { operation, databaseKey } : undefined;
}

function boundDatabaseMethod(initializer, state) {
  if (!ts.isCallExpression(initializer)) return undefined;
  if (staticMemberName(initializer.expression, state.values) !== "bind") {
    return undefined;
  }
  const methodExpression = memberObject(initializer.expression);
  const method = methodExpression
    ? databaseMethod(methodExpression, state)
    : undefined;
  const boundDatabase = initializer.arguments[0]
    ? databaseKeyFor(initializer.arguments[0], state)
    : undefined;
  return method && boundDatabase === method.databaseKey
    ? { ...method, receiverBound: true }
    : undefined;
}

function bindIdentifierDatabase(node, initializer, state) {
  if (!ts.isIdentifier(node.name)) return false;
  let changed = addMapEntry(
    state.databases,
    node.name.text,
    databaseKeyFor(initializer, state),
  );
  const directMethod = memberDatabaseMethod(initializer, state);
  changed = addMapEntry(state.methods, node.name.text, directMethod) || changed;
  const boundMethod = boundDatabaseMethod(initializer, state);
  changed = addMapEntry(state.methods, node.name.text, boundMethod) || changed;
  const alias = ts.isIdentifier(initializer)
    ? state.methods.get(initializer.text)
    : undefined;
  return addMapEntry(state.methods, node.name.text, alias) || changed;
}

function destructuredMember(element, sourceKey, state) {
  const operation = propertyNameText(
    element.propertyName ?? element.name,
    state.values,
  );
  const key = sourceKey && operation ? `${sourceKey}.${operation}` : undefined;
  return {
    operation,
    key,
    databaseKey: operation === "db" ? key : undefined,
  };
}

function bindPatternIdentifier(element, member, sourceDatabase, state) {
  let changed = false;
  if (member.databaseKey) {
    changed = addMapEntry(
      state.databases,
      element.name.text,
      member.databaseKey,
    );
  }
  if (sourceDatabase && DATABASE_OPERATIONS.has(member.operation)) {
    changed =
      addMapEntry(state.methods, element.name.text, {
        operation: member.operation,
        databaseKey: sourceDatabase,
      }) || changed;
  }
  return changed;
}

function bindPatternElement(element, sourceKey, sourceDatabase, state) {
  if (element.dotDotDotToken) return false;
  const member = destructuredMember(element, sourceKey, state);
  if (ts.isObjectBindingPattern(element.name)) {
    return bindObjectPattern(
      element.name,
      member.key,
      member.databaseKey ?? sourceDatabase,
      state,
    );
  }
  if (!ts.isIdentifier(element.name)) return false;
  return bindPatternIdentifier(element, member, sourceDatabase, state);
}

function bindObjectPattern(pattern, sourceKey, sourceDatabase, state) {
  let changed = false;
  for (const element of pattern.elements) {
    changed =
      bindPatternElement(element, sourceKey, sourceDatabase, state) || changed;
  }
  return changed;
}

function bindDestructuredDatabase(node, initializer, state) {
  if (!ts.isObjectBindingPattern(node.name)) return false;
  return bindObjectPattern(
    node.name,
    canonicalExpression(initializer, state.values),
    databaseKeyFor(initializer, state),
    state,
  );
}

function bindDatabaseDeclaration(node, state) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return false;
  const initializer = unwrapExpression(node.initializer);
  return (
    bindIdentifierDatabase(node, initializer, state) ||
    bindDestructuredDatabase(node, initializer, state)
  );
}

export function createDatabaseBindings(sourceFile, values) {
  const state = {
    values,
    databases: new Map([["db", "db"]]),
    methods: new Map(),
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      changed = bindDatabaseDeclaration(node, state) || changed;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    databases: state.databases,
    methods: state.methods,
    databaseKey: (expression) => databaseKeyFor(expression, state),
  };
}

function databaseMethod(expression, state) {
  const current = unwrapExpression(expression);
  const direct = ts.isIdentifier(current)
    ? state.methods.get(current.text)
    : memberDatabaseMethod(current, state);
  if (direct || !ts.isCallExpression(current)) return direct;
  return (
    reflectedDatabaseMethod(current, state) ??
    boundDatabaseMethod(current, state)
  );
}

function resolvedArray(expression, values, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(current)) return current;
  if (!ts.isIdentifier(current) || seen.has(current.text)) return undefined;
  const resolved = values.resolveAt(current.text, current);
  return resolved
    ? resolvedArray(resolved, values, new Set([...seen, current.text]))
    : undefined;
}

function normalizedArguments(argumentsList, values) {
  const normalized = [];
  for (const argument of argumentsList) {
    if (!ts.isSpreadElement(argument)) {
      normalized.push(argument);
      continue;
    }
    const tuple = resolvedArray(argument.expression, values);
    if (!tuple || tuple.elements.some(ts.isSpreadElement)) return undefined;
    normalized.push(...tuple.elements);
  }
  return normalized;
}

function isReflectOperation(expression, operation, state) {
  const key = canonicalExpression(expression, state.values);
  return (
    key === `Reflect.${operation}` ||
    key === `globalThis.Reflect.${operation}` ||
    key === `global.Reflect.${operation}`
  );
}

function reflectedDatabaseMethod(call, state) {
  if (!isReflectOperation(call.expression, "get", state)) return undefined;
  const operation = call.arguments[1]
    ? staticString(call.arguments[1], state.values)
    : undefined;
  const databaseKey = call.arguments[0]
    ? databaseKeyFor(call.arguments[0], state)
    : undefined;
  return operation && DATABASE_OPERATIONS.has(operation) && databaseKey
    ? { operation, databaseKey }
    : undefined;
}

function arrayInvocationArguments(expression, values) {
  const tuple = resolvedArray(expression, values);
  return tuple ? normalizedArguments([...tuple.elements], values) : undefined;
}

function reflectedInvocation(call, state) {
  if (!isReflectOperation(call.expression, "apply", state)) return undefined;
  const method = call.arguments[0]
    ? databaseMethod(call.arguments[0], state)
    : undefined;
  const receiverKey = call.arguments[1]
    ? databaseKeyFor(call.arguments[1], state)
    : undefined;
  if (
    !method ||
    (!method.receiverBound && receiverKey !== method.databaseKey)
  ) {
    return undefined;
  }
  const effective = call.arguments[2]
    ? arrayInvocationArguments(call.arguments[2], state.values)
    : undefined;
  return { ...method, arguments: effective };
}

function functionPrototypeOperation(expression, state) {
  const key = canonicalExpression(expression, state.values);
  const prefixes = ["Function", "globalThis.Function", "global.Function"];
  for (const prefix of prefixes) {
    if (key === `${prefix}.prototype.call.call`) return "call";
    if (key === `${prefix}.prototype.apply.call`) return "apply";
  }
  return undefined;
}

function functionPrototypeInvocation(call, state) {
  const operation = functionPrototypeOperation(call.expression, state);
  if (!operation) return undefined;
  const method = call.arguments[0]
    ? databaseMethod(call.arguments[0], state)
    : undefined;
  const receiverKey = call.arguments[1]
    ? databaseKeyFor(call.arguments[1], state)
    : undefined;
  if (
    !method ||
    (!method.receiverBound && receiverKey !== method.databaseKey)
  ) {
    return undefined;
  }
  const effective =
    operation === "call"
      ? normalizedArguments(call.arguments.slice(2), state.values)
      : call.arguments[2]
        ? arrayInvocationArguments(call.arguments[2], state.values)
        : undefined;
  return { ...method, arguments: effective };
}

function abstractInvocation(call, state) {
  const reflected = reflectedInvocation(call, state);
  if (reflected) return reflected;
  const prototypal = functionPrototypeInvocation(call, state);
  if (prototypal) return prototypal;
  const callee = unwrapExpression(call.expression);
  const operation = staticMemberName(callee, state.values);
  if (operation !== "call" && operation !== "apply") return undefined;
  const invoked = memberObject(callee);
  const method = invoked ? databaseMethod(invoked, state) : undefined;
  const receiverKey = call.arguments[0]
    ? databaseKeyFor(call.arguments[0], state)
    : undefined;
  if (
    !method ||
    (!method.receiverBound && receiverKey !== method.databaseKey)
  ) {
    return undefined;
  }
  const effective =
    operation === "call"
      ? normalizedArguments(call.arguments.slice(1), state.values)
      : call.arguments[1]
        ? arrayInvocationArguments(call.arguments[1], state.values)
        : undefined;
  return { ...method, arguments: effective };
}

export function databaseCall(call, analysis) {
  const callee = unwrapExpression(call.expression);
  const state = { ...analysis.databaseBindings, values: analysis.values };
  const direct = databaseMethod(callee, state);
  const invocation = direct
    ? {
        ...direct,
        arguments: normalizedArguments(call.arguments, analysis.values),
      }
    : abstractInvocation(call, state);
  return invocation ? { ...invocation, call } : undefined;
}
