import { spawn } from "node:child_process";

import { getLocalEnv, getSpawnEnv, rootDir, withMobilePublicEnv } from "./mobile-env.mjs";

function getForwardedArgs() {
  const args = process.argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
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

child.on("error", (error) => {
  console.error(`Failed to start mobile dev server: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }

  process.exit(code ?? 1);
});
