/**
 * The component inventory is read from the syntax tree and from the INSTALLED
 * packages, and anything it cannot establish exactly fails closed.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { componentPaths, parseComponentConfig } from "./zeroStateComponents";

const CONFIG_FILE = path.join(__dirname, "..", "convex", "convex.config.ts");
const WORKPOOL = 'import workpool from "@convex-dev/workpool/convex.config.js";';
const AGGREGATE = 'import aggregate from "@convex-dev/aggregate/convex.config.js";';

function appWith(...lines: string[]): string {
  return [WORKPOOL, AGGREGATE, 'import { defineApp } from "convex/server";', "const app = defineApp();", ...lines, "export default app;"].join("\n");
}

describe("component inventory", () => {
  test("a nested component is addressed by its parent's path, with the name taken from its own definition", () => {
    expect(componentPaths(CONFIG_FILE, appWith('app.use(workpool, { name: "queue" });', "app.use(aggregate);"))).toEqual([
      "queue", "queue/batchWorker", "aggregate",
    ]);
  });

  test("the nested child is resolved from the PARENT's installed location, not the root copy", () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const fixture = fs.mkdtempSync(path.join(tempRoot, "autoflow-zero-state-"));
    const config = path.join(fixture, "convex.config.ts");
    const parentDir = path.join(fixture, "node_modules", "@fixture", "parent");
    const rootChild = path.join(fixture, "node_modules", "@fixture", "child");
    const parentChild = path.join(parentDir, "node_modules", "@fixture", "child");
    try {
      for (const directory of [parentDir, rootChild, parentChild]) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(config, 'import parent from "@fixture/parent/convex.config.js"; const app = defineApp(); app.use(parent, { name: "queue" }); export default app;');
      fs.writeFileSync(path.join(parentDir, "convex.config.js"), 'import child from "@fixture/child/convex.config.js"; const component = defineComponent("parent"); component.use(child); export default component;');
      fs.writeFileSync(path.join(rootChild, "convex.config.js"), 'export default defineComponent("rootChild");');
      fs.writeFileSync(path.join(parentChild, "convex.config.js"), 'export default defineComponent("parentChild");');

      expect(componentPaths(config)).toEqual(["queue", "queue/parentChild"]);
    } finally {
      if (path.dirname(path.resolve(fixture)) !== tempRoot) throw new Error("Fixture cleanup escaped the temporary directory.");
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a leaf component has no mounts", () => {
    for (const pkg of ["@convex-dev/rate-limiter", "@convex-dev/aggregate", "@convex-dev/batch-worker"]) {
      const file = fs.realpathSync(createRequire(CONFIG_FILE).resolve(`${pkg}/convex.config.js`));
      expect(parseComponentConfig(fs.readFileSync(file, "utf8"), file, "component").mounts).toEqual([]);
    }
  });

  test("comments and strings neither create nor hide a mount", () => {
    const source = appWith(
      '// app.use(aggregate, { name: "fromComment" });',
      '/* app.use(aggregate, { name: "fromBlock" }); */',
      'const note = "app.use(aggregate, { name: \\"fromString\\" })";',
      'const metadata = { label: "safe" }; const label = metadata["label"];',
      'app.use(aggregate, { name: "real" });'
    );
    expect(componentPaths(CONFIG_FILE, source)).toEqual(["real"]);
  });

  test.each([
    ["a constant name", 'const n = "x"; app.use(aggregate, { name: n });'],
    ["a computed name", 'app.use(aggregate, { ["name"]: "x" });'],
    ["a shorthand name", 'const name = "x"; app.use(aggregate, { name });'],
    ["a template name with a substitution", "const n = 1; app.use(aggregate, { name: `a${n}` });"],
    ["a spread of options", "const o = {}; app.use(aggregate, { ...o });"],
    ["non-object options", "const o = {}; app.use(aggregate, o);"],
    ["an extra argument", 'app.use(aggregate, { name: "a" }, 1);'],
    ["a mount with no component", "app.use();"],
    ["a non-identifier target", "app.use(foo.bar);"],
    ["a target that is not a default import", "app.use(neverImported);"],
    ["a call on another receiver", "const other = { use() {} }; other.use(aggregate);"],
    ["an aliased .use", "const u = app.use; u(aggregate);"],
    ["a computed .use access", 'app["use"](aggregate);'],
    ["a dynamic .use access", 'const method = "use" as const; app[method](aggregate);'],
    ["a destructured .use", "const { use } = app; use(aggregate);"],
    ["a renamed destructured .use", "const { use: mount } = app; mount(aggregate);"],
    ["a computed destructured .use", 'const method = "use"; const { [method]: mount } = app; mount(aggregate);'],
  ])("%s is refused, never omitted", (_label, line) => {
    expect(() => componentPaths(CONFIG_FILE, appWith(line))).toThrow();
  });

  test("a package that cannot be resolved is refused", () => {
    const source = ['import mystery from "@convex-dev/not-installed/convex.config.js";', "const app = defineApp();", "app.use(mystery);"].join("\n");
    expect(() => componentPaths(CONFIG_FILE, source)).toThrow(/cannot be resolved/);
  });

  test("the same path mounted twice is refused", () => {
    expect(() => componentPaths(CONFIG_FILE, appWith('app.use(aggregate, { name: "a" });', 'app.use(aggregate, { name: "a" });'))).toThrow(/mounted twice/);
  });

  test("a config without exactly one defineApp is refused", () => {
    expect(() => componentPaths(CONFIG_FILE, "export default 1;")).toThrow(/exactly one defineApp/);
  });

  test.each([
    'app.use(aggregate); @@@ export default app;',
    'app.use(aggregate); const invalid = ;',
  ])("malformed configuration is refused before inventorying mounts: %s", (source) => {
    expect(() => parseComponentConfig(appWith(source), CONFIG_FILE, "app")).toThrow(/syntax/i);
  });
});
