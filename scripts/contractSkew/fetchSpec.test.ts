import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSpecFile, redact, fetchDeployedSpec } from "./fetchSpec.mjs";
import { listSurfaceFiles, normalizeSurfacePath, unscannedConvexClients } from "./clientFiles.mjs";

/**
 * The reader and the credential ladder are the two places this control touches
 * something dangerous: a caller-supplied path, and a production credential.
 * Both were exercised end-to-end and neither had direct tests, which is the
 * wrong way round for the parts that decide what gets read and what gets
 * printed.
 */

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "skew-spec-"));

/**
 * A location that really exists, is really outside every allowed root, and that
 * an unprivileged CI user can actually create.
 *
 * ⚠️ THE PREVIOUS VERSION WROTE TO THE FILESYSTEM ROOT AND RETURNED SILENTLY IF
 * THAT FAILED — and `return` inside a vitest callback is a PASS, not a skip. On
 * `ubuntu-latest` the job user is not root and `/` is `drwxr-xr-x root:root`,
 * so the write raises EACCES: the test reported green on the one machine whose
 * answer counts, having asserted nothing. Measured on Linux as a non-root user:
 * `touch /x` → `Permission denied`.
 *
 * That is the THIRD time in this PR that a test of this control proved nothing,
 * so the fix is not another location. A fixture that cannot be established now
 * FAILS. The parent of the workspace is writable by an ordinary user on both
 * CI and a developer machine, and the check below refuses to proceed unless it
 * really is outside every allowed root — because a fixture that is not out of
 * bounds cannot demonstrate that out-of-bounds is refused.
 */
function outsideEveryAllowedRoot(name: string): string {
  const candidate = path.resolve(process.cwd(), "..", name);
  for (const root of [process.cwd(), os.tmpdir()]) {
    const real = fs.realpathSync(path.resolve(root));
    if (candidate === real || candidate.startsWith(real + path.sep)) {
      throw new Error(`fixture proves nothing: ${candidate} is INSIDE the allowed root ${real}`);
    }
  }
  return candidate;
}

describe("readSpecFile bounds what it will open", () => {
  test("a spec inside the temp directory is read", () => {
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    expect(readSpecFile(file)).toMatchObject({ url: "https://x.convex.cloud" });
  });

  test("a path outside the workspace and temp directory is REFUSED", () => {
    // No try/catch around the write: if the fixture cannot be created this test
    // FAILS. Silence here is what made the previous version worthless.
    const outside = outsideEveryAllowedRoot(`skew-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    try {
      // It exists and is readable, so the bounds check is the only thing that
      // can refuse it — and the assertion matches the refusal MESSAGE, not any
      // throw, so "No readable spec file" cannot pass for a refusal.
      expect(fs.existsSync(outside)).toBe(true);
      expect(() => readSpecFile(outside)).toThrow(/Refusing to read a spec from outside/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test("a missing file says so, rather than failing later on undefined", () => {
    expect(() => readSpecFile(path.join(scratch(), "absent.json"))).toThrow(/No readable spec file/);
  });

  test("a SYMLINK pointing OUT of bounds is refused, because the path is canonicalized", (ctx) => {
    /**
     * `path.resolve` does not follow links; `realpath` does, and that difference
     * is the whole point of the check — the LINK is inside an allowed directory
     * and its TARGET is not.
     */
    const target = outsideEveryAllowedRoot(`skew-target-${process.pid}.json`);
    fs.writeFileSync(target, JSON.stringify({ url: "https://x.convex.cloud", functions: [] }));
    const link = path.join(scratch(), "innocent-looking.json");
    try {
      fs.symlinkSync(target, link);
    } catch {
      // Creating a symlink needs a privilege Windows does not grant by default.
      // That is a genuine platform limit rather than a fixture failure, so it
      // is a VISIBLE skip — never a bare `return`, which vitest reports as a
      // pass and which is exactly how this file came to prove nothing twice.
      fs.rmSync(target, { force: true });
      ctx.skip();
      return;
    }
    try {
      expect(() => readSpecFile(link)).toThrow(/Refusing to read a spec from outside/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});

describe("path identity follows the filesystem, not the developer's machine", () => {
  /**
   * ⚠️ THIS FOLD USED TO BE UNCONDITIONAL, AND CI RUNS ON LINUX. `app/Foo.tsx`
   * and `app/foo.tsx` are DIFFERENT files there, and collapsing them to one key
   * made an unscanned file look scanned — a false PASS in the very detector
   * whose job is to notice a file nobody scanned.
   *
   * Deliberately not folded on darwin: APFS can be configured either way, and
   * being wrong there yields a false GAP, which is loud and denies PASS, rather
   * than a false PASS, which is silent.
   */
  test("two casings are DISTINCT paths on linux", () => {
    expect(normalizeSurfacePath("app/Foo.tsx", "linux")).not.toBe(
      normalizeSurfacePath("app/foo.tsx", "linux")
    );
  });

  test("and on darwin, deliberately — a false gap is louder than a false pass", () => {
    expect(normalizeSurfacePath("app/Foo.tsx", "darwin")).not.toBe(
      normalizeSurfacePath("app/foo.tsx", "darwin")
    );
  });

  test("but the SAME path on win32, where the filesystem really is case-insensitive", () => {
    expect(normalizeSurfacePath("app/Foo.tsx", "win32")).toBe(
      normalizeSurfacePath("app/foo.tsx", "win32")
    );
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

  test("an EMPTY expected deployment is a MISCONFIGURATION, never an opt-out", () => {
    /**
     * ⚠️ The check was `if (expectedDeployment)`, so `""` skipped it silently —
     * and `""` is exactly what an unset GitHub Actions variable expands to. The
     * guard the workflow calls binding was inert, and the run reported a
     * confident verdict about a deployment it never identified.
     *
     * `undefined` still means "no check requested". Anything else means one WAS
     * requested, and a request that cannot be honoured must refuse.
     */
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://kindly-hound-172.convex.cloud", functions: [] }));
    expect(() => fetchDeployedSpec({ specFile: file, expectedDeployment: "" })).toThrow(
      /is not a deployment name/
    );
  });

  test("a MALFORMED expected deployment is refused rather than compared", () => {
    // `prod:kindly-hound-172` can never equal a URL host, so comparing it would
    // fail for the right reason by accident. Refusing names the real problem.
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://kindly-hound-172.convex.cloud", functions: [] }));
    expect(() =>
      fetchDeployedSpec({ specFile: file, expectedDeployment: "prod:kindly-hound-172" })
    ).toThrow(/is not a deployment name/);
  });

  test("and undefined still means no identity check was requested", () => {
    const dir = scratch();
    const file = path.join(dir, "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://anything.convex.cloud", functions: [] }));
    expect(fetchDeployedSpec({ specFile: file, expectedDeployment: undefined })).toMatchObject({
      ok: true,
    });
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
