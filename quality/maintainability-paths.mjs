import {
  DEFAULT_NEXT_PAGE_EXTENSIONS,
  NEXT_CONFIG_FILES,
  SUPPORTED_NEXT_PAGE_EXTENSIONS,
  nextFrameworkRuntimePaths,
} from "./autoflow/next-runtime-entries.mjs";

export const THRESHOLDS = Object.freeze({
  fileLines: 600,
  functionLines: 120,
  complexity: 15,
  nesting: 4,
  params: 5,
});

export const STRUCTURAL_SIMILARITY_FLOOR = 0.6;
export const DEFAULT_BASELINE_PATH = "quality/baselines/maintainability.json";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/iu;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

const ROOT_RUNTIME_FILES = new Set([
  ...nextFrameworkRuntimePaths(DEFAULT_NEXT_PAGE_EXTENSIONS),
  "sentry.client.config.js",
  "sentry.client.config.ts",
  "sentry.edge.config.js",
  "sentry.edge.config.ts",
  "sentry.server.config.js",
  "sentry.server.config.ts",
]);

const ROOT_RUNTIME_IDENTITIES = new Set(
  [...ROOT_RUNTIME_FILES].map((repositoryPath) => repositoryPath.toLowerCase()),
);

const MIGRATION_AND_SEED_FILES = new Set([
  "convex/accountingMigration.ts",
  "convex/migrateCommissionAccruals.ts",
  "convex/migrateConsignedSaleBasis.ts",
  "convex/migrateExpenseReversals.ts",
  "convex/migrateFinancingEconomics.ts",
  "convex/migrateMarketplacePublicIds.ts",
  "convex/migrateMarketplaceStatuses.ts",
  "convex/migrateRoles.ts",
  "convex/migrations.ts",
  "convex/seedDocuments.ts",
]);

const MIGRATION_AND_SEED_IDENTITIES = new Set(
  [...MIGRATION_AND_SEED_FILES].map((repositoryPath) =>
    repositoryPath.toLowerCase(),
  ),
);

const GENERATED_FILES = new Set([
  "convex/_generated/api.d.ts",
  "convex/_generated/api.js",
  "convex/_generated/dataModel.d.ts",
  "convex/_generated/server.d.ts",
  "convex/_generated/server.js",
]);

const I18N_DATA_FILES = new Set(
  [
    "chat",
    "common",
    "customers",
    "dashboard",
    "expenses",
    "leads",
    "marketplace",
    "messages",
    "notifications",
    "payroll",
    "reports",
    "sales",
    "settings",
    "socialInbox",
    "socialSmartReply",
    "vehicles",
  ].map((name) => `lib/i18n/domains/${name}.ts`),
);

export const FILE_LINE_EXEMPTIONS = new Set([
  "convex/schema.ts",
  "apps/mobile/src/convexApi.ts",
  "apps/mobile/src/features/workspace/modules/moduleStyles.ts",
  "packages/shared/src/i18n.ts",
  ...I18N_DATA_FILES,
]);

export const FUNCTION_LINE_EXEMPTIONS = new Set([
  "apps/mobile/src/features/workspace/modules/moduleStyles.ts",
]);

export const SCOPE_DESCRIPTOR = Object.freeze({
  pathIdentity: "case-insensitive",
  roots: [
    "app/**",
    "components/**",
    "hooks/**",
    "lib/**",
    "convex/**",
    "apps/mobile/app/**",
    "apps/mobile/src/**",
    "packages/shared/src/**",
    "dealer-worker/src/**",
    "public/**",
    "quality/**",
  ],
  rootRuntimeFiles: [...ROOT_RUNTIME_FILES].sort(),
  nextRuntimeConfig: {
    configFiles: [...NEXT_CONFIG_FILES],
    defaultPageExtensions: [...DEFAULT_NEXT_PAGE_EXTENSIONS],
    supportedPageExtensions: [...SUPPORTED_NEXT_PAGE_EXTENSIONS],
  },
  migrationsAndSeeds: [...MIGRATION_AND_SEED_FILES].sort(),
  generatedFiles: [...GENERATED_FILES].sort(),
  fileLineExemptions: [...FILE_LINE_EXEMPTIONS].sort(),
  functionLineExemptions: [...FUNCTION_LINE_EXEMPTIONS].sort(),
});

