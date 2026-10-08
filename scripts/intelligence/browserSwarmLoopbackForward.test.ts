import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateIpv4, startLoopbackForward } from "./browserSwarmLoopbackForward.mjs";

const cliPath = path.resolve(__dirname, "browserSwarmLoopbackForward.mjs");
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen({ host: "127.0.0.1", port: 0 }, () =>
      resolve((server.address() as net.AddressInfo).port),
    ),
  );
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

const allowLoopbackForTest = (host: string) => host === "127.0.0.1";

describe("SCRUM-376 loopback forwarder for the internal-network candidate", () => {
  it("relays bytes both ways to the target", async () => {
    const echo = net.createServer((socket) =>
      socket.on("data", (data) => socket.write(`echo:${data}`)),
    );
    const targetPort = await listen(echo);
    // Control: the target answers directly.
    expect(await roundTrip(targetPort, "direct")).toBe("echo:direct");

    const forward = await startLoopbackForward(
      { listenPort: 0, targetHost: "127.0.0.1", targetPort },
      { targetGuard: allowLoopbackForTest },
    );
    servers.push(forward);
    const forwardPort = (forward.address() as net.AddressInfo).port;
    expect(await roundTrip(forwardPort, "via-forwarder")).toBe("echo:via-forwarder");
  });

  it("closes the client when the target is unreachable instead of hanging", async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    servers.splice(servers.indexOf(closed), 1);

    const forward = await startLoopbackForward(
      { listenPort: 0, targetHost: "127.0.0.1", targetPort: deadPort },
      { targetGuard: allowLoopbackForTest },
    );
    servers.push(forward);
    const forwardPort = (forward.address() as net.AddressInfo).port;
    // The client is dropped (reset or closed) rather than left hanging.
    const outcome = await roundTrip(forwardPort, "hello").catch((error: NodeJS.ErrnoException) => error.code);
    expect(["", "ECONNRESET"]).toContain(outcome);
  });

  it("only accepts private IPv4 literals as targets", async () => {
    for (const host of ["10.1.2.3", "172.16.0.2", "172.31.255.254", "192.168.1.9"]) {
      expect(isPrivateIpv4(host), host).toBe(true);
    }
    for (const host of [
      "8.8.8.8",
      "localhost",
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.999",
      "172.32.0.1",
      "example.com",
      "10.0.0.1.evil.test",
    ]) {
      expect(isPrivateIpv4(host), host).toBe(false);
      await expect(
        startLoopbackForward({ listenPort: 0, targetHost: host, targetPort: 3000 }),
      ).rejects.toThrow(/private IPv4/);
    }
  });

  it("CLI exits 1 with an error when the port is already taken (no silent half-start)", async () => {
    const occupant = net.createServer();
    const port = await listen(occupant);
    const result = spawnSync(
      process.execPath,
      [cliPath, "--listen-port", String(port), "--target-host", "10.255.255.1", "--target-port", "3000"],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("loopback forward");
    expect(result.stderr).toMatch(/EADDRINUSE/);
  });

  it("CLI prints the ready line only after binding, and rejects an empty target", async () => {
    const empty = spawnSync(
      process.execPath,
      [cliPath, "--listen-port", "39127", "--target-host", "", "--target-port", "3000"],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(empty.status).toBe(1);
    expect(empty.stdout).toBe("");

    const child = spawn(
      process.execPath,
      [cliPath, "--listen-port", "39128", "--target-host", "10.255.255.1", "--target-port", "3000"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ready line")), 15000);
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(String(chunk));
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("forwarder exited before ready"));
        });
      });
      expect(line).toMatch(/^loopback forward 127\.0\.0\.1:39128 -> 10\.255\.255\.1:3000/);
    } finally {
      child.kill();
    }
  });

  it("rejects invalid target ports and listens on loopback only", async () => {
    await expect(
      startLoopbackForward({ listenPort: 0, targetHost: "10.0.0.2", targetPort: 70000 }),
    ).rejects.toThrow(/port/);
    const forward = await startLoopbackForward({
      listenPort: 0,
      targetHost: "10.255.255.1",
      targetPort: 3000,
    });
    servers.push(forward);
    expect((forward.address() as net.AddressInfo).address).toBe("127.0.0.1");
  });
});
