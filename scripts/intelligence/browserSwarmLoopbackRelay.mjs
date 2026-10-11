import net from "node:net";
import { pathToFileURL } from "node:url";

function privateIpv4(address) {
  if (typeof address !== "string" || net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Forward trusted host loopback traffic to one isolated Docker bridge address. */
export function createLoopbackRelay({ targetHost, targetPort, listenPort, connectUpstream = (options) => net.connect(options) }) {
  if (!privateIpv4(targetHost)) throw new Error("Relay requires a private Docker IPv4 address.");
  const peers = new Set();
  let upstreamErrorReported = false;
  const server = net.createServer((client) => {
    const upstream = connectUpstream({ host: targetHost, port: targetPort });
    peers.add(client);
    peers.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", () => {
      if (!upstreamErrorReported) {
        process.stderr.write("Could not reach isolated candidate container.\n");
        upstreamErrorReported = true;
      }
      close();
    });
    client.on("close", () => peers.delete(client));
    upstream.on("close", () => peers.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 256;
  const stop = () => {
    for (const peer of peers) peer.destroy();
    server.close();
  };
  server.listen(listenPort, "127.0.0.1");
  return { server, stop };
}

export function startCliRelay(targetHost, createRelay = createLoopbackRelay) {
  if (!privateIpv4(targetHost)) {
    process.stderr.write("Relay requires a private Docker IPv4 address.\n");
    process.exitCode = 1;
    return null;
  } else {
    const { server, stop } = createRelay({ targetHost, targetPort: 3000, listenPort: 3000 });
    // The workflow waits for exactly this line before it trusts port 3000.
    server.on("listening", () => {
      process.stdout.write("relay-listening 127.0.0.1:3000\n");
    });
    server.on("error", () => {
      process.stderr.write("Could not start isolated candidate relay.\n");
      process.exitCode = 1;
    });
    return { stop };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = startCliRelay(process.env.CANDIDATE_DOCKER_IP);
  if (relay) process.on("SIGTERM", relay.stop);
}
