import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DEFAULT_NEXT_PAGE_EXTENSIONS,
  SUPPORTED_NEXT_PAGE_EXTENSIONS,
  isSupportedNextFrameworkRuntimePath,
  nextFrameworkRuntimePaths,
  resolveNextPageExtensions,
  resolveNextPageExtensionsFromInventory,
} from "../autoflow/next-runtime-entries.mjs";

function resolveSource(configPath, source) {
  return resolveNextPageExtensions({
    inventory: [configPath],
    readSource: async () => source,
  });
}

const CONFIG_FORMS = [
  [
    "next.config.js",
    'const extensions = ["mjs"]; module.exports = { pageExtensions: extensions };',
  ],
  ["next.config.mjs", 'export default { pageExtensions: ["mjs"] };'],
  [
    "next.config.ts",
    'import { withSentryConfig } from "@sentry/nextjs"; const extensions = ["mjs"] as const; const config: NextConfig = { pageExtensions: extensions }; export default withSentryConfig(config, {});',
  ],
  [
    "next.config.mts",
    'const base = { pageExtensions: ["mjs"] }; const config = { ...base }; export default config satisfies NextConfig;',
  ],
];

test("static Next.js config forms derive their configured page extensions", async (t) => {
  for (const [configPath, source] of CONFIG_FORMS) {
    await t.test(configPath, async () => {
      assert.deepEqual(await resolveSource(configPath, source), ["mjs"]);
    });
  }
});

test("absent config or pageExtensions preserves installed Next.js defaults", async () => {
  assert.deepEqual(await resolveNextPageExtensions({ inventory: [] }), [
    ...DEFAULT_NEXT_PAGE_EXTENSIONS,
  ]);
  assert.deepEqual(
    await resolveSource(
      "next.config.ts",
      'import { withSentryConfig } from "@sentry/nextjs"; const config = { strictMode: true }; export default withSentryConfig(config, {});',
    ),
    [...DEFAULT_NEXT_PAGE_EXTENSIONS],
  );
});

test("runtime entries follow configured conventions and fixed client resolution", () => {
  assert.deepEqual(nextFrameworkRuntimePaths(["mjs"]), [
    "instrumentation-client.js",
    "instrumentation-client.mjs",
    "instrumentation-client.tsx",
    "instrumentation-client.ts",
    "instrumentation-client.jsx",
    "src/instrumentation-client.js",
    "src/instrumentation-client.mjs",
    "src/instrumentation-client.tsx",
    "src/instrumentation-client.ts",
    "src/instrumentation-client.jsx",
    "instrumentation.mjs",
    "middleware.mjs",
    "proxy.mjs",
    "src/instrumentation.mjs",
    "src/middleware.mjs",
    "src/proxy.mjs",
  ]);
  assert.equal(isSupportedNextFrameworkRuntimePath("SRC\\proxy.MJS"), true);
  assert.equal(isSupportedNextFrameworkRuntimePath("proxy.mdx"), false);
  assert.equal(
    isSupportedNextFrameworkRuntimePath("instrumentation-client.cjs"),
    false,
  );
});