export function normalizeRepositoryPath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("Repository paths must be non-empty strings.");
  }
  if (/[\0\r\n]/u.test(inputPath)) {
    throw new Error(
      `Repository path contains a control character: ${inputPath}`,
    );
  }

  let normalized = inputPath.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.normalize("NFC");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.endsWith("/")
  ) {
    throw new Error(`Repository path must be relative: ${inputPath}`);
  }

  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Repository path is not canonical: ${inputPath}`);
  }
  return normalized;
}

export function normalizedInventory(rawPaths) {
  const exactPaths = new Map();
  const caseFoldedPaths = new Map();
  for (const rawPath of rawPaths) {
    const repositoryPath = normalizeRepositoryPath(rawPath);
    const exactOwner = exactPaths.get(repositoryPath);
    if (exactOwner !== undefined) {
      throw new Error(
        `PATH COLLISION: ${exactOwner} and ${rawPath} normalize to ${repositoryPath}`,
      );
    }
    const foldedPath = repositoryPath.toLowerCase();
    const foldedOwner = caseFoldedPaths.get(foldedPath);
    if (foldedOwner !== undefined) {
      throw new Error(
        `PATH CASE COLLISION: ${foldedOwner} and ${rawPath} are not portable`,
      );
    }
    exactPaths.set(repositoryPath, rawPath);
    caseFoldedPaths.set(foldedPath, rawPath);
  }
  return [...exactPaths]
    .map(([repositoryPath, originalPath]) => ({ repositoryPath, originalPath }))
    .sort((left, right) =>
      left.repositoryPath.localeCompare(right.repositoryPath),
    );
}

function configuredRootRuntimeIdentities(options) {
  if (!options?.frameworkRuntimePaths) return ROOT_RUNTIME_IDENTITIES;
  return new Set(
    [
      ...options.frameworkRuntimePaths,
      "sentry.client.config.js",
      "sentry.client.config.ts",
      "sentry.edge.config.js",
      "sentry.edge.config.ts",
      "sentry.server.config.js",
      "sentry.server.config.ts",
    ].map((repositoryPath) =>
      normalizeRepositoryPath(repositoryPath).toLowerCase(),
    ),
  );
}

export function isProductionRoot(repositoryPath, options = undefined) {
  const identity = normalizeRepositoryPath(repositoryPath).toLowerCase();
  return (
    /^(?:app|components|hooks|lib|convex)\//u.test(identity) ||
    /^apps\/mobile\/(?:app|src)\//u.test(identity) ||
    /^packages\/shared\/src\//u.test(identity) ||
    /^dealer-worker\/src\//u.test(identity) ||
    /^public\//u.test(identity) ||
    /^quality\//u.test(identity) ||
    configuredRootRuntimeIdentities(options).has(identity)
  );
}

export function isMigrationOrSeedPath(repositoryPath) {
  return MIGRATION_AND_SEED_IDENTITIES.has(
    normalizeRepositoryPath(repositoryPath).toLowerCase(),
  );
}

export function isWholeFileExcluded(repositoryPath) {
  return (
    TEST_FILE.test(repositoryPath) ||
    repositoryPath.includes("/__tests__/") ||
    GENERATED_FILES.has(repositoryPath) ||
    isMigrationOrSeedPath(repositoryPath)
  );
}

export function isProductionSource(repositoryPath, options = undefined) {
  return (
    SOURCE_EXTENSION.test(repositoryPath) &&
    isProductionRoot(repositoryPath, options) &&
    !isWholeFileExcluded(repositoryPath)
  );
}

export function inventoryProductionPaths(rawPaths, options = undefined) {
  return normalizedInventory(rawPaths)
    .filter(({ repositoryPath }) => isProductionSource(repositoryPath, options))
    .map(({ repositoryPath }) => repositoryPath);
}
