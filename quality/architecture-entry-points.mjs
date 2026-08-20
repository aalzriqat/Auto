import {
  DEFAULT_NEXT_PAGE_EXTENSIONS,
  nextFrameworkRuntimePaths,
} from "./autoflow/next-runtime-entries.mjs";

export const ARCHITECTURE_DIRECTORY_ENTRY_POINTS = Object.freeze([
  "app",
  "components",
  "hooks",
  "lib",
  "convex",
  "packages/shared/src",
  "apps/mobile/src",
  "apps/mobile/app",
  "dealer-worker/src",
  "public",
  "quality",
]);

const SENTRY_RUNTIME_ENTRY_POINTS = Object.freeze([
  "sentry.client.config.js",
  "sentry.client.config.ts",
  "sentry.edge.config.js",
  "sentry.edge.config.ts",
  "sentry.server.config.js",
  "sentry.server.config.ts",
]);

export function architectureFrameworkRuntimePaths(pageExtensions) {
  return [
    ...nextFrameworkRuntimePaths(pageExtensions),
    ...SENTRY_RUNTIME_ENTRY_POINTS,
  ];
}

export function architectureEntryPoints(pageExtensions) {
  return [
    ...ARCHITECTURE_DIRECTORY_ENTRY_POINTS,
    ...architectureFrameworkRuntimePaths(pageExtensions),
  ];
}

export const ARCHITECTURE_ENTRY_POINTS = Object.freeze(
  architectureEntryPoints(DEFAULT_NEXT_PAGE_EXTENSIONS),
);
