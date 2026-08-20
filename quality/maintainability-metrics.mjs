import { createHash } from "node:crypto";

import nextTypescriptConfigs from "eslint-config-next/typescript";

import {
  FILE_LINE_EXEMPTIONS,
  FUNCTION_LINE_EXEMPTIONS,
  THRESHOLDS,
  isProductionSource,
  normalizeRepositoryPath,
  normalizedInventory,
} from "./maintainability-paths.mjs";

const typescriptParser = nextTypescriptConfigs.find(
  (config) => config.languageOptions?.parser,
)?.languageOptions?.parser;

if (!typescriptParser?.parseForESLint) {
  throw new Error(
    "eslint-config-next/typescript did not expose the TypeScript parser.",
  );
}

export const PARSER_VERSION = typescriptParser.meta?.version ?? "unknown";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const NESTING_TYPES = new Set([
  "IfStatement",
  "SwitchStatement",
  "TryStatement",
  "DoWhileStatement",
  "WhileStatement",
  "WithStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
]);

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseSource(source, repositoryPath) {
  try {
    return typescriptParser.parseForESLint(source, {
      comment: true,
      ecmaVersion: "latest",
      filePath: repositoryPath,
      jsx: repositoryPath.endsWith("x"),
      loc: true,
      range: true,
      sourceType: "module",
      tokens: true,
    });
  } catch (error) {
    throw new Error(`Could not parse ${repositoryPath}: ${error.message}`, {
      cause: error,
    });
  }
}

function discoverFunctions(ast, visitorKeys) {
  const parents = new WeakMap();
  const functionNodes = [];
  function visit(node, parent) {
    if (parent) parents.set(node, parent);
    if (FUNCTION_TYPES.has(node.type)) functionNodes.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const member of child) if (member?.type) visit(member, node);
      } else if (child?.type) {
        visit(child, node);
      }
    }
  }
  visit(ast, null);
  return { parents, functionNodes };
}

function anchorPart(text) {
  return encodeURIComponent(String(text ?? "unknown"));
}

function propertyName(node) {
  if (!node) return "unknown";
  if (node.type === "Identifier" || node.type === "PrivateIdentifier")
    return node.name;
  if (node.type === "Literal") return String(node.value);
  return node.type;
}

function expressionName(node) {
  if (!node) return "unknown";
  if (node.type === "Identifier" || node.type === "PrivateIdentifier")
    return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "MemberExpression") {
    return `${expressionName(node.object)}.${propertyName(node.property)}`;
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return expressionName(node.expression);
  }
  return node.type;
}

function containingFunction(node, parents) {
  let current = parents.get(node);
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) return current;
    current = parents.get(current);
  }
  return null;
}

function assignmentRelation(node, parent) {
  if (parent.type === "VariableDeclarator" && parent.init === node) {
    return `binding:${anchorPart(expressionName(parent.id))}`;
  }
  if (parent.type === "AssignmentExpression" && parent.right === node) {
    return `assignment:${anchorPart(expressionName(parent.left))}`;
  }
  return null;
}

function propertyRelation(node, parent) {
  if (parent.type === "Property" && parent.value === node) {
    return `property:${anchorPart(propertyName(parent.key))}`;
  }
  if (
    (parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.value === node
  ) {
    return `method:${anchorPart(propertyName(parent.key))}`;
  }
  return null;
}

function callRelation(node, parent) {
  if (parent.type === "CallExpression") {
    const argumentIndex = parent.arguments.indexOf(node);
    if (argumentIndex >= 0) {
      return `call:${anchorPart(expressionName(parent.callee))}:arg${argumentIndex}`;
    }
  }
  return null;
}

function relationSegment(node, parent) {
  const structural =
    assignmentRelation(node, parent) ??
    propertyRelation(node, parent) ??
    callRelation(node, parent);
  if (structural) return structural;
  if (parent.type === "JSXAttribute" && parent.value === node) {
    return `jsx:${anchorPart(propertyName(parent.name))}`;
  }
  if (parent.type === "ExportDefaultDeclaration") return "export:default";
  if (parent.type === "ReturnStatement") return "return";
  return null;
}

function anchoredFunctions(functionNodes, parents) {
  const memo = new WeakMap();
  function baseAnchor(node) {
    const cached = memo.get(node);
    if (cached) return cached;
    const owner = containingFunction(node, parents);
    const prefix = owner ? `${baseAnchor(owner)}/` : "module/";
    if (node.id?.name) {
      const named = `${prefix}function:${anchorPart(node.id.name)}`;
      memo.set(node, named);
      return named;
    }
    const segments = [];
    let current = node;
    let parent = parents.get(current);
    while (parent && parent !== owner) {
      const segment = relationSegment(current, parent);
      if (segment) segments.push(segment);
      current = parent;
      parent = parents.get(current);
    }
    const role = segments.length
      ? segments.reverse().join("/")
      : `anonymous:${node.type}`;
    const anonymous = `${prefix}${role}`;
    memo.set(node, anonymous);
    return anonymous;
  }

  const candidates = functionNodes.map((node) => ({
    node,
    base: baseAnchor(node),
  }));
  const totals = new Map();
  const seen = new Map();
  for (const candidate of candidates) {
    totals.set(candidate.base, (totals.get(candidate.base) ?? 0) + 1);
  }
  return candidates.map(({ node, base }) => {
    if (totals.get(base) === 1) return { node, anchor: base };
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { node, anchor: `${base}~${occurrence}` };
  });
}

function commentLines(comments) {
  const lines = new Map();
  for (const comment of comments) {
    for (
      let line = comment.loc.start.line;
      line <= comment.loc.end.line;
      line += 1
    ) {
      lines.set(line, comment);
    }
  }
  return lines;
}

function fullLineComment(line, lineNumber, comment) {
  if (!comment) return false;
  const startsLine =
    comment.loc.start.line < lineNumber ||
    !line.slice(0, comment.loc.start.column).trim();
  const endsLine =
    comment.loc.end.line > lineNumber ||
    !line.slice(comment.loc.end.column).trim();
  return startsLine && endsLine;
}

function relevantLines(sourceLines, commentsByLine, startLine, endLine) {
  let count = 0;
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = sourceLines[lineNumber - 1] ?? "";
    if (/^\s*$/u.test(line)) continue;
    if (fullLineComment(line, lineNumber, commentsByLine.get(lineNumber)))
      continue;
    count += 1;
  }
  return count;
}

