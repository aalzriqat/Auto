import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { getLocalEnv, getSpawnEnv, mobileDir, rootDir, withMobilePublicEnv } from "./mobile-env.mjs";

const androidDir = join(mobileDir, "android");
const signingPropertiesPath = join(androidDir, "release-signing.properties");

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