test("ambiguous, dynamic, empty, and unsupported configurations fail closed", async (t) => {
  const cases = [
    [
      "dynamic export",
      "export default () => ({ pageExtensions: ['mjs'] });",
      /dynamic or unsupported configuration shape/,
    ],
    [
      "dynamic extension binding",
      "let extensions = ['mjs']; export default { pageExtensions: extensions };",
      /computes pageExtensions dynamically/,
    ],
    [
      "dynamic trailing spread",
      "declare const runtime: object; export default { pageExtensions: ['mjs'], ...runtime };",
      /computes pageExtensions dynamically/,
    ],
    [
      "dynamic computed property",
      "declare const key: string; export default { [key]: ['mdx'] };",
      /computes pageExtensions dynamically/,
    ],
    [
      "unsupported object composition",
      "export default Object.assign({}, { pageExtensions: ['mdx'] });",
      /dynamic or unsupported configuration shape/,
    ],
    [
      "post-declaration mutation",
      "const config = {}; config.pageExtensions = ['mjs']; export default config;",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "CommonJS export mutation",
      "const config = {}; module.exports = config; module.exports.pageExtensions = ['mjs'];",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "prototype composition",
      "const config = {}; Object.setPrototypeOf(config, { pageExtensions: ['mjs'] }); export default config;",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "extension array push",
      "const extensions = ['js']; extensions.push('mjs'); const config = { pageExtensions: extensions }; export default config;",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "aliased extension array splice",
      "const extensions = ['js']; const alias = extensions; alias.splice(1, 0, 'mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "prototype mutator call",
      "const extensions = ['js']; Array.prototype.push.call(extensions, 'mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "reflected prototype mutator",
      "const extensions = ['js']; Reflect.apply(Array.prototype.push, extensions, ['mjs']); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "array length assignment",
      "const extensions = ['js', 'mjs']; extensions.length = 1; export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "local mutation helper",
      "const extensions = ['js']; function mutate() { extensions.push('mjs'); } mutate(); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "unknown helper receives extensions",
      "const extensions = ['js']; mutate(extensions); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "synchronous callback mutation",
      "const extensions = ['js']; [0].forEach(() => extensions.push('mjs')); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "promise callback mutation",
      "const extensions = ['js']; Promise.resolve().then(() => extensions.push('mjs')); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "named callback mutation",
      "const extensions = ['js']; function mutate() { extensions.push('mjs'); } [0].forEach(mutate); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "property-held callback mutation",
      "const extensions = ['js']; const callbacks = { mutate: () => extensions.push('mjs') }; [0].forEach(callbacks.mutate); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "destructured config member mutation",
      "const config = { pageExtensions: ['js'] }; const { pageExtensions } = config; pageExtensions.push('mjs'); export default config;",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "nested container mutation",
      "const extensions = ['js']; const box = { nested: { extensions } }; box.nested.extensions.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "property getter mutation",
      "const extensions = ['js']; const box = { get value() { extensions.push('mjs'); return 1; } }; void box.value; export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "setter dataflow mutation",
      "const extensions = ['js']; const sink = { set value(value) { value.push('mjs'); } }; sink.value = extensions; export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "constructor dataflow mutation",
      "declare const Mutator: new (value: string[]) => unknown; const extensions = ['js']; new Mutator(extensions); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "tagged template dataflow mutation",
      "declare const mutate: (parts: TemplateStringsArray, value: string[]) => unknown; const extensions = ['js']; mutate`${extensions}`; export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "loop alias mutation",
      "const extensions = ['js']; for (const alias of [extensions]) alias.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "catch alias mutation",
      "const extensions = ['js']; try { throw extensions; } catch (alias) { alias.push('mjs'); } export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "getter return alias mutation",
      "const extensions = ['js']; const box = { get value() { return extensions; } }; box.value.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "mutable binding alias mutation",
      "const extensions = ['js']; let alias = extensions; alias.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "direct eval mutation",
      "const extensions = ['js']; eval('extensions.push(\"mjs\")'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "default parameter identity mutation",
      "const extensions = ['js']; const box = { mutate(value = extensions) { value.push('mjs'); } }; box.mutate(); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "binding default identity mutation",
      "const extensions = ['js']; const [alias = extensions] = []; alias.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "class field identity mutation",
      "const extensions = ['js']; class Box { value = extensions; } const box = new Box(); box.value.push('mjs'); export default { pageExtensions: extensions };",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "CommonJS module side effect",
      "const config = { pageExtensions: ['js'] }; module.exports = config; require('./mutator.cjs');",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "dynamic import side effect",
      "const config = { pageExtensions: ['js'] }; export default config; await import('./mutator.mjs');",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "unsupported runtime value import",
      "import { mutate } from './mutator.mjs'; const config = { pageExtensions: ['js'] }; export default config; mutate();",
      /mutates or composes its configuration dynamically/,
    ],
    [
      "unknown config wrapper",
      "const config = { pageExtensions: ['mjs'] }; export default withUnknown(config);",
      /dynamic or unsupported configuration shape/,
    ],
    [
      "spoofed Sentry wrapper",
      "const withSentryConfig = (config) => ({ ...config, pageExtensions: ['mdx'] }); const config = {}; export default withSentryConfig(config);",
      /dynamic or unsupported configuration shape/,
    ],
    ["empty array", "export default { pageExtensions: [] };", /empty/],
    [
      "unsupported extension",
      "export default { pageExtensions: ['mdx'] };",
      /unsupported pageExtensions: mdx/,
    ],
    [
      "missing export",
      "const config = { pageExtensions: ['mjs'] };",
      /exactly one statically analyzable/,
    ],
  ];
  for (const [name, source, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(resolveSource("next.config.ts", source), expected);
    });
  }
  await t.test("multiple root config files", async () => {
    await assert.rejects(
      resolveNextPageExtensions({
        inventory: ["next.config.js", "next.config.ts"],
      }),
      /Multiple Next\.js config files/,
    );
  });
});

