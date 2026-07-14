import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = join(rootDir, "apps", "mobile");
const androidDir = join(mobileDir, "android");
const signingPropertiesPath = join(androidDir, "release-signing.properties");

function parseEnvFile(filePath) {
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

function unwrapEnvValue(value) {
  const quote = value[0];
  const hasMatchingQuotes =
    value.length >= 2 && (quote === "\"" || quote === "'") && value[value.length - 1] === quote;

  return hasMatchingQuotes ? value.slice(1, -1) : value;
}

function getLocalEnv() {
  return [
    join(rootDir, ".env"),
    join(rootDir, ".env.local"),
    join(mobileDir, ".env"),
    join(mobileDir, ".env.local"),
  ].reduce((acc, filePath) => ({ ...acc, ...parseEnvFile(filePath) }), {});
}

function withMobilePublicEnv(baseEnv) {
  const env = { ...baseEnv };

  env.EXPO_PUBLIC_CONVEX_URL ||= env.NEXT_PUBLIC_CONVEX_URL;
  env.EXPO_PUBLIC_CONVEX_SITE_URL ||= env.NEXT_PUBLIC_CONVEX_SITE_URL;
  env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||= env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  env.EXPO_PUBLIC_APP_URL ||= env.NEXT_PUBLIC_APP_URL;
  env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ||= env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  env.EXPO_PUBLIC_APP_SCHEME ||= "autoflow";

  return env;
}

function getSpawnEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

function hostFor(value) {
  try {
    return new URL(value).host;
  } catch {
    return "invalid-url";
  }
}

function run(command, args, options = {}) {
  const commandToRun = process.platform === "win32" ? "cmd.exe" : command;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(commandToRun, commandArgs, {
    cwd: options.cwd ?? rootDir,
    env: options.env,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const args = new Set(process.argv.slice(2));
const allowTestClerk = args.has("--allow-test-clerk");
const noRerunTasks = args.has("--no-rerun-tasks");
const skipChecks = args.has("--skip-checks");
const fileEnv = getLocalEnv();
const env = withMobilePublicEnv({ ...fileEnv, ...process.env });
env.NODE_ENV ||= "production";
const androidStudioJbr = "C:\\Program Files\\Android\\Android Studio\\jbr";
if (process.platform === "win32" && !env.JAVA_HOME && existsSync(join(androidStudioJbr, "bin", "java.exe"))) {
  env.JAVA_HOME = androidStudioJbr;
}
const localAndroidSdk = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : "";
if (process.platform === "win32" && !env.ANDROID_HOME && localAndroidSdk && existsSync(localAndroidSdk)) {
  env.ANDROID_HOME = localAndroidSdk;
  env.ANDROID_SDK_ROOT ||= localAndroidSdk;
}
const missing = ["EXPO_PUBLIC_CONVEX_URL", "EXPO_PUBLIC_CONVEX_SITE_URL", "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "EXPO_PUBLIC_APP_URL"].filter(
  (key) => !env[key],
);

if (missing.length > 0) {
  console.error(`Missing mobile production env: ${missing.join(", ")}`);
  process.exit(1);
}

if (!existsSync(signingPropertiesPath)) {
  console.error("Missing Android release signing config: apps/mobile/android/release-signing.properties");
  process.exit(1);
}

if (!allowTestClerk && !env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith("pk_live_")) {
  console.error("Refusing production build with a non-live Clerk publishable key.");
  console.error("Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to a pk_live_ key.");
  console.error("For a temporary non-production artifact, rerun with --allow-test-clerk.");
  process.exit(1);
}

const spawnEnv = getSpawnEnv(env);
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const gradleBin = process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew";

console.log("Building AutoFlow Android production release");
console.log(`- Convex host: ${hostFor(env.EXPO_PUBLIC_CONVEX_URL)}`);
console.log(`- Convex HTTP Actions host: ${hostFor(env.EXPO_PUBLIC_CONVEX_SITE_URL)}`);
console.log(`- App host: ${hostFor(env.EXPO_PUBLIC_APP_URL)}`);
console.log(`- Clerk key mode: ${env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith("pk_live_") ? "live" : "test"}`);
console.log(`- Turnstile site key: ${env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ? "configured" : "missing"}`);
console.log(`- Signing config: ${statSync(signingPropertiesPath).size > 0 ? "configured" : "empty"}`);

if (!skipChecks) {
  run(pnpmBin, ["mobile:typecheck"], { env: spawnEnv });
  run(pnpmBin, ["mobile:test"], { env: spawnEnv });
}

const gradleTasks = noRerunTasks
  ? ["bundleRelease", "assembleRelease"]
  : ["--rerun-tasks", "bundleRelease", "assembleRelease"];
run(gradleBin, gradleTasks, {
  cwd: androidDir,
  env: spawnEnv,
});
