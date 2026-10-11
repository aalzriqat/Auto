import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLoopbackRelay } from "./browserSwarmLoopbackRelay.mjs";

test("relays bytes in both directions through host loopback", async () => {
  const upstream = net.createServer((socket) => {
    socket.once("data", (data) => {
      assert.equal(data.toString(), "request");
      socket.end("response");
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = upstream.address().port;
  const { server, stop } = createLoopbackRelay({
    targetHost: "127.0.0.1",
    targetPort: upstreamPort,
    listenPort: 0,
  });
  try {
    await once(server, "listening");
    assert.equal(server.address().address, "127.0.0.1");
    const client = net.connect(server.address().port, "127.0.0.1");
    await once(client, "connect");
    client.write("request");
    const chunks = [];
    for await (const chunk of client) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "response");
  } finally {
    stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("CLI refuses non-Docker targets", () => {
  const script = fileURLToPath(new URL("./browserSwarmLoopbackRelay.mjs", import.meta.url));
  for (const address of ["127.0.0.1", "8.8.8.8", "not-an-ip"]) {
    const result = spawnSync(process.execPath, [script, address], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, address);
    assert.match(result.stderr, /private Docker IPv4 address/, address);
  }
});