function effectiveFunctionNode(node, parents) {
  const parent = parents.get(node);
  if (parent?.value !== node) return node;
  if (parent.type === "MethodDefinition") return parent;
  if (
    parent.type === "Property" &&
    (parent.method === true || parent.kind === "get" || parent.kind === "set")
  ) {
    return parent;
  }
  return node;
}

const COMPLEXITY_NODE_TYPES = new Set([
  "CatchClause",
  "ConditionalExpression",
  "LogicalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "IfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "AssignmentPattern",
]);

function addsComplexity(node) {
  if (COMPLEXITY_NODE_TYPES.has(node.type)) return true;
  if (node.type === "SwitchCase") return Boolean(node.test);
  if (node.type === "AssignmentExpression") {
    return ["&&=", "||=", "??="].includes(node.operator);
  }
  return (
    (node.type === "MemberExpression" || node.type === "CallExpression") &&
    node.optional === true
  );
}

function increasesNesting(node, parent) {
  if (!NESTING_TYPES.has(node.type)) return false;
  return !(
    node.type === "IfStatement" &&
    parent?.type === "IfStatement" &&
    parent.alternate === node
  );
}

function childNodes(node, visitorKeys) {
  const children = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (Array.isArray(value)) {
      children.push(...value.filter((member) => member?.type));
    } else if (value?.type) {
      children.push(value);
    }
  }
  return children;
}

function complexityAndNesting(functionNode, visitorKeys) {
  let complexity = 1;
  let maximumNesting = 0;
  function visit(node, parent, nesting) {
    if (node !== functionNode && FUNCTION_TYPES.has(node.type)) return;
    if (addsComplexity(node)) complexity += 1;
    let childNesting = nesting;
    if (increasesNesting(node, parent)) {
      childNesting += 1;
      maximumNesting = Math.max(maximumNesting, childNesting);
    }
    for (const child of childNodes(node, visitorKeys)) {
      visit(child, node, childNesting);
    }
  }
  visit(functionNode, null, 0);
  return { complexity, nesting: maximumNesting };
}

function firstTokenIndex(tokens, startOffset) {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle].range[0] < startOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalizedTokens(tokens, range, selfName = null) {
  const normalized = [];
  let index = firstTokenIndex(tokens, range[0]);
  while (index < tokens.length && tokens[index].range[1] <= range[1]) {
    const token = tokens[index];
    const tokenValue =
      selfName && token.type === "Identifier" && token.value === selfName
        ? "$SELF"
        : token.value;
    normalized.push(`${token.type}:${tokenValue}`);
    index += 1;
  }
  return normalized;
}

function paramCount(node) {
  const firstParam = node.params[0];
  const voidThis =
    firstParam?.type === "Identifier" &&
    firstParam.name === "this" &&
    firstParam.typeAnnotation?.typeAnnotation?.type === "TSVoidKeyword";
  return node.params.length - (voidThis ? 1 : 0);
}

