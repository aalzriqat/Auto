/**
 * SCRUM-752: scripts/rebuildCoverageWorkload.mjs turns the per-process wall
 * times that the Tests slices upload into per-file scheduling costs. These pin
 * the arithmetic, and that the rebuild changes scheduling inputs only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildWorkload, fitFileSeconds, main, parseTimingLines, timingFiles } from "./rebuildCoverageWorkload.mjs";

const PROCESS = { unit: 15, sonar: 25 };
const row = (mode: "unit" | "sonar", files: string[], wallSeconds: number, status = 0) => ({
  mode,
  files,
  wallSeconds,
  status,
});

describe("rebuildCoverageWorkload", () => {
  test("a single-file process measures that file exactly, net of the process start", () => {
    const cost = fitFileSeconds([row("unit", ["a.test.ts"], 415), row("sonar", ["a.test.ts"], 385)], PROCESS);
    expect(cost.get("a.test.ts")).toBeCloseTo(380, 0);
  });

  test("a heavy file hidden in a batch is found through the other mode's differently shaped batch", () => {
    // heavy.test.ts takes 200 s, the others 2 s each. The unit batch holds it
    // with 3 others; the Sonar batch holds it with a different 3.
    const rows = [
      row("unit", ["heavy", "u1", "u2", "u3"], 15 + 206),
      row("sonar", ["heavy", "s1", "s2", "s3"], 25 + 206),
      row("unit", ["u4", "u5"], 15 + 4),
      row("sonar", ["s4", "s5"], 25 + 4),
      // Each light file also runs alone in another batch of its own.
      ...["u1", "u2", "u3", "s1", "s2", "s3"].map((file) => row("unit", [file], 15 + 2)),
    ];
    const cost = fitFileSeconds(rows, PROCESS);
    expect(cost.get("heavy")).toBeGreaterThan(190);
    for (const light of ["u1", "u2", "u3", "s1", "s2", "s3"]) expect(cost.get(light)).toBeLessThan(5);
  });

  test("costs are never negative, even when a batch ran faster than its process start", () => {
    const cost = fitFileSeconds([row("sonar", ["a", "b"], 3)], PROCESS);
    for (const seconds of cost.values()) expect(seconds).toBeGreaterThanOrEqual(0);
  });

  test("failed processes are not timings", () => {
    const text = [row("unit", ["a"], 30), row("unit", ["b"], 999, 1)].map((timing) => JSON.stringify(timing)).join("\n");
    expect(parseTimingLines(`${text}\n\n`).map((timing: { files: string[] }) => timing.files)).toEqual([["a"]]);
  });

  test("the rebuild lists the costly files largest first, drops vanished paths, and keeps every other input", () => {
    const previous = {
      $comment: "keep",
      defaultFileSeconds: 4,
      isolateAtSeconds: 40,
      processSeconds: PROCESS,
      files: { "old.test.ts": 99 },
    };
    const cost = new Map([
      ["big.test.ts", 120],
      ["mid.test.ts", 30.4],
      ["small.test.ts", 3],
      ["tiny.test.ts", 1],
      ["gone.test.ts", 500],
    ]);
    const next = buildWorkload(previous, cost, (file: string) => file !== "gone.test.ts");
    expect(Object.entries(next.files)).toEqual([
      ["big.test.ts", 120],
      ["mid.test.ts", 30],
    ]);
    expect(next.defaultFileSeconds).toBe(3);
    expect(next.isolateAtSeconds).toBe(40);
    expect(next.processSeconds).toEqual(PROCESS);
    expect(next.$comment).toBe("keep");
  });

  // The measured processes of Tests run 41584728669 (PR, 4 slices, 2 lanes).
  // The weights must reproduce what each process really took; the weights this
  // replaced priced the 8-file contractSkew batches at 47 s that took 231 and
  // 247 s, and a 32-file Sonar batch at 209 s that took 638 s.
  test("the committed weights reproduce the measured cost of every process in a real run", () => {
    const root = process.cwd();
    const measured = JSON.parse(readFileSync(path.join(root, "scripts", "fixtures", "coverageTimingsRun41584728669.json"), "utf8")) as {
      files: string[];
      rows: Array<[ "unit" | "sonar", number, number[] ]>;
    };
    const workload = JSON.parse(readFileSync(path.join(root, "scripts", "coverageWorkload.json"), "utf8")) as {
      defaultFileSeconds: number;
      processSeconds: Record<"unit" | "sonar", number>;
      files: Record<string, number>;
    };
    const modelled = measured.rows.map(([mode, wall, files]) => ({
      wall,
      modelled:
        workload.processSeconds[mode] +
        files.reduce((sum, i) => sum + (workload.files[measured.files[i]] ?? workload.defaultFileSeconds), 0),
    }));
    // One cost per file serves both modes, and a file costs differently under
    // each (census.test.ts: 506 s in unit, 363 s in Sonar), so a process can be
    // off by tens of seconds. The old weights were off by up to 429 s.
    for (const { wall, modelled: cost } of modelled) expect(Math.abs(cost - wall)).toBeLessThanOrEqual(100);
    // In total the model neither hides nor invents work (the old weights were
    // 21% over).
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const totalWall = sum(modelled.map((m) => m.wall));
    expect(Math.abs(sum(modelled.map((m) => m.modelled)) - totalWall) / totalWall).toBeLessThanOrEqual(0.1);
  });

  test("a timing line is kept only for a successful unit or sonar process that lists its files", () => {
    const lines = [
      row("unit", ["a"], 30),
      { mode: "other", files: ["b"], wallSeconds: 30, status: 0 },
      { mode: "unit", files: "c", wallSeconds: 30, status: 0 },
      row("sonar", ["d"], 30, 1),
    ].map((timing) => JSON.stringify(timing));
    expect(parseTimingLines(lines.join("\n")).map((timing: { files: string[] }) => timing.files)).toEqual([["a"]]);
  });

  test("with no file cheaper than the listing threshold the previous default is kept", () => {
    const previous = { defaultFileSeconds: 7, files: {} };
    const next = buildWorkload(previous, new Map([["big.test.ts", 90]]), () => true);
    expect(next.defaultFileSeconds).toBe(7);
    expect(next.files).toEqual({ "big.test.ts": 90 });
  });

  test("files that cost the same seconds are listed in path order", () => {
    const cost = new Map([
      ["b.test.ts", 50],
      ["a.test.ts", 50],
      ["c.test.ts", 80],
    ]);
    const next = buildWorkload({ defaultFileSeconds: 2, files: {} }, cost, () => true);
    expect(Object.keys(next.files)).toEqual(["c.test.ts", "a.test.ts", "b.test.ts"]);
  });
});

describe("rebuildCoverageWorkload command line", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const PREVIOUS = {
    $comment: "keep",
    defaultFileSeconds: 4,
    isolateAtSeconds: 40,
    processSeconds: PROCESS,
    files: { "stale.test.ts": 99 },
  };

  // A project root with real files, a workload to rebuild and two timing
  // directories (one nested) holding .jsonl and other files.
  function project() {
    const root = mkdtempSync(path.join(tmpdir(), "rebuild-workload-"));
    roots.push(root);
    writeFileSync(path.join(root, "heavy.test.ts"), "");
    writeFileSync(path.join(root, "light.test.ts"), "");
    const workload = path.join(root, "workload.json");
    writeFileSync(workload, `${JSON.stringify(PREVIOUS)}\n`);
    const timings = path.join(root, "timings");
    mkdirSync(path.join(timings, "coverage-timings-1"), { recursive: true });
    writeFileSync(
      path.join(timings, "coverage-timings-1", "slice-1.jsonl"),
      `${[row("unit", ["heavy.test.ts"], 215), row("sonar", ["light.test.ts", "gone.test.ts"], 29)].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    writeFileSync(path.join(timings, "readme.txt"), "not a timing file");
    return { root, workload, timings };
  }

  function run(argv: string[], root: string, workload?: string) {
    let out = "";
    let err = "";
    main(argv, {
      cwd: root,
      env: workload ? { AUTOFLOW_COVERAGE_WORKLOAD: workload } : {},
      stdout: {
        write: (text: string) => {
          out += text;
          return true;
        },
      },
      stderr: {
        write: (text: string) => {
          err += text;
          return true;
        },
      },
    });
    return { out, err };
  }

  test("timingFiles walks nested directories and returns only .jsonl files", () => {
    const { timings } = project();
    mkdirSync(path.join(timings, "deep", "er"), { recursive: true });
    writeFileSync(path.join(timings, "deep", "er", "slice-9.jsonl"), "");
    const found = timingFiles(timings).map((file: string) => path.relative(timings, file).split(path.sep).join("/"));
    expect(found.sort()).toEqual(["coverage-timings-1/slice-1.jsonl", "deep/er/slice-9.jsonl"]);
  });

  test("without --write the rebuilt workload goes to stdout and the file is untouched", () => {
    const { root, workload, timings } = project();
    const { out, err } = run([timings], root, workload);
    const next = JSON.parse(out);
    expect(next.files["heavy.test.ts"]).toBe(200);
    expect(next.files["stale.test.ts"]).toBeUndefined();
    expect(next.$comment).toBe("keep");
    expect(err).toMatch(/2 timing lines -> 1 listed files/);
    expect(JSON.parse(readFileSync(workload, "utf8"))).toEqual(PREVIOUS);
  });

  test("with --write the workload file is replaced and nothing goes to stdout", () => {
    const { root, workload, timings } = project();
    const { out } = run([timings, "--write"], root, workload);
    expect(out).toBe("");
    expect(JSON.parse(readFileSync(workload, "utf8")).files["heavy.test.ts"]).toBe(200);
  });

  test("the default workload path is scripts/coverageWorkload.json under the working directory", () => {
    const { root, timings } = project();
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "coverageWorkload.json"), `${JSON.stringify(PREVIOUS)}\n`);
    const { out } = run([timings], root);
    expect(JSON.parse(out).files["heavy.test.ts"]).toBe(200);
  });

  test("no directory, or a directory that does not exist, is a usage error", () => {
    const { root, timings } = project();
    expect(() => run([], root)).toThrow(/Usage: node scripts\/rebuildCoverageWorkload\.mjs/);
    expect(() => run(["--write"], root)).toThrow(/Usage:/);
    expect(() => run([path.join(root, "missing")], root)).toThrow(/Usage:/);
    expect(() => run([path.join(timings, "readme.txt")], root)).toThrow(/Usage:/);
  });

  test("a directory without a successful timing line is refused", () => {
    const { root, workload } = project();
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    writeFileSync(path.join(empty, "slice-1.jsonl"), `${JSON.stringify(row("unit", ["a"], 30, 1))}\n`);
    expect(() => run([empty], root, workload)).toThrow("No successful timing lines found.");
  });
});
