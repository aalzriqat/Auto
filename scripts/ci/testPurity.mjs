/**
 * SCRUM-1025: which unit tests may be DROPPED when a pull request is "impacted".
 *
 * Vitest's `related` / `getRelevantTestSpecifications` follows only `import`
 * edges (static, and dynamic with a literal specifier). A test that reads source
 * as TEXT (fs, the TypeScript compiler API, directory walks, import.meta.glob,
 * paths built from the working directory) is tied to the files it inspects by no
 * import at all, so `related` can never select it. Such a test is a guard, and a
 * guard that is silently not run is the failure this gate exists to prevent.
 *
 * So the rule is fail-closed by construction: a test is droppable only when it
 * is PROVABLY a pure import-graph test. The proof is a deterministic static
 * scan of the test file and of every local module it can reach. Any hit, any
 * unreadable file, and any import the scan cannot resolve make the test
 * "always run". A scan is a regex over source text on purpose: it has no parser
 * to fail on a construct it does not know, and a false positive (a comment that
 * mentions readFileSync) only runs one more test.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { classifyPaths } from "../skillEnforcement/policy.mjs";

/** Modules whose import marks a file as one that can read files or run programs. */
const BANNED_MODULE =
  /^(?:node:)?(?:fs|fs\/promises|child_process|module|vm|worker_threads|url|v8|repl)$|^(?:fs-extra|graceful-fs|typescript|glob|globby|fast-glob|tinyglobby|execa|cross-spawn)$/;

/** Source text that reads the file system, or builds a path from the working directory. */
const TEXT_HITS = [
  { name: "import.meta file access", re: /\bimport\.meta\.(?:glob|url|dirname|filename|resolve)\b/ },
  { name: "file read call", re: /\b(?:readFile|readFileSync|readdir|readdirSync|opendir|existsSync|statSync|lstatSync|globSync|createReadStream)\b/ },
  { name: "process.cwd()", re: /\bprocess\.cwd\s*\(/ },
  { name: "__dirname/__filename", re: /\b__dirname\b|\b__filename\b/ },
  { name: "require.resolve/createRequire", re: /\brequire\.resolve\b|\bcreateRequire\b/ },
  { name: "?raw import", re: /\?raw['"`]/ },
  { name: "dynamic import with a computed specifier", re: /\bimport\s*\(\s*(?!['"`)\s])|\bimport\s*\(\s*`[^`]*\$\{/ },
];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*|\brequire\(\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*)['"]([^'"\n]+)['"]/g;

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TS_FOR_JS = new Map([[".js", [".ts", ".tsx"]], [".mjs", [".mts"]], [".cjs", [".cts"]], [".jsx", [".tsx"]]]);

/** @typedef {{ pure: boolean, kind: "pure" | "text-reading" | "unclassifiable", reason: string }} Purity */
/** @typedef {{ own: string | null, edges: string[], unresolved: string | null }} Node */

/**
 * @param {string} root  repository root
 * @param {{ isFile?: (p: string) => boolean, read?: (p: string) => string }} [io]
 */
export function createPurityScanner(root, io = {}) {
  const isFile =
    io.isFile ??
    ((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const read = io.read ?? ((p) => readFileSync(p, "utf8"));
  /** @type {Map<string, Node>} */
  const nodes = new Map();
  const toRel = (absolute) => path.relative(root, absolute).split(path.sep).join("/");

  /** First existing file for an import specifier, or null. */
  function resolveFile(base) {
    const extension = path.extname(base);
    const direct = [base, ...CODE_EXTENSIONS.map((e) => base + e), `${base}.d.ts`, `${base}.json`];
    const mapped = (TS_FOR_JS.get(extension) ?? []).map((e) => base.slice(0, -extension.length) + e);
    const indexes = CODE_EXTENSIONS.map((e) => path.join(base, `index${e}`));
    return [...direct, ...mapped, ...indexes].find(isFile) ?? null;
  }
  function resolveSpecifier(specifier, fromFile) {
    if (specifier.startsWith("@/")) return resolveFile(path.join(root, specifier.slice(2)));
    if (specifier.startsWith(".")) return resolveFile(path.resolve(path.dirname(fromFile), specifier));
    return undefined;
  }

  /** @returns {Node} */
  function scan(file) {
    const cached = nodes.get(file);
    if (cached) return cached;
    const node = { own: null, edges: [], unresolved: null };
    nodes.set(file, node);
    let text;
    try {
      text = read(file);
    } catch {
      node.unresolved = "unreadable";
      return node;
    }
    node.own = TEXT_HITS.find((hit) => hit.re.test(text))?.name ?? null;
    for (const match of text.matchAll(SPECIFIER)) collect(node, match[1], file);
    return node;
  }

  function collect(node, specifier, file) {
    const bare = specifier.startsWith("@/") || specifier.startsWith(".") ? null : specifier;
    if (bare !== null) {
      if (BANNED_MODULE.test(bare) || BANNED_MODULE.test(bare.split("/")[0])) node.own ??= `imports ${bare}`;
      return;
    }
    const resolved = resolveSpecifier(specifier, file);
    if (!resolved) node.unresolved ??= `cannot resolve ${specifier}`;
    else if (CODE_EXTENSIONS.includes(path.extname(resolved)) && !resolved.endsWith(".d.ts")) node.edges.push(resolved);
  }

  /**
   * @param {string} testFile  repo-relative, forward slashes
   * @returns {Purity}
   */
  function classify(testFile) {
    const start = path.join(root, testFile);
    const seen = new Set([start]);
    const queue = [start];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const node = scan(next);
      const where = next === start ? "" : ` via ${toRel(next)}`;
      if (node.own) return { pure: false, kind: "text-reading", reason: `${node.own}${where}` };
      if (node.unresolved) return { pure: false, kind: "unclassifiable", reason: `${node.unresolved}${where}` };
      for (const edge of node.edges) {
        if (!seen.has(edge)) {
          seen.add(edge);
          queue.push(edge);
        }
      }
    }
    return { pure: true, kind: "pure", reason: "import graph only" };
  }

  return { classify };
}

/**
 * Splits the census three ways: tests that always run because of WHAT they
 * guard (backend and gate suites, per the skill-enforcement policy), tests that
 * always run because they read source as text or cannot be classified, and the
 * provably pure import-graph tests, which are the only ones `related` may drop.
 * @param {string} root
 * @param {string[]} census
 * @param {{ classify?: (file: string) => Purity }} [scanner]
 * @returns {{ alwaysRun: string[], textReading: { file: string, purity: Purity }[], candidates: string[] }}
 */
export function partitionCensus(root, census, scanner = createPurityScanner(root)) {
  const alwaysRun = [];
  const textReading = [];
  const candidates = [];
  for (const file of census) {
    const policy = classifyPaths([file]);
    if (policy.sensitive.length > 0 || policy.gate.length > 0) {
      alwaysRun.push(file);
      continue;
    }
    const purity = scanner.classify(file);
    if (purity.pure) candidates.push(file);
    else textReading.push({ file, purity });
  }
  return { alwaysRun, textReading, candidates };
}