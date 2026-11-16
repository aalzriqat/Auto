import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
async function buildFixture() {
  const root = process.cwd();
  const output = process.argv[2];
  if (!output) throw new Error("Fixture output directory required");
  const require = createRequire(resolve(root, "package.json"));
  const viteEntry = createRequire(require.resolve("vitest/package.json")).resolve("vite");
  const { build } = await import(pathToFileURL(viteEntry).href);
  await build({
    configFile: false, publicDir: false, logLevel: "error", root,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    css: { postcss: { plugins: [require("@tailwindcss/postcss")({ base: root })] } },
    resolve: { alias: {
      "convex/react": resolve(root, "playwright/visual/fixtures/supplierNavigationHooks.ts"),
      "@": root,
    } },
    build: {
      outDir: output, emptyOutDir: false, minify: false,
      lib: { entry: resolve(root, "playwright/visual/fixtures/radixDirectionFixture.ts"), name: "DirectionFixture", formats: ["iife"], fileName: () => "fixture.js", cssFileName: "fixture" },
    },
  });
}

buildFixture().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
