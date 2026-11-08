import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run with Node, outside Playwright's loader, using the same runtime as the worker.
const directory = process.argv[2];
if (!directory) throw new Error("Fixture output directory required");
const root = process.cwd();
const require = createRequire(resolve(root, "package.json"));
const vitePath = createRequire(require.resolve("vitest/package.json")).resolve("vite");
const vite: { build: (config: Record<string, unknown>) => Promise<unknown> } = await import(pathToFileURL(vitePath).href);
const hooks = resolve(root, "playwright/visual/fixtures/supplierNavigationHooks.ts");
const built = await vite.build({
  configFile: false, publicDir: false, logLevel: "error", root,
  define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  resolve: { alias: [
    ...["convex/react", "@/hooks/use-permissions", "next/link"].map(find => ({ find, replacement: hooks })),
    { find: "@", replacement: root },
  ] },
  build: { write: false, minify: false, lib: { entry: resolve(root, "playwright/visual/fixtures/supplierNavigationFixture.ts"), name: "SupplierFixture", formats: ["iife"] } },
});
const output = Array.isArray(built) ? built[0] : built;
if (!output || typeof output !== "object" || !("output" in output) || !Array.isArray(output.output)) throw new Error("Fixture bundle unavailable");
const chunk = output.output.find((item: unknown): item is { code: string } => !!item && typeof item === "object" && "code" in item && typeof item.code === "string");
if (!chunk) throw new Error("Fixture JavaScript unavailable");
writeFileSync(resolve(directory, "fixture.js"), chunk.code);
