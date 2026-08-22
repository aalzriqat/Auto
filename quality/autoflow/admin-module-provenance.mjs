import path from "node:path";

import { normalizePath, withoutModuleExtension } from "./ast-utils.mjs";

const TRUSTED_ADMIN_MODULES = Object.freeze({
  api: "convex/_generated/api",
  functions: "convex/functions",
  server: "convex/_generated/server",
  tenancy: "convex/utils/tenancy",
});

function canonicalLocalModule(file, specifier) {
  const normalizedSpecifier = normalizePath(specifier);
  if (
    !normalizedSpecifier.startsWith("./") &&
    !normalizedSpecifier.startsWith("../")
  ) {
    return undefined;
  }
  const sourceDirectory = path.posix.dirname(normalizePath(file));
  return path.posix.normalize(
    path.posix.join(
      sourceDirectory,
      withoutModuleExtension(normalizedSpecifier),
    ),
  );
}

export function isTrustedAdminModule(file, specifier, kind) {
  return canonicalLocalModule(file, specifier) === TRUSTED_ADMIN_MODULES[kind];
}
