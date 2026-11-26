// SCRUM-1005: the real side effects of the runner (filesystem, process, network)
// and the file run as a command. The in-process verdict tests are in
// runPublicSurface.run.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realDeps } from "./runPublicSurface.mjs";

function serve(status: (url: string) => number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = status(req.url ?? "");
      if (res.statusCode === 302) res.setHeader("location", "/elsewhere");
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const portOf = (server: Server): number => {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
};

const close = (server: Server) =>
  new Promise((resolve) => server.close(resolve));

describe("the file as a command", () => {
  it("really runs when invoked directly: a production URL is refused with exit 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bombadil-cli-"));
    try {
      const child = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/bombadil/runPublicSurface.mjs"),
          "--base-url",
          "https://www.autoflowdealer.com",
          "--out-dir",
          dir,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
      );
      expect(child.status).toBe(1);
      const verdict = JSON.parse(
        readFileSync(path.join(dir, "verdict.json"), "utf8"),
      );
      expect(verdict.verdict).toBe("CANNOT_RUN");
      // The platform check runs before the host check, so on Windows (no bundled
      // binary) the refusal is the platform one; either way nothing was explored.
      expect(verdict.reason).toMatch(
        /production host|no bundled Bombadil binary/,
      );
      expect(verdict.entries).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("realDeps", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  it("writes through the real filesystem helpers", () => {
    const nested = path.join(tempDir("bombadil-run-"), "a", "b");
    realDeps.mkdir(nested);
    const file = path.join(nested, "verdict.json");
    realDeps.write(file, "{}\n");
    expect(realDeps.exists(file)).toBe(true);
    expect(realDeps.exists(path.join(nested, "missing"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });

  it("removes a file and tolerates a missing one", () => {
    const file = path.join(tempDir("bombadil-rm-"), "trace-home.bin");
    realDeps.write(file, "old");
    realDeps.remove(file);
    expect(realDeps.exists(file)).toBe(false);
    expect(() => realDeps.remove(file)).not.toThrow();
  });

  it("spawns a real process and captures its output", () => {
    const out = realDeps.spawn(process.execPath, ["-e", "console.log('hi')"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(String(out.stdout).trim()).toBe("hi");
  });

  it("reports health as the status code, or undefined when unreachable", async () => {
    const server = await serve((url) => (url === "/api/health" ? 200 : 404));
    try {
      expect(
        await realDeps.fetchStatus(`http://127.0.0.1:${portOf(server)}`),
      ).toBe(200);
    } finally {
      await close(server);
    }
    expect(await realDeps.fetchStatus("http://127.0.0.1:1")).toBeUndefined();
  });

  it("does not follow a redirect from the health URL", async () => {
    // The /elsewhere target answers 200: following the redirect would hide it.
    const server = await serve((url) => (url === "/api/health" ? 302 : 200));
    try {
      expect(
        await realDeps.fetchStatus(`http://127.0.0.1:${portOf(server)}`),
      ).toBe(302);
    } finally {
      await close(server);
    }
  });

  it("logs to the console", () => {
    const seen: unknown[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void seen.push(...a);
    try {
      realDeps.log("line");
    } finally {
      console.log = original;
    }
    expect(seen).toEqual(["line"]);
  });
});
