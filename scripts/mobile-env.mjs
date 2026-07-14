import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const mobileDir = join(rootDir, "apps", "mobile");

export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  const content = readFileSync(filePath, "utf8");

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();
    values[key] = unwrapEnvValue(rawValue);
  }

  return values;
}

export function unwrapEnvValue(value) {
  const quote = value[0];
  const hasMatchingQuotes =
    value.length >= 2 && (quote === "\"" || quote === "'") && value[value.length - 1] === quote;

  return hasMatchingQuotes ? value.slice(1, -1) : value;
}

export function getLocalEnv() {
  return [
    join(rootDir, ".env"),
    join(rootDir, ".env.local"),
    join(mobileDir, ".env"),
    join(mobileDir, ".env.local"),
  ].reduce((acc, filePath) => ({ ...acc, ...parseEnvFile(filePath) }), {});
}

export function withMobilePublicEnv(baseEnv) {
  const env = { ...baseEnv };

  env.EXPO_PUBLIC_CONVEX_URL ||= env.NEXT_PUBLIC_CONVEX_URL;
  env.EXPO_PUBLIC_CONVEX_SITE_URL ||= env.NEXT_PUBLIC_CONVEX_SITE_URL;
  env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||= env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  env.EXPO_PUBLIC_APP_URL ||= env.NEXT_PUBLIC_APP_URL;
  env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ||= env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  env.EXPO_PUBLIC_APP_SCHEME ||= "autoflow";

  return env;
}

export function getSpawnEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}
