import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Proves, with no credential present, which files the trusted Convex CLI's
 * bundler reads when it deploys the staged candidate backend (SCRUM-350 F1).
 *
 * A candidate import is an instruction to the bundler to read a file. An
 * absolute import, or a JSON import attribute on an extensionless path, makes
 * esbuild read anything the process can see — and in the deploy container that
 * includes `/proc/self/environ`, whose contents esbuild then prints in its own
 * parse error. So before any key exists, this runs the CLI's OWN esbuild
 * invocation (`innerEsbuild`, with its server-only and wasm plugins — the same
 * options, shims and esbuild the deploy uses) over the same read-only mounts,
 * on a SUPERSET of the CLI's entry points, and refuses unless:
 *
 * - every bundle succeeds (a failed resolution or parse is how an outside read
 *   hides from the input list, so any error is a refusal), and
 * - every recorded input resolves, after following links, inside the staged
 *   backend directories or the trusted node_modules.
 *
 * Resolution is deterministic over the same files, and the stage pins every
 * tsconfig the bundler consults, so the credential-bearing deploy that follows
 * reads the same inputs this proved.
 *
 * Run it with the stage as the working directory. Output reaches public logs;
 * this container holds no secret, and it prints counts and candidate paths only.
 */

export const AUDIT_ALLOWED_DIRECTORIES = Object.freeze([
  "convex",
  "lib",
  "packages/shared/src",
  "node_modules",
]);

// The CLI's entry-point extensions (convex/dist/cjs/bundler/index.js).
const ENTRY_POINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];
// Bundled by the CLI outside its function entry points: schema, component
// definition and auth config (all with the default "browser" platform). The
// component pass (cli/lib/components/definition/bundle.js componentGraph and
// bundleDefinitions) calls esbuild directly rather than innerEsbuild, but with
// the same platform and conditions; its componentPlugin resolves through
// build.resolve, esbuild's own resolver, and in bundle mode marks component
// imports external. Bundling convex.config.ts here therefore reads what that
// pass reads from the candidate's file (Sonnet C1 on PR #341).
const CONFIG_ENTRIES = ["schema", "convex.config", "auth.config"];
// The CLI's determineEnvironment crashes on "use node" in these, and on a file
// under actions/ without it. The audit refuses the same shapes rather than
// certify a partition the deploy never produces (Sonnet F1 on PR #341).
const MUST_BE_ISOLATE = ["http", "crons", "schema", "auth.config"];
const ACTIONS_PREFIX = "actions/";
// The CLI's per-line fallback, used only when its parser rejects the source.
const USE_NODE_LINE = /^\s*("|')use node("|');?\s*$/;

/**
 * The CLI's own "use node" test (bundler/index.js hasUseNodeDirective): a
 * real module directive by its @babel/parser, else a whole-line match. The
 * platform decides package resolution, so the audit must pick the same one
 * the deploy does; a comment that merely contains the text is not a
 * directive (Sol R1 on PR #341).
 */
function hasUseNodeDirective(parse, source) {
  if (source.indexOf("use node") === -1) return false;
  try {
    const ast = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
    return ast.program.directives.map((d) => d.value.value).includes("use node");
  } catch {
    return source.split("\n").some((line) => USE_NODE_LINE.test(line));
  }
}

export class AuditRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditRefusal";
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  // Compare the first segment: "..foo" is a child named "..foo", not a parent.
  const escapes = relative === ".." || relative.startsWith(".." + path.sep);
  return relative === "" || (!escapes && !path.isAbsolute(relative));
}

/**
 * Every file the CLI would bundle from convex/, and more: nested component
 * directories are walked rather than skipped, and files the CLI would drop for
 * having no import or export are kept. A superset can only refuse more.
 */
function entryPointSuperset(dir, parse) {
  const isolate = [];
  const node = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (relative !== "_generated") visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = ENTRY_POINT_EXTENSIONS.find((ext) => entry.name.endsWith(ext));
      if (!extension) continue;
      const stem = entry.name.slice(0, -extension.length);
      const isConfig = relative === stem + extension && CONFIG_ENTRIES.includes(stem);
      // Test files and other multi-dot names are not entry points.
      if (!isConfig && stem.includes(".")) continue;
      const useNode = hasUseNodeDirective(parse, readFileSync(full, "utf8"));
      if (useNode && MUST_BE_ISOLATE.includes(relative.replace(/\.[^/.]+$/, ""))) {
        throw new AuditRefusal('"use node" is not allowed in ' + JSON.stringify(relative) + "; the deploy refuses it too.");
      }
      if (!useNode && !isConfig && relative.startsWith(ACTIONS_PREFIX)) {
        throw new AuditRefusal(JSON.stringify(relative) + ' is under actions/ without "use node"; the deploy refuses it too.');
      }
      if (!isConfig && useNode) node.push(full);
      else isolate.push(full);
    }
  };
  visit(dir);
  return { isolate: isolate.sort(), node: node.sort() };
}

