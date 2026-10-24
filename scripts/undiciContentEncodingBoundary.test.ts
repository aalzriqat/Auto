import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const shadcnRequire = createRequire(realpathSync("node_modules/shadcn/package.json"));

// Isolate the vulnerable dependency's process-level failure from the test runner.
const boundary = String.raw`
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { gzipSync } = require('node:zlib');
const { fetch, Agent } = require(process.argv[1]);
const dispatcher = new Agent({ connections: 1 });
const body = gzipSync('ordinary response');
const server = createServer((request, response) => {
  if (request.url === '/ordinary') {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
    response.end(body);
  } else {
    response.writeHead(200, { 'content-encoding': 'gzip,gzip,gzip,gzip,gzip,gzip', 'content-length': 100, connection: 'close' });
    response.flushHeaders();
    response.end();
  }
});
(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal(await (await fetch(origin + '/ordinary', { dispatcher })).text(), 'ordinary response');
    await assert.rejects(fetch(origin + '/excessive', { dispatcher }));
    // Let stream errors surface after the caught fetch rejection.
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('ordinary-decoded; excessive-rejected; process-survived');
  } finally {
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

test("shadcn Undici rejects excessive encodings without an unhandled stream error", () => {
  const child = spawnSync(process.execPath, ["-e", boundary, shadcnRequire.resolve("undici")], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("ordinary-decoded; excessive-rejected; process-survived");
}, 8_000);
