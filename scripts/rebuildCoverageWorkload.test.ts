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

  test("a run that measured a file alone outranks runs that only saw it inside a shared batch", () => {
    // Runs 1 and 2 ran heavy.test.ts in one batch with light.test.ts (640 s for
    // the pair), so no fit can say which of the two the 640 s belong to and splits
    // it evenly (320 s each). Run 3 isolated them: 640 s and 6 s. Taking the
    // median over all runs gives heavy 320 s, the 5x under-estimate that made one
    // slice of PR 900 run 1,498 s instead of ~1,000 s.
    const together = [row("unit", ["heavy.test.ts", "light.test.ts"], 15 + 640)];
    const apart = [row("unit", ["heavy.test.ts"], 15 + 640), row("unit", ["light.test.ts"], 15 + 6)];
    const cost = fitMedianFileSeconds([together, together, apart], PROCESS);
    expect(cost.get("heavy.test.ts")).toBeCloseTo(640, 0);
    expect(cost.get("light.test.ts")).toBeCloseTo(6, 0);
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

  // The measured processes of the four main/PR Tests runs the weights were built
  // from: 45731285773, 45718572071, 45710876966 and 45755726103 (8 slices, 2 lanes
  // each), kept as fixtures. The weights must reproduce what each process really
  // took; the weights first pinned here priced the 8-file contractSkew batches at
  // 47 s that took 231 and 247 s, and a 32-file Sonar batch at 209 s that took
  // 638 s.
  //
  // Main pinned every process of one run (41584728669) to within 100 s and the
  // total to 10%. This keeps both: every process must be within 100 s of what it
  // measured. A process that several fixtures ran with the same mode and the same
  // files (104 of 469) cannot match every run, because the same process took e.g.
  // 436, 607 and 732 s; it is compared with the median of its measured times.
  //
  // coverageTimingsRun41584728669.json (main's former pin) is no longer pinned: it
  // is from a 4-slice, 32-file-Sonar-batch era, and against the current weights
  // 1 of its 137 processes is over 100 s (clientPaths.test.ts's 8-file unit batch,
  // 231 s measured, priced 105 s low because the suite is now priced from its
  // isolated runs). Its total is +1.6%.
  const RUNS = ["45731285773", "45718572071", "45710876966", "45755726103"];
  type Fixture = { files: string[]; rows: Array<["unit" | "sonar", number, number[]]> };
  type Workload = {
    isolateAtSeconds: number;
    defaultFileSeconds: number;
    processSeconds: Record<"unit" | "sonar", number>;
    files: Record<string, number>;
  };
  const readFixture = (run: string) =>
    JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "fixtures", `coverageTimingsRun${run}.json`), "utf8")) as Fixture;
  const readWorkload = () => JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "coverageWorkload.json"), "utf8")) as Workload;
  const modelSeconds = (workload: Workload, mode: "unit" | "sonar", files: string[]) =>
    workload.processSeconds[mode] + files.reduce((sum, file) => sum + (workload.files[file] ?? workload.defaultFileSeconds), 0);
  const middle = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  test("every measured process is priced within 100 s of its measured time (median across runs for a process several runs ran)", () => {
    const workload = readWorkload();
    const processes = new Map<string, { mode: "unit" | "sonar"; files: string[]; walls: number[] }>();
    for (const run of RUNS) {
      const fixture = readFixture(run);
      for (const [mode, wall, indexes] of fixture.rows) {
        const files = indexes.map((i) => fixture.files[i]).sort((a, b) => a.localeCompare(b));
        const key = `${mode}|${files.join(",")}`;
        const known = processes.get(key) ?? { mode, files, walls: [] };
        known.walls.push(wall);
        processes.set(key, known);
      }
    }
    expect(processes.size).toBeGreaterThan(400);
    const off = [...processes.values()]
      .map(({ mode, files, walls }) => ({ mode, first: files[0], count: files.length, walls, error: Math.abs(modelSeconds(workload, mode, files) - middle(walls)) }))
      .filter(({ error }) => error > 100)
      .map(({ mode, first, count, walls, error }) => `${mode} ${count} files from ${first}: off by ${Math.round(error)} s, measured ${walls.join("/")} s`);
    expect(off).toEqual([]);
  });

  test.each(RUNS)("the committed weights reproduce the total measured cost of run %s", (run) => {
    const workload = readWorkload();
    const fixture = readFixture(run);
    const modelled = fixture.rows.map(([mode, wall, indexes]) => ({
      wall,
      modelled: modelSeconds(workload, mode, indexes.map((i) => fixture.files[i])),
    }));
    expect(modelled.length).toBeGreaterThan(100);
    // In total the model neither hides nor invents work (the first weights were
    // 21% over).
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const totalWall = sum(modelled.map((m) => m.wall));
    expect(Math.abs(sum(modelled.map((m) => m.modelled)) - totalWall) / totalWall).toBeLessThanOrEqual(0.1);
  });

  // PR 900 run 45755726103: convex/openingClosureReaders.scrum858.test.ts was
  // modelled at 110 s and isolated, then measured alone at 667 s (unit) and
  // 640 s (Sonar); its slice ran 1,498 s against a plan of 1,521 s per slice. A
  // single-file process is an exact measurement of one suite, so the weights must
  // not be off by more than half of it for any suite heavy enough to be isolated.
  test("every suite that ran alone in the latest run is priced within half of its measured time", () => {
    const root = process.cwd();
    const measured = JSON.parse(readFileSync(path.join(root, "scripts", "fixtures", "coverageTimingsRun45755726103.json"), "utf8")) as {
      files: string[];
      rows: Array<["unit" | "sonar", number, number[]]>;
    };
    const workload = JSON.parse(readFileSync(path.join(root, "scripts", "coverageWorkload.json"), "utf8")) as {
      isolateAtSeconds: number;
      defaultFileSeconds: number;
      processSeconds: Record<"unit" | "sonar", number>;
      files: Record<string, number>;
    };
    const alone = measured.rows
      .filter(([, , files]) => files.length === 1)
      .map(([mode, wall, [index]]) => ({ file: measured.files[index], seconds: wall - workload.processSeconds[mode] }))
      .filter(({ seconds }) => seconds >= workload.isolateAtSeconds);
    expect(alone.length).toBeGreaterThanOrEqual(8);
    for (const { file, seconds } of alone) {
      const priced = workload.files[file] ?? workload.defaultFileSeconds;
      expect(Math.abs(priced - seconds), `${file}: priced ${priced} s, measured ${Math.round(seconds)} s`).toBeLessThanOrEqual(seconds / 2);
    }
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

  test("the default keeps one decimal, because rounding 1.78 s up to 2 s overstates 941 files by 207 s", () => {
    const cost = new Map(["a", "b", "c", "d", "e"].map((name, i) => [`${name}.test.ts`, i === 0 ? 3.9 : 1.5]));
    // mean 1.98 -> 2.0; and a mean of 1.78 stays 1.8
    expect(buildWorkload({ defaultFileSeconds: 9, files: {} }, cost, () => true).defaultFileSeconds).toBe(2);
    const slower = new Map([["a.test.ts", 1], ["b.test.ts", 1], ["c.test.ts", 1], ["d.test.ts", 1], ["e.test.ts", 1], ["f.test.ts", 1], ["g.test.ts", 1], ["h.test.ts", 1], ["i.test.ts", 7]]);
    expect(buildWorkload({ defaultFileSeconds: 9, files: {} }, slower, () => true).defaultFileSeconds).toBe(1.7);
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
