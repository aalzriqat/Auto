import { isMigrationOrSeedPath } from "./maintainability-paths.mjs";

const TEST_MODULE_PATTERN =
  /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

const FRAMEWORK_RUNTIME_PATTERN =
  /^(?:(?:src\/)?(?:instrumentation-client\.(?:[jt]sx?|mjs)|(?:instrumentation|middleware|proxy)\.[jt]sx?)|sentry\.(?:client|edge|server)\.config\.[jt]s)$/iu;
const APPLICATION_RUNTIME_DIRECTORY_PATTERN =
  /^(?:app|components|hooks|lib|convex|apps\/mobile|packages\/shared\/src|dealer-worker\/src|public)\//u;
const SHARED_FORBIDDEN_DIRECTORY_PATTERN =
  /^(?:app|components|hooks|lib|convex|apps\/mobile|dealer-worker\/src|public)\//u;
const AUDITED_SOURCE_DIRECTORY_PATTERN =
  /^(?:app|components|hooks|lib|convex|packages\/shared\/src|apps\/mobile\/(?:src|app)|dealer-worker\/src|public|quality)\//u;

function isFrameworkRuntimePath(modulePath, frameworkRuntimePaths) {
  return frameworkRuntimePaths === undefined
    ? FRAMEWORK_RUNTIME_PATTERN.test(modulePath)
    : frameworkRuntimePaths.has(modulePath);
}

function isApplicationRuntimePath(modulePath, frameworkRuntimePaths) {
  return (
    APPLICATION_RUNTIME_DIRECTORY_PATTERN.test(modulePath) ||
    isFrameworkRuntimePath(modulePath, frameworkRuntimePaths)
  );
}

function isSharedForbiddenTarget(modulePath, frameworkRuntimePaths) {
  return (
    SHARED_FORBIDDEN_DIRECTORY_PATTERN.test(modulePath) ||
    isFrameworkRuntimePath(modulePath, frameworkRuntimePaths)
  );
}

const BOUNDARY_RULES = Object.freeze([
  {
    id: "backend-no-presentation",
    message:
      "Convex backend code must not depend on web or mobile presentation code.",
    from: /^convex\//u,
    to: /^(?:app|components|hooks|apps\/mobile)\//u,
  },
  {
    id: "shared-package-independent",
    message: "@autoflow/shared must remain independent of application layers.",
    from: /^packages\/shared\/src\//u,
    to: isSharedForbiddenTarget,
  },
  {
    id: "routes-are-entrypoints",
    message:
      "Lower layers must not import modules from the Next.js app route tree.",
    from: /^(?:components|hooks|convex|packages\/shared\/src|apps\/mobile)\//u,
    to: /^app\//u,
  },
  {
    id: "mobile-no-web-or-backend",
    message:
      "The mobile application must not import web UI or Convex implementation modules.",
    from: /^apps\/mobile\//u,
    to: /^(?:app|components|hooks|convex)\//u,
  },
  {
    id: "web-no-mobile",
    message:
      "Web presentation modules must not import mobile application code.",
    from: /^(?:app|components|hooks)\//u,
    to: /^apps\/mobile\//u,
  },
  {
    id: "lower-layers-no-presentation",
    message:
      "Shared lower-layer and worker modules must not import presentation code.",
    from: /^(?:lib|dealer-worker\/src)\//u,
    to: /^(?:app|components|hooks|apps\/mobile)\//u,
  },
  {
    id: "quality-tooling-independent",
    message: "Quality tooling must not depend on application runtime modules.",
    from: /^quality\//u,
    to: isApplicationRuntimePath,
  },
  {
    id: "runtime-no-test-modules",
    message:
      "Production modules must not depend on files excluded from maintainability analysis as tests.",
    from: /.+/u,
    to: TEST_MODULE_PATTERN,
  },
  {
    id: "runtime-no-migration-modules",
    message:
      "Ordinary production modules must not depend on migration or seed files excluded from maintainability metrics; keep reusable runtime code in an audited production module.",
    from: (modulePath, frameworkRuntimePaths) =>
      isArchitectureAuditedPath(modulePath, frameworkRuntimePaths) &&
      !isMigrationOrSeedPath(modulePath),
    to: isMigrationOrSeedPath,
  },
  {
    id: "runtime-no-unscoped-modules",
    message:
      "Audited production modules must not depend on repository source outside the maintainability scope; move the dependency into an audited production root.",
    from: (modulePath, frameworkRuntimePaths) =>
      isArchitectureAuditedPath(modulePath, frameworkRuntimePaths),
    to: (modulePath, frameworkRuntimePaths) =>
      !isArchitectureAuditedPath(modulePath, frameworkRuntimePaths),
  },
]);

export function isArchitectureTestPath(modulePath) {
  return TEST_MODULE_PATTERN.test(modulePath);
}

export function isArchitectureAuditedPath(
  modulePath,
  frameworkRuntimePaths = undefined,
) {
  return (
    AUDITED_SOURCE_DIRECTORY_PATTERN.test(modulePath) ||
    isFrameworkRuntimePath(modulePath, frameworkRuntimePaths)
  );
}

function matches(matcher, modulePath, frameworkRuntimePaths) {
  return typeof matcher === "function"
    ? matcher(modulePath, frameworkRuntimePaths)
    : matcher.test(modulePath);
}

export function architectureBoundaryViolations(graph) {
  const violations = [];
  for (const edge of graph.edges) {
    if (isArchitectureTestPath(edge.from)) continue;
    for (const rule of BOUNDARY_RULES) {
      if (
        !matches(rule.from, edge.from, graph.frameworkRuntimePaths) ||
        !matches(rule.to, edge.to, graph.frameworkRuntimePaths)
      )
        continue;
      violations.push({
        kind: "FORBIDDEN ARCHITECTURE DEPENDENCY",
        rule: rule.id,
        from: edge.displayFrom,
        to: edge.displayTo,
        message: rule.message,
      });
    }
  }
  return violations;
}
