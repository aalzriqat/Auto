import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vitest";

const shadcnRequire = createRequire(realpathSync("node_modules/shadcn/package.json"));
const postcss: unknown = shadcnRequire("postcss");

function property(owner: unknown, name: string): unknown {
  return owner !== null && typeof owner === "object" ? Reflect.get(owner, name) : undefined;
}

async function parseCss(mode: "parse" | "process", css: string, from?: string): Promise<unknown> {
  if (typeof postcss !== "function") throw new Error("PostCSS implementation unavailable");
  if (mode === "parse") {
    const parse: unknown = Reflect.get(postcss, "parse");
    if (typeof parse !== "function") throw new Error("PostCSS parser unavailable");
    return Reflect.apply(parse, postcss, [css, { from }]);
  }
  const processor: unknown = Reflect.apply(postcss, undefined, []);
  const process = property(processor, "process");
  if (typeof process !== "function") throw new Error("PostCSS processor unavailable");
  const result: unknown = await Reflect.apply(process, processor, [css, { from }]);
  return property(result, "root");
}

function previousMap(root: unknown): unknown {
  return property(property(property(root, "source"), "input"), "map");
}

test.each(["parse", "process"] as const)("PostCSS %s loads a real map only with an explicit source file", async (mode) => {
  const workspace = path.resolve("work");
  mkdirSync(workspace, { recursive: true });
  const directory = realpathSync(mkdtempSync(path.join(workspace, "postcss-source-map-")));
  if (path.dirname(directory) !== realpathSync(workspace)) throw new Error("Temporary source map must stay inside the workspace");
  const mapPath = path.join(directory, "synthetic.css.map");
  const canary = "/* synthetic external source-map canary */";
  writeFileSync(mapPath, JSON.stringify({ version: 3, file: "synthetic.css", sources: ["synthetic.scss"],
    names: [], mappings: "AAAA", sourcesContent: [canary] }));
  try {
    const trusted = await parseCss(mode, "a { color: red }\n/*# sourceMappingURL=synthetic.css.map */", path.join(directory, "synthetic.css"));
    const loaded = previousMap(trusted);
    expect(property(loaded, "text")).toContain(canary);
    const consumer = property(loaded, "consumer");
    if (typeof consumer !== "function") throw new Error("Explicit source map was not consumed");
    const consumed: unknown = Reflect.apply(consumer, loaded, []);
    expect(property(consumed, "sourcesContent")).toEqual([canary]);

    const untrusted = await parseCss(mode, `a { color: red }\n/*# sourceMappingURL=${mapPath} */`);
    expect(previousMap(untrusted)).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