export function analyzeSource(source, inputPath) {
  const repositoryPath = normalizeRepositoryPath(inputPath);
  const parsed = parseSource(source, repositoryPath);
  const { ast, visitorKeys } = parsed;
  const tokens = ast.tokens ?? [];
  const sourceLines = source.split(/\r\n|\n|\r/u);
  const commentsByLine = commentLines(ast.comments ?? []);
  const { parents, functionNodes } = discoverFunctions(ast, visitorKeys);
  const functions = anchoredFunctions(functionNodes, parents).map(
    ({ node, anchor }) => {
      const effectiveNode = effectiveFunctionNode(node, parents);
      const structureTokens = normalizedTokens(
        tokens,
        node.range,
        node.id?.name,
      );
      return {
        anchor,
        semanticHash: sha256(structureTokens.join("\u0000")),
        structureTokens,
        metrics: {
          lines: relevantLines(
            sourceLines,
            commentsByLine,
            effectiveNode.loc.start.line,
            effectiveNode.loc.end.line,
          ),
          ...complexityAndNesting(node, visitorKeys),
          params: paramCount(node),
        },
      };
    },
  );
  const structureTokens = normalizedTokens(tokens, ast.range);
  return {
    path: repositoryPath,
    semanticHash: sha256(structureTokens.join("\u0000")),
    structureTokens,
    metrics: {
      lines: relevantLines(sourceLines, commentsByLine, 1, sourceLines.length),
    },
    functions,
  };
}

export function analyzeSourceEntries(sourceEntries, scopeOptions = undefined) {
  const inventory = normalizedInventory(
    sourceEntries.map((entry) => entry.path),
  );
  const sourceByOriginalPath = new Map(
    sourceEntries.map((entry) => [entry.path, entry.source]),
  );
  const files = [];
  for (const { originalPath, repositoryPath } of inventory) {
    if (!isProductionSource(repositoryPath, scopeOptions)) continue;
    const source = sourceByOriginalPath.get(originalPath);
    if (typeof source !== "string")
      throw new Error(`Source text is missing for ${originalPath}`);
    files.push(analyzeSource(source, repositoryPath));
  }
  return { files };
}

export function functionViolationMetrics(repositoryPath, metrics) {
  const violations = {};
  if (
    metrics.lines > THRESHOLDS.functionLines &&
    !FUNCTION_LINE_EXEMPTIONS.has(repositoryPath)
  ) {
    violations.lines = metrics.lines;
  }
  if (metrics.complexity > THRESHOLDS.complexity)
    violations.complexity = metrics.complexity;
  if (metrics.nesting > THRESHOLDS.nesting)
    violations.nesting = metrics.nesting;
  if (metrics.params > THRESHOLDS.params) violations.params = metrics.params;
  return violations;
}

export function fileViolationMetrics(file) {
  if (
    file.metrics.lines > THRESHOLDS.fileLines &&
    !FILE_LINE_EXEMPTIONS.has(file.path)
  ) {
    return { lines: file.metrics.lines };
  }
  return {};
}

function tokenShingles(tokens) {
  if (tokens.length < 4) return new Map([[tokens.join("\u0000"), 1]]);
  const shingles = new Map();
  for (let index = 0; index <= tokens.length - 4; index += 1) {
    const shingle = tokens.slice(index, index + 4).join("\u0000");
    shingles.set(shingle, (shingles.get(shingle) ?? 0) + 1);
  }
  return shingles;
}

export function structuralSimilarity(leftTokens, rightTokens) {
  if (!leftTokens.length && !rightTokens.length) return 1;
  const left = tokenShingles(leftTokens);
  const right = tokenShingles(rightTokens);
  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of left.values()) leftCount += count;
  for (const count of right.values()) rightCount += count;
  for (const [shingle, count] of left) {
    intersection += Math.min(count, right.get(shingle) ?? 0);
  }
  return (2 * intersection) / (leftCount + rightCount);
}

export function thresholdFor(entity, metric) {
  if (entity === "file" && metric === "lines") return THRESHOLDS.fileLines;
  if (metric === "lines") return THRESHOLDS.functionLines;
  return THRESHOLDS[metric];
}

export function debtCounts(analysis) {
  const counts = {
    files: analysis.files.length,
    oversizedFiles: 0,
    oversizedFunctions: 0,
    complexFunctions: 0,
    deeplyNestedFunctions: 0,
    overParameterizedFunctions: 0,
  };
  for (const file of analysis.files) {
    if (Object.keys(fileViolationMetrics(file)).length)
      counts.oversizedFiles += 1;
    for (const fn of file.functions) {
      const metrics = functionViolationMetrics(file.path, fn.metrics);
      if (metrics.lines) counts.oversizedFunctions += 1;
      if (metrics.complexity) counts.complexFunctions += 1;
      if (metrics.nesting) counts.deeplyNestedFunctions += 1;
      if (metrics.params) counts.overParameterizedFunctions += 1;
    }
  }
  return counts;
}
