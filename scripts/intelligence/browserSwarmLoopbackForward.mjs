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

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer port in 1-65535`);
  }
  return port;
}

export function isPrivateIpv4(host) {
  return PRIVATE_IPV4.test(host) && host.split(".").every((part) => Number(part) <= 255);
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

function parseArgs(argv) {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await startLoopbackForward(options);
    console.log(
      `loopback forward 127.0.0.1:${options.listenPort} -> ${options.targetHost}:${options.targetPort}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "loopback forward failed");
    process.exit(1);
  }
}
