// SCRUM-1005: the real side effects of the runner (filesystem, process, network)
// and the file run as a command. The in-process verdict tests are in
// runPublicSurface.run.test.ts.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realDeps } from "./runner.mjs";

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

const ENTRY = path.resolve("scripts/bombadil/runPublicSurface.mjs");

/** Runs the command line entry with a production URL, which is always refused. */
function runEntry(entry: string, outDir: string) {
  return spawnSync(
    process.execPath,
    [entry, "--base-url", "https://www.autoflowdealer.com", "--out-dir", outDir],
    {
      encoding: "utf8",
      env: { ...process.env, CLERK_SECRET_KEY: undefined },
    },
  );
}

/** Asserts a refusal that was really reached: exit 1 and a verdict on disk. */
function expectRefusalVerdict(
  child: ReturnType<typeof runEntry>,
  dir: string,
) {
  expect(child.status).toBe(1);
  const verdict = JSON.parse(
    readFileSync(path.join(dir, "verdict.json"), "utf8"),
  );
  expect(verdict.verdict).toBe("CANNOT_RUN");
  // The platform check runs before the host check, so on Windows (no bundled
  // binary) the refusal is the platform one; either way nothing was explored.
  expect(verdict.reason).toMatch(/production host|no bundled Bombadil binary/);
  expect(verdict.entries).toEqual([]);
}

describe("the file as a command", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  it("really runs when invoked directly: a production URL is refused with exit 1", () => {
    const dir = tempDir("bombadil-cli-");
    expectRefusalVerdict(runEntry(ENTRY, dir), dir);
  });

  it("really runs when reached through a symlink or junction, not exit 0 with no verdict", () => {
    // Node resolves the real path of the main entry, so a check that compares
    // import.meta.url with process.argv[1] sees two different paths here.
    const out = tempDir("bombadil-cli-out-");
    const home = tempDir("bombadil-cli-link-");
    const link = path.join(home, "bombadil");
    symlinkSync(path.dirname(ENTRY), link, "junction");
    expectRefusalVerdict(
      runEntry(path.join(link, path.basename(ENTRY)), out),
      out,
    );
  });

  it("exits 1 with a message when the runner throws, never 0", () => {
    // The output directory is below a regular file, so writing the verdict throws.
    const base = tempDir("bombadil-cli-crash-");
    const file = path.join(base, "not-a-directory");
    writeFileSync(file, "x");
    const child = runEntry(ENTRY, path.join(file, "out"));
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("the runner crashed");
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
