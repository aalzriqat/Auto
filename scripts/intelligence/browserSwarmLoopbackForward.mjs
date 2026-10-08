#!/usr/bin/env node
// Trusted host-side TCP forwarder for the isolated swarm candidate (SCRUM-376).
//
// The candidate runtime sits on `docker network create --internal` so it has no
// route out. Docker does not forward `--publish` ports for a container whose only
// network is internal, so the host could never reach a perfectly healthy server
// ("Failed to connect to 127.0.0.1 port 3000 after 0 ms"). Instead of giving the
// candidate a route, the trusted host listens on loopback and relays to the
// container's address on the internal network.
//
// It relays bytes only: it never parses, logs or stores payloads, binds loopback
// only, and accepts only a private IPv4 literal as its target.

import net from "node:net";
import { pathToFileURL } from "node:url";

const OCTET = /^(0|[1-9]\d{0,2})$/;

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer port in 1-65535`);
  }
  return port;
}

// RFC1918 only: 10/8, 172.16/12, 192.168/16. Canonical dotted-quad (no leading zeros).
export function isPrivateIpv4(host) {
  if (typeof host !== "string") return false;
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part))) return false;
  const [a, b, c, d] = parts.map(Number);
  if ([a, b, c, d].some((octet) => octet > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// `targetGuard` exists so a test can relay to a loopback echo server; the CLI
// always uses the private-IPv4 guard.
export async function startLoopbackForward(
  { listenPort, targetHost, targetPort },
  { targetGuard = isPrivateIpv4 } = {},
) {
  // listenPort 0 asks the OS for a free port; tests rely on it.
  if (listenPort !== 0) parsePort(listenPort, "listen port");
  parsePort(targetPort, "target port");
  if (!targetGuard(targetHost)) {
    throw new Error("target host must be a private IPv4 literal");
  }

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the candidate network must never be reachable from outside.
    server.listen({ host: "127.0.0.1", port: listenPort }, () => resolve(server));
  });
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`unexpected argument: ${key}`);
    }
    values.set(key.slice(2), argv[index + 1]);
  }
  for (const required of ["listen-port", "target-host", "target-port"]) {
    if (!values.has(required)) throw new Error(`missing --${required}`);
  }
  return {
    listenPort: parsePort(values.get("listen-port"), "listen port"), // CLI never uses 0
    targetHost: values.get("target-host"),
    targetPort: parsePort(values.get("target-port"), "target port"),
  };
}

// The ready line is printed only after the bind succeeded: the workflow waits for
// it, so a forwarder that failed to bind can never look started.
export async function runCli(argv, { log = console.log, error = console.error } = {}) {
  try {
    const options = parseArgs(argv);
    const server = await startLoopbackForward(options);
    log(`loopback forward 127.0.0.1:${options.listenPort} -> ${options.targetHost}:${options.targetPort}`);
    return { code: 0, server };
  } catch (failure) {
    error(failure instanceof Error ? failure.message : "loopback forward failed");
    return { code: 1, server: null };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code } = await runCli(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
