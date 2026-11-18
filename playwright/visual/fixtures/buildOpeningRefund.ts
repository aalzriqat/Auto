import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Like buildSupplierNavigation: keep Vite outside Playwright's module loader.
const directory = process.argv[2];
if (!directory) throw new Error("Fixture output directory required");
const root = process.cwd();
const require = createRequire(resolve(root, "package.json"));
const vitePath = createRequire(require.resolve("vitest/package.json")).resolve("vite");
const vite: { build: (config: Record<string, unknown>) => Promise<unknown> } = await import(pathToFileURL(vitePath).href);
const built = await vite.build({
  configFile: false, publicDir: false, logLevel: "error", root,
  define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  resolve: { alias: [
    { find: "convex/react", replacement: resolve(root, "playwright/visual/fixtures/openingRefundHooks.ts") },
    { find: "@", replacement: root },
  ] },
  build: { write: false, minify: false, lib: { entry: resolve(root, "playwright/visual/fixtures/openingRefundFixture.ts"), name: "OpeningRefundFixture", formats: ["iife"] } },
});
const output = Array.isArray(built) ? built[0] : built;
if (!output || typeof output !== "object" || !("output" in output) || !Array.isArray(output.output)) throw new Error("Fixture bundle unavailable");
const chunk = output.output.find((item: unknown): item is { code: string } => !!item && typeof item === "object" && "code" in item && typeof item.code === "string");
if (!chunk) throw new Error("Fixture JavaScript unavailable");
writeFileSync(resolve(directory, "fixture.js"), chunk.code);
