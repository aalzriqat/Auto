import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSpecFile, redact, fetchDeployedSpec } from "./fetchSpec.mjs";
import { listSurfaceFiles, unscannedConvexClients } from "./clientFiles.mjs";

/**
 * The reader and the credential ladder are the two places this control touches
 * something dangerous: a caller-supplied path, and a production credential.
 * Both were exercised end-to-end and neither had direct tests, which is the
 * wrong way round for the parts that decide what gets read and what gets
 * printed.
 */

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "skew-spec-"));

describe("readSpecFile bounds what it will open", () => {
  test("a spec inside the temp directory is read", () => {
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    expect(readSpecFile(file)).toMatchObject({ url: "https://x.convex.cloud" });
  });

  test("a path outside the workspace and temp directory is REFUSED", () => {
    /**
     * ⚠️ THIS TEST WAS VACUOUS AND A REVIEWER CAUGHT IT. It pointed at a path
     * that did not exist, so `readSpecFile` threw "No readable spec file" and
     * returned before the bounds check ever ran. Deleting the bounds check
     * entirely would have left it green.
     *
     * The file below REALLY EXISTS and is really outside both allowed roots, so
     * the only thing that can refuse it is the bounds check itself — and the
     * assertion now matches on the refusal message rather than on any throw.
     */
    const outsideRoot = path.join(path.parse(process.cwd()).root, `skew-outside-${process.pid}.json`);
    try {
      fs.writeFileSync(outsideRoot, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    } catch {
      return; // no write permission at the filesystem root; skip rather than fake it
    }
    try {
      expect(fs.existsSync(outsideRoot)).toBe(true); // it is readable, so only the bounds check can refuse
      expect(() => readSpecFile(outsideRoot)).toThrow(/Refusing to read a spec from outside/);
    } finally {
      fs.rmSync(outsideRoot, { force: true });
    }
  });

  test("a missing file says so, rather than failing later on undefined", () => {
    expect(() => readSpecFile(path.join(scratch(), "absent.json"))).toThrow(/No readable spec file/);
  });

  test("a SYMLINK pointing OUT of bounds is refused, because the path is canonicalized", () => {
    /**
     * ⚠️ ALSO VACUOUS BEFORE, and the same reviewer caught it: the old link
     * resolved back INSIDE the allowed directory, so no out-of-bounds link was
     * ever exercised. `path.resolve` does not follow links; `realpath` does,
     * and that difference is the whole point of the check.
     */
    const outsideRoot = path.join(path.parse(process.cwd()).root, `skew-target-${process.pid}.json`);
    try {
      fs.writeFileSync(outsideRoot, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    } catch {
      return;
    }
    const link = path.join(scratch(), "innocent-looking.json");
    try {
      fs.symlinkSync(outsideRoot, link);
    } catch {
      fs.rmSync(outsideRoot, { force: true });
      return; // symlink creation needs privileges on Windows; skip rather than fake it
    }
    try {
      // The LINK is inside an allowed directory; its TARGET is not.
      expect(() => readSpecFile(link)).toThrow(/Refusing to read a spec from outside/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideRoot, { force: true });
    }
  });
});

describe("redaction removes what the process was handed", () => {
  test("a Convex deploy key is removed by shape, wherever it appears", () => {
    const key = "prod:" + "some-deployment" + "|" + "abcdefghijklmnopqrstuvwxyz012345";
    expect(redact(`failed with ${key} at the end`)).not.toContain(key);
  });

  test("text with nothing sensitive is returned unchanged", () => {
    const plain = "Couldn't parse deployment name from the configured value";
    expect(redact(plain)).toBe(plain);
  });

  test("a literal union in a finding is NOT mangled by redaction", () => {
    // Redaction anchors on credential shapes, not on entropy. An earlier
    // version ate the accepted-value lists that findings are made of.
    const detail = 'backend accepts only [BUG, FEATURE]; client can send [null]';
    expect(redact(detail)).toBe(detail);
  });
});

describe("the credential ladder fails closed", () => {
  test("with no credential and no workstation flag, it is UNAVAILABLE and says what it tried", () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (/CONVEX_.*KEY|CONVEX_DEPLOYMENT/.test(k)) delete process.env[k];
    }
    try {
      const result = fetchDeployedSpec({});
      // Narrowed rather than merely asserted: if it somehow succeeded, the test
      // must fail here and say so, not read `tried` off the wrong shape.
      if (result.ok) throw new Error("expected UNAVAILABLE with no credential, got a spec");
      // Never silently empty: every rung it declined has to say why.
      expect(result.tried.length).toBeGreaterThan(0);
      expect(result.tried.join(" ")).toContain("WORKSTATION_ACCOUNT: not attempted");
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test("a spec from the WRONG deployment is refused, not reported on", () => {
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://other-backend.convex.cloud", functions: [] }));
    expect(() => fetchDeployedSpec({ specFile: file, expectedDeployment: "kindly-hound-172" })).toThrow(
      /Refusing to report on a deployment nobody is served by/
    );
  });

  test("a spec from the EXPECTED deployment is accepted", () => {
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://kindly-hound-172.convex.cloud", functions: [] }));
    const result = fetchDeployedSpec({ specFile: file, expectedDeployment: "kindly-hound-172" });
    if (!result.ok) throw new Error(`expected the matching deployment to be accepted: ${result.reason}`);
    expect(result.rung).toBe("SUPPLIED_FILE");
  });
});

describe("surface scanning survives an unreadable tree", () => {
  test("a directory that cannot be read yields nothing rather than throwing", () => {
    // A scheduled run must not die because one path vanished mid-walk.
    const files = listSurfaceFiles(scratch(), { name: "x", ships: "web", dirs: ["does-not-exist"], tsconfig: "tsconfig.json" });
    expect(files).toEqual([]);
  });

  test("a client file calling Convex that no surface scanned is reported as a GAP", () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "Stray.tsx"), 'import { useMutation } from "convex/react";\nuseMutation(api.a.b);\n');
    const missed = unscannedConvexClients(dir, []);
    expect(missed.map((m: { file: string }) => m.file)).toContain("app/Stray.tsx");
  });

  test("dot-directories and skipped directories are not walked", () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "app", ".next"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", ".next", "Hidden.tsx"), "export const a = 1;");
    fs.writeFileSync(path.join(dir, "app", "node_modules", "Dep.tsx"), "export const b = 1;");
    fs.writeFileSync(path.join(dir, "app", "Real.tsx"), "export const c = 1;");
    const files = listSurfaceFiles(dir, { name: "x", ships: "web", dirs: ["app"], tsconfig: "tsconfig.json" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/Real\.tsx$/);
  });
});