test("unrelated array operations do not make a static config ambiguous", async () => {
  const source = `
    const unrelated = [];
    unrelated.push("diagnostic");
    const extensions = ["js"];
    const copy = [...extensions];
    const normalized = unrelated.map((value) => value.toLowerCase());
    console.warn(normalized.length);
    console.warn(copy.length);
    export default { pageExtensions: extensions };
  `;
  assert.deepEqual(await resolveSource("next.config.ts", source), ["js"]);
});

test("side-effect imports conservatively scan every supported runtime extension", async () => {
  const source = `
    import "./mutator.mjs";
    const base = ["js"];
    export default { pageExtensions: [...base] };
  `;
  const extensions = await resolveSource("next.config.mjs", source);
  assert.deepEqual(extensions, [...SUPPORTED_NEXT_PAGE_EXTENSIONS]);
  assert.ok(nextFrameworkRuntimePaths(extensions).includes("proxy.mjs"));
});

test("an empty runtime import also widens the runtime extension inventory", async () => {
  const source = `
    import {} from "./mutator.mjs";
    export default { pageExtensions: ["js"] };
  `;
  assert.deepEqual(await resolveSource("next.config.mjs", source), [
    ...SUPPORTED_NEXT_PAGE_EXTENSIONS,
  ]);
});

test("unsupported runtime candidates fail even when configuration is indirect", async () => {
  await assert.rejects(
    resolveNextPageExtensions({
      inventory: ["next.config.mjs", "proxy.mdx"],
      readSource: async () =>
        'import "./mutator.mjs"; export default { pageExtensions: ["js"] };',
    }),
    /Unsupported Next\.js runtime entry candidates found: proxy\.mdx/,
  );
});

test("the synchronous inventory resolver uses the same parser", () => {
  assert.deepEqual(
    resolveNextPageExtensionsFromInventory({
      inventory: ["next.config.ts"],
      readSource: () => 'export default { pageExtensions: ["cts", "js"] };',
    }),
    ["cts", "js"],
  );
});

test("inventory and read callbacks resolve the exact root config", async () => {
  const reads = [];
  const pageExtensions = await resolveNextPageExtensions({
    inventory: async () => [
      "nested/next.config.ts",
      "lib/runtime.ts",
      "next.config.mjs",
    ],
    readSource: async (configPath) => {
      reads.push(configPath);
      return 'export default { pageExtensions: ["cts", "cts", "js"] };';
    },
  });
  assert.deepEqual(reads, ["next.config.mjs"]);
  assert.deepEqual(pageExtensions, ["cts", "js"]);
  const runtimePaths = nextFrameworkRuntimePaths(pageExtensions);
  assert.ok(runtimePaths.includes("src/proxy.cts"));
  assert.equal(runtimePaths.includes("proxy.ts"), false);
});

test("filesystem resolution reads a supported root config without executing it", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "autoflow-next-config-"));
  t.after(() => rm(rootDir, { force: true, recursive: true }));
  await writeFile(
    join(rootDir, "next.config.mjs"),
    'throw new Error("must not execute");\nexport default { pageExtensions: ["mjs"] };\n',
    "utf8",
  );

  assert.deepEqual(await resolveNextPageExtensions({ rootDir }), ["mjs"]);
});

test("filesystem discovery rejects unsupported runtime candidates under src", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "autoflow-next-config-"));
  t.after(() => rm(rootDir, { force: true, recursive: true }));
  await mkdir(join(rootDir, "src"));
  await Promise.all([
    writeFile(
      join(rootDir, "next.config.mjs"),
      'import "./setup.mjs"; export default {};',
      "utf8",
    ),
    writeFile(join(rootDir, "src", "proxy.mdx"), "", "utf8"),
  ]);

  await assert.rejects(
    resolveNextPageExtensions({ rootDir }),
    /Unsupported Next\.js runtime entry candidates found: src\/proxy\.mdx/,
  );
});
