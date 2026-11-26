/**
 * SCRUM-752: scripts/rebuildCoverageWorkload.mjs turns the per-process wall
 * times that the Tests slices upload into per-file scheduling costs. These pin
 * the arithmetic, and that the rebuild changes scheduling inputs only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildWorkload, fitFileSeconds, fitMedianFileSeconds, main, parseTimingLines, timingFiles } from "./rebuildCoverageWorkload.mjs";

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

  test("the per-run median ignores a file that one run measured as an outlier", () => {
    // Three runs of the same single-file process: 100 s, 102 s and a noisy 400 s.
    const runs = [100, 102, 400].map((wall) => [row("unit", ["a.test.ts"], 15 + wall)]);
    expect(fitMedianFileSeconds(runs, PROCESS).get("a.test.ts")).toBeCloseTo(102, 0);
    // Pooling the same runs lets the outlier pull the cost up.
    expect(fitFileSeconds(runs.flat(), PROCESS).get("a.test.ts")).toBeGreaterThan(150);
  });

  test("the per-run median averages the middle pair of an even number of runs and keeps a file seen in one run", () => {
    const runs = [
      [row("unit", ["a.test.ts"], 15 + 100), row("unit", ["only.test.ts"], 15 + 7)],
      [row("unit", ["a.test.ts"], 15 + 200)],
    ];
    const cost = fitMedianFileSeconds(runs, PROCESS);
    expect(cost.get("a.test.ts")).toBeCloseTo(150, 0);
    expect(cost.get("only.test.ts")).toBeCloseTo(7, 0);
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
    expect(next.defaultFileSeconds).toBe(2);
    expect(next.isolateAtSeconds).toBe(40);
    expect(next.processSeconds).toEqual(PROCESS);
    expect(next.$comment).toBe("keep");
  });

  // The measured processes of the three main Tests runs the weights were built
  // from: 45731285773, 45718572071 and 45710876966 (8 slices, 2 lanes each), kept
  // as fixtures. The weights must reproduce what each process really took; the
  // weights first pinned here priced the 8-file contractSkew batches at 47 s that
  // took 231 and 247 s, and a 32-file Sonar batch at 209 s that took 638 s.
  //
  // SCRUM-1010: this pin used to read one run (41584728669) with a flat 100 s per
  // process and 10% in total. One cost per file serves both modes and every
  // batch mix, so a few processes are always off by more: against these runs the
  // per-process error is p95 42-61 s, p99 134-161 s and worst 143-200 s (a heavy
  // single suite such as census.test.ts or clientPaths.test.ts varies by that
  // much between runs and modes; so do the 8 contractSkew files in one batch),
  // and the total is within 9.1%. The bounds below keep the original 100 s for
  // 95% of processes and 10% in total, and cap the worst process at 250 s, 25%
  // above the worst measured, which still rejects the 429 s error this pin was
  // written against.
  const RUNS = ["45731285773", "45718572071", "45710876966"];
  test.each(RUNS)("the committed weights reproduce the measured cost of the processes of run %s", (run) => {
    const root = process.cwd();
    const measured = JSON.parse(readFileSync(path.join(root, "scripts", "fixtures", `coverageTimingsRun${run}.json`), "utf8")) as {
      files: string[];
      rows: Array<["unit" | "sonar", number, number[]]>;
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
    const errors = modelled.map((m) => Math.abs(m.modelled - m.wall)).sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(100);
    expect(errors[Math.ceil(errors.length * 0.95) - 1]).toBeLessThanOrEqual(100);
    expect(errors[errors.length - 1]).toBeLessThanOrEqual(250);
    // In total the model neither hides nor invents work (the first weights were
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

  test("the default is the mean of the unlisted files, so their total is kept despite a few slower ones", () => {
    // 941 of the unlisted files measured in runs 45731285773/45718572071/45710876966:
    // median 1.33 s, mean 1.78 s. The planner adds the default once per unlisted
    // file, so only the mean keeps their sum; the median read the total 10-16% low.
    const cost = new Map([...[1, 1, 1, 1, 6].entries()].map(([i, seconds]) => [`s${i}.test.ts`, seconds]));
    expect(buildWorkload({ defaultFileSeconds: 9, files: {} }, cost, () => true).defaultFileSeconds).toBe(2);
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

  test("--median-of-runs treats each directory as one run and takes the per-file median", () => {
    const { root, workload, timings } = project();
    const second = path.join(root, "second");
    const third = path.join(root, "third");
    for (const [directory, wall] of [[second, 415], [third, 15 + 5000]] as const) {
      mkdirSync(directory);
      writeFileSync(path.join(directory, "slice-1.jsonl"), `${JSON.stringify(row("unit", ["heavy.test.ts"], wall))}\n`);
    }
    // heavy.test.ts measures 200, 400 and 5000 s in the three runs: median 400.
    const { out } = run([timings, second, third, "--median-of-runs"], root, workload);
    expect(JSON.parse(out).files["heavy.test.ts"]).toBe(400);
    // Without the flag the three directories are pooled into one fit.
    expect(JSON.parse(run([timings, second, third], root, workload).out).files["heavy.test.ts"]).toBeGreaterThan(1000);
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