/**
 * @param {{ stageRoot: string }} options
 * @returns {Promise<{ inputs: number, entryPoints: number }>}
 */
export async function auditStagedBackendInputs({ stageRoot }) {
  if (!stageRoot || !path.isAbsolute(stageRoot)) {
    throw new AuditRefusal("Stage root must be an absolute path.");
  }
  if (path.resolve(process.cwd()) !== path.resolve(stageRoot)) {
    // esbuild reports inputs relative to the working directory.
    throw new AuditRefusal("The audit must run with the stage as its working directory.");
  }
  const bundlerPath = path.join(stageRoot, "node_modules/convex/dist/cjs/bundler/index.js");
  if (!existsSync(bundlerPath)) {
    throw new AuditRefusal("The trusted Convex bundler is not mounted in the stage.");
  }
  const bundlerDir = path.dirname(bundlerPath);
  const load = (name) => createRequire(import.meta.url)(path.join(bundlerDir, name));
  const { innerEsbuild } = load("debugBundle.js");
  const { serverOnlyPlugin } = load("serverOnly.js");
  const { wasmPlugin } = load("wasm.js");

  const dir = path.join(stageRoot, "convex");
  // The CLI's own parser, resolved from the trusted convex package.
  const { parse } = createRequire(realpathSync(path.join(stageRoot, "node_modules/convex/package.json")))(
    "@babel/parser",
  );
  const { isolate, node } = entryPointSuperset(dir, parse);
  if (isolate.length === 0) {
    throw new AuditRefusal("The staged backend has no entry points.");
  }

  const recorded = new Set();
  for (const [platform, entryPoints] of [["browser", isolate], ["node", node]]) {
    if (entryPoints.length === 0) continue;
    let result;
    try {
      result = await innerEsbuild({
        entryPoints,
        platform,
        dir,
        generateSourceMaps: true,
        chunksFolder: "_deps",
        extraConditions: [],
        // The CLI's external plugin is a no-op with no external packages
        // configured (this repository has no convex.json).
        plugins: [serverOnlyPlugin, wasmPlugin],
        includeSourcesContent: false,
        splitting: false,
        logLevel: "silent",
      });
    } catch {
      // A failed resolution or parse is how an outside read hides from the
      // input list, so it is a refusal, never a pass. esbuild's own message
      // is not printed: it can carry the text of the file it failed on.
      throw new AuditRefusal("The trusted bundler refused the staged backend.");
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      // Plugin namespaces (server-only-stub:, wasm-binary:, async-hooks-shim:)
      // are generated contents, not files.
      if (/^[a-z-]+:/.test(input) && !/^[A-Za-z]:[\\/]/.test(input)) continue;
      recorded.add(path.resolve(stageRoot, input));
    }
  }

  const allowedRoots = AUDIT_ALLOWED_DIRECTORIES.map((name) => path.join(stageRoot, name))
    .filter((root) => existsSync(root))
    .map((root) => realpathSync(root));
  for (const input of recorded) {
    let real;
    try {
      real = realpathSync(input);
    } catch {
      throw new AuditRefusal("A bundled input could not be resolved: " + JSON.stringify(input.slice(0, 200)));
    }
    if (!allowedRoots.some((root) => isInside(root, real))) {
      throw new AuditRefusal(
        "A bundled input is outside the staged backend: " + JSON.stringify(input.slice(0, 200)),
      );
    }
  }
  if (recorded.size === 0) {
    throw new AuditRefusal("The bundler recorded no inputs; refusing a vacuous audit.");
  }
  return { inputs: recorded.size, entryPoints: isolate.length + node.length };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditStagedBackendInputs({ stageRoot: process.cwd() });
    process.stdout.write(
      "Audited " + result.inputs + " bundled inputs from " + result.entryPoints +
        " entry points; every one is inside the staged backend or trusted node_modules.\n",
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof AuditRefusal
        ? error.message
        : "Audit failed unexpectedly (" + String(error?.code ?? "no code") + ").") + "\n",
    );
    process.exit(1);
  }
}
