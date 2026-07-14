import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = join(rootDir, "apps", "mobile");

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

function getForwardedArgs() {
  const args = process.argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}

function getSpawnEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

const fileEnv = getLocalEnv();
const env = withMobilePublicEnv({ ...fileEnv, ...process.env });
const missing = ["EXPO_PUBLIC_CONVEX_URL", "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"].filter(
  (key) => !env[key],
);

if (missing.length > 0) {
  console.error(`Missing mobile env: ${missing.join(", ")}`);
  process.exit(1);
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = [
  "--dir",
  "apps/mobile",
  "exec",
  "expo",
  "start",
  "--dev-client",
  "--host",
  "localhost",
  ...getForwardedArgs(),
];
const command = process.platform === "win32" ? "cmd.exe" : pnpmBin;
const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", pnpmBin, ...args] : args;

const child = spawn(command, commandArgs, {
  cwd: rootDir,
  env: getSpawnEnv(env),
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }

  process.exit(code ?? 1);
});
