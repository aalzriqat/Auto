import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLoopbackRelay, startCliRelay } from "./browserSwarmLoopbackRelay.mjs";

const privateHost = [10, 1, 2, 3].join(".");

describe("browser swarm loopback relay", () => {
  it("relays bytes in both directions and binds only to host loopback", async () => {
    const upstream = net.createServer((socket) => {
      socket.once("data", (data) => {
        assert.equal(data.toString(), "request");
        socket.end("response");
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert(upstreamAddress && typeof upstreamAddress !== "string");
    const { server, stop } = createLoopbackRelay({
      targetHost: privateHost,
      targetPort: 3000,
      listenPort: 0,
      connectUpstream: ({ host, port }: { host: string; port: number }) => {
        assert.equal(host, privateHost);
        assert.equal(port, 3000);
        return net.connect(upstreamAddress.port, "127.0.0.1");
      },
    });
    try {
      await once(server, "listening");
      const relayAddress = server.address();
      assert(relayAddress && typeof relayAddress !== "string");
      assert.equal(relayAddress.address, "127.0.0.1");
      const client = net.connect(relayAddress.port, "127.0.0.1");
      await once(client, "connect");
      client.write("request");
      const chunks: Buffer[] = [];
      for await (const chunk of client) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("response");
    } finally {
      stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects non-private targets before opening a server", () => {
    const publicHost = [203, 0, 113, 7].join(".");
    expect(() => createLoopbackRelay({ targetHost: publicHost, targetPort: 3000, listenPort: 0 })).toThrow(
      /private Docker IPv4 address/,
    );
    const script = path.resolve(process.cwd(), "scripts/intelligence/browserSwarmLoopbackRelay.mjs");
    for (const address of ["127.0.0.1", publicHost, "not-an-ip"]) {
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, CANDIDATE_DOCKER_IP: address },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/private Docker IPv4 address/);
    }
  });

  it("closes a refused upstream without exposing its network error", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { server, stop } = createLoopbackRelay({
      targetHost: privateHost,
      targetPort: 3000,
      listenPort: 0,
      connectUpstream: () => {
        const socket = new net.Socket();
        queueMicrotask(() => socket.emit("error", new Error("private network detail")));
        return socket;
      },
    });
    try {
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string");
      const client = net.connect(address.port, "127.0.0.1");
      await once(client, "close");
      expect(stderr).toHaveBeenCalledWith("Could not reach isolated candidate container.\n");
      expect(stderr.mock.calls.join(" ")).not.toContain("private network detail");
    } finally {
      stop();
      stderr.mockRestore();
    }
  });

  it("prints the readiness line only after the server is listening", () => {
    const previousExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const server = net.createServer();
    try {
      startCliRelay(privateHost, () => ({ server, stop: vi.fn() }));
      expect(stdout).not.toHaveBeenCalled();
      server.emit("error", new Error("bind failed"));
      expect(stderr).toHaveBeenCalledWith("Could not start isolated candidate relay.\n");
      expect(stdout).not.toHaveBeenCalled();
      server.emit("listening");
      expect(stdout).toHaveBeenCalledWith("relay-listening 127.0.0.1:3000\n");
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("exits 1 without a readiness line when port 3000 is already occupied", async () => {
    const impostor = net.createServer();
    impostor.listen(3000, "127.0.0.1");
    // If something else already holds 3000 the premise (occupied) holds anyway.
    await Promise.race([once(impostor, "listening"), once(impostor, "error")]).catch(() => undefined);
    try {
      const script = path.resolve(process.cwd(), "scripts/intelligence/browserSwarmLoopbackRelay.mjs");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, CANDIDATE_DOCKER_IP: privateHost },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("relay-listening");
    } finally {
      impostor.close();
    }
  });

  it("starts the CLI relay only for a private target and handles bind failure", () => {
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const server = net.createServer();
    const stop = vi.fn();
    const createRelay = vi.fn(() => ({ server, stop }));
    try {
      expect(startCliRelay(undefined, createRelay)).toBeNull();
      expect(createRelay).not.toHaveBeenCalled();
      process.exitCode = previousExitCode;
      expect(startCliRelay(privateHost, createRelay)).toEqual({ stop });
      expect(createRelay).toHaveBeenCalledWith({ targetHost: privateHost, targetPort: 3000, listenPort: 3000 });
      server.emit("error", new Error("private bind detail"));
      expect(stderr).toHaveBeenCalledWith("Could not start isolated candidate relay.\n");
      expect(stderr.mock.calls.join(" ")).not.toContain("private bind detail");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
    }
  });
});
