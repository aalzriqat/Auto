import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GHSA = "GHSA-fc5q-39xc-vjpf";
const VERSIONS = ["2.3.2", "4.0.4", "4.0.7"];
const NAMES = ["@autoflow/picomatch-v2", "@autoflow/picomatch-v4"];
const IDENTITIES = [
  [NAMES[0], "2.3.2-autoflow.1", "2.3.2"],
  [NAMES[1], "4.0.7-autoflow.1", "4.0.7"],
];
// Independently retrieved from main 0406a7efc2751e2eb61ca652f552844218ac1fc7.
// A changed graph needs a reviewed compatibility baseline, not self-attestation
// from its replacement targets. Each parent had exactly one picomatch edge.
const BASELINE_CONSUMERS = new Map([
  ["@dotenvx/dotenvx@1.71.2", [4, "dependencies"]],
  ["@expo/cli@57.0.6", [4, "dependencies"]],
  ["@expo/metro-config@57.0.3", [4, "dependencies"]],
  ["@rollup/plugin-commonjs@28.0.1", [4, "dependencies"]],
  ["@rollup/pluginutils@5.4.0", [4, "dependencies"]],
  ["anymatch@3.1.3", [2, "dependencies"]],
  ["fdir@6.5.0", [4, "optionalDependencies"]],
  ["jest-util@29.7.0", [2, "dependencies"]],
  ["micromatch@4.0.8", [2, "dependencies"]],
  ["tinyglobby@0.2.17", [4, "dependencies"]],
  ["vite@8.1.6", [4, "dependencies"]],
  ["vitest@4.1.9", [4, "dependencies"]],
]);
const UPSTREAM = {
  "2.3.2": {
    commit: "9ca61909ab0ec680953e21bac80a6e825e1ede81",
    pull: 263,
    integrity:
      "sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==",
  },
  "4.0.7": {
    commit: "3222059ac27492d9c0147fee5c65f751bbd851ab",
    pull: 262,
    integrity:
      "sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==",
  },
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const digest = (file, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(readFileSync(file)).digest(encoding);
const patchDigest = (file) =>
  createHash("sha256")
    .update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
const refuse = (message) => {
  throw new Error(message);
};

function inside(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative))
    refuse("Invalid provenance path.");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep))
    refuse("Provenance path escapes its root.");
  return resolved;
}

function verifyReconstruction(root, variant) {
  const git = resolveGit();
  const tar =
    process.platform === "win32"
      ? path.win32.join(
          process.env.SystemRoot ?? String.raw`C:\Windows`,
          "System32",
          "tar.exe",
        )
      : "/usr/bin/tar";
  if (!git || !existsSync(tar))
    refuse("Native archive/patch verification tools are unavailable.");
  const upstream = UPSTREAM[variant.upstreamVersion];
  if (
    !upstream ||
    upstream.integrity !== variant.upstreamIntegrity ||
    upstream.commit !== variant.upstreamPatchCommit
  )
    refuse("Unrecognized upstream source provenance.");
  const archive = inside(root, variant.upstreamArtifact);
  const patch = inside(root, variant.patch);
  const prefix = path.join(tmpdir(), "autoflow-picomatch-rebuild-");
  const staged = mkdtempSync(prefix);
  const options = {
    cwd: staged,
    timeout: 10000,
    encoding: "utf8",
    windowsHide: true,
  };
  try {
    const files = execFileSync(tar, ["-tzf", archive], options)
      .trim()
      .split(/\r?\n/);
    if (
      !files.every((file) => file.startsWith("package/")) ||
      JSON.stringify(
        files
          .map((file) => file.slice(8))
          .toSorted((a, b) => a.localeCompare(b)),
      ) !==
        JSON.stringify(
          Object.keys(variant.files).toSorted((a, b) => a.localeCompare(b)),
        )
    ) {
      refuse("Fork changes the upstream file inventory.");
    }
    execFileSync(
      tar,
      ["-xzf", archive, "--strip-components=1", "-C", staged],
      options,
    );
    const normalizedPatch = path.join(staged, "security.patch");
    writeFileSync(
      normalizedPatch,
      readFileSync(patch, "utf8").replaceAll("\r\n", "\n"),
    );
    const changes = execFileSync(
      git,
      ["apply", "--numstat", normalizedPatch],
      options,
    ).trim();
    if (!/^\d+\t\d+\tlib\/parse\.js$/.test(changes))
      refuse("Security patch changes files outside the parser.");
    execFileSync(git, ["apply", "--no-index", normalizedPatch], options);
    // These retained fork archives contain CRLF parser bytes. Git's output
    // varies with host configuration; reconstruct the canonical bytes before
    // hashing, while leaving every other upstream file byte-for-byte intact.
    const parser = path.join(staged, "lib/parse.js");
    writeFileSync(
      parser,
      readFileSync(parser, "utf8").replace(/\r?\n/g, "\r\n"),
    );
    const manifest = json(path.join(staged, "package.json"));
    manifest.name = variant.name;
    manifest.version = variant.version;
    manifest.private = true;
    manifest.description = `AutoFlow-maintained security backport of picomatch ${variant.upstreamVersion}; not an upstream release`;
    delete manifest.scripts;
    delete manifest.devDependencies;
    manifest.autoflowUpstream = {
      name: "picomatch",
      version: variant.upstreamVersion,
      integrity: upstream.integrity,
      patch: `https://github.com/micromatch/picomatch/pull/${upstream.pull}`,
      commit: upstream.commit,
    };
    for (const [file, expected] of Object.entries(variant.files)) {
      const actual =
        file === "package.json"
          ? createHash("sha256")
              .update(JSON.stringify(manifest, null, 2) + "\n")
              .digest("hex")
          : digest(inside(staged, file));
      if (actual !== expected)
        refuse(
          `The readable patch does not reproduce the fork bytes (${variant.name}: ${file}).`,
        );
    }
  } finally {
    if (!path.resolve(staged).startsWith(path.resolve(prefix)))
      refuse("Unsafe rebuild cleanup target.");
    rmSync(staged, { recursive: true, force: true });
  }
}

function readPolicyAndLock(root) {
  const { parse } = require("yaml");
  const policy = json(path.join(root, "vendor/picomatch/provenance.json"));
  if (
    policy.formatVersion !== 1 ||
    policy.advisory !== GHSA ||
    JSON.stringify(policy.inheritedVersions) !== JSON.stringify(VERSIONS) ||
    !Array.isArray(policy.variants) ||
    policy.variants.length !== 2 ||
    JSON.stringify(
      policy.variants.map((v) => [v.name, v.version, v.upstreamVersion]),
    ) !== JSON.stringify(IDENTITIES)
  ) {
    refuse("Incomplete backport provenance.");
  }
  const lock = parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  if (!lock.packages || !lock.snapshots || !lock.importers)
    refuse("Lock inventory is unavailable.");
  return { policy, lock };
}

function verifyLockedSources(root, policy, lock) {
  const variants = new Map();
  for (const variant of policy.variants) {
    const key = `${variant.name}@file:${variant.artifact}`;
    const record = lock.packages[key];
    if (
      !record ||
      !lock.snapshots[key] ||
      record.version !== variant.version ||
      record.resolution?.integrity !== variant.integrity ||
      record.resolution?.tarball !== `file:${variant.artifact}`
    )
      refuse("Backport lock binding mismatch.");
    if (
      `sha512-${digest(inside(root, variant.artifact), "sha512", "base64")}` !==
        variant.integrity ||
      patchDigest(inside(root, variant.patch)) !== variant.patchSha256 ||
      `sha512-${digest(inside(root, variant.upstreamArtifact), "sha512", "base64")}` !==
        variant.upstreamIntegrity
    ) {
      refuse("Backport artifact, patch or upstream integrity mismatch.");
    }
    if (
      !variant.files?.["lib/parse.js"] ||
      !variant.files?.LICENSE ||
      !variant.files?.["package.json"] ||
      Object.keys(variant.files).length < 8
    )
      refuse("Backport file inventory is incomplete.");
    verifyReconstruction(root, variant);
    variants.set(key, variant);
  }
  for (const key of Object.keys(lock.packages)) {
    if (
      (key.startsWith("picomatch@") ||
        key.startsWith("@autoflow/picomatch-")) &&
      !variants.has(key)
    ) {
      refuse("Unaccounted picomatch lock resolution.");
    }
  }
  return variants;
}

function expectedConsumerBindings(lock, variants) {
  const edges = Object.entries(lock.snapshots).flatMap(([snapshot, record]) =>
    ["dependencies", "optionalDependencies"]
      .filter((kind) => record[kind]?.picomatch !== undefined)
      .map((kind) => ({
        base: snapshot.split("(")[0],
        kind,
        target: record[kind].picomatch,
      })),
  );
  if (!edges.length) refuse("No picomatch dependency edges measured.");
  const consumers = new Map();
  for (const { base, kind, target } of edges) {
    if (!variants.has(target)) refuse("Unpatched picomatch dependency edge.");
    const previous = consumers.get(base);
    if (previous && previous !== target)
      refuse("Ambiguous consumer variants require explicit resolution proof.");
    const baseline = BASELINE_CONSUMERS.get(base);
    if (
      !baseline ||
      previous ||
      baseline[1] !== kind ||
      baseline[0] !== Number(variants.get(target).upstreamVersion.split(".")[0])
    )
      refuse("Consumer compatibility baseline mismatch.");
    consumers.set(base, target);
  }
  if (consumers.size !== BASELINE_CONSUMERS.size)
    refuse("Consumer compatibility baseline is incomplete.");
  return { edges: edges.length, consumers };
}

function verifyWorkerGraph(root) {
  // Worker has its own npm graph. It currently has no picomatch consumer;
  // introducing one must add a supported backport path, never bypass this audit.
  const worker = json(path.join(root, "dealer-worker/package-lock.json"));
  if (!worker.packages || Object.keys(worker.packages).length < 2)
    refuse("Worker lock inventory is unavailable.");
  for (const [key, record] of Object.entries(worker.packages)) {
    if (
      /(?:^|\/)node_modules\/picomatch$/.test(key) ||
      record.name === "picomatch" ||
      NAMES.includes(record.name)
    )
      refuse("Worker picomatch resolution requires explicit verification.");
  }
}

function installedModuleRoots(root, lock) {
  const { parse } = require("yaml");
  const modules = path.join(root, "node_modules");
  const metadata = parse(
    readFileSync(path.join(modules, ".modules.yaml"), "utf8"),
  );
  if (typeof metadata.virtualStoreDir !== "string")
    refuse("Installed pnpm store is unavailable.");
  const store = path.resolve(modules, metadata.virtualStoreDir);
  const roots = Object.keys(lock.importers).map((importer) =>
    path.join(root, importer, "node_modules"),
  );
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (entry.isDirectory())
      roots.push(path.join(store, entry.name, "node_modules"));
  }
  return roots;
}

function collectInstalledCopies(roots, variants) {
  const copies = new Map();
  for (const modulesRoot of roots) {
    for (const name of ["picomatch", ...NAMES]) {
      const candidate = path.join(modulesRoot, name);
      if (!existsSync(path.join(candidate, "package.json"))) continue;
      const actual = realpathSync(candidate);
      const manifest = json(path.join(actual, "package.json"));
      const variant = variants.find(
        (v) => v.name === manifest.name && v.version === manifest.version,
      );
      if (!variant) refuse("Unpatched or unknown installed picomatch copy.");
      copies.set(actual, variant);
    }
  }
  if (
    copies.size === 0 ||
    !NAMES.every((name) => [...copies.values()].some((v) => v.name === name))
  ) {
    refuse("Installed backport variants are missing.");
  }
  return copies;
}

function consumerPackageFiles(base, roots) {
  const split = base.lastIndexOf("@");
  if (split < 1) refuse("Unsupported consumer package identity.");
  const name = base.slice(0, split);
  const version = base.slice(split + 1);
  const observed = new Set();
  for (const modulesRoot of roots) {
    const packageJson = path.join(modulesRoot, name, "package.json");
    if (!existsSync(packageJson)) continue;
    const realPackageJson = realpathSync(packageJson);
    if (observed.has(realPackageJson)) continue;
    const owner = json(realPackageJson);
    if (owner.name === name && owner.version === version)
      observed.add(realPackageJson);
  }
  if (!observed.size) refuse("Installed consumer resolution is unavailable.");
  return observed;
}

function verifyConsumerBindings(consumers, variants, roots, copies) {
  // Resolve from each consumer's real package directory with Node's native
  // resolver. Merely finding two good copies elsewhere does not prove that
  // the twelve dependency edges actually use the correct major.
  for (const [base, target] of consumers) {
    const expected = variants.get(target);
    for (const realPackageJson of consumerPackageFiles(base, roots)) {
      const resolved = createRequire(realPackageJson).resolve(
        "picomatch/package.json",
      );
      const actual = realpathSync(path.dirname(resolved));
      if (
        copies.get(actual)?.name !== expected.name ||
        copies.get(actual)?.version !== expected.version
      ) {
        refuse("Installed consumer resolves the wrong picomatch backport.");
      }
    }
  }
}

function packageSourceFiles(directory) {
  const actualFiles = [];
  const pending = [""];
  while (pending.length) {
    if (actualFiles.length > 40 || pending.length > 40)
      refuse("Unexpected backport file tree.");
    const relative = pending.pop();
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink())
        refuse("Unexpected link inside backport source.");
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) actualFiles.push(file);
      else refuse("Unexpected backport source entry.");
    }
  }
  return actualFiles;
}

function verifyPackageFiles(directory, variant) {
  const actualFiles = packageSourceFiles(directory);
  if (
    JSON.stringify(actualFiles.toSorted((a, b) => a.localeCompare(b))) !==
    JSON.stringify(
      Object.keys(variant.files).toSorted((a, b) => a.localeCompare(b)),
    )
  ) {
    refuse("Installed backport source inventory differs.");
  }
  for (const [file, expected] of Object.entries(variant.files)) {
    if (digest(inside(directory, file)) !== expected)
      refuse("Installed backport bytes differ.");
  }
  const manifest = json(path.join(directory, "package.json"));
  if (
    manifest.scripts ||
    manifest.dependencies ||
    manifest.optionalDependencies ||
    manifest.license !== "MIT" ||
    manifest.autoflowUpstream?.integrity !== variant.upstreamIntegrity
  ) {
    refuse("Backport package contract differs.");
  }
}

export function verifyInventory(root = ROOT) {
  const { policy, lock } = readPolicyAndLock(root);
  const variants = verifyLockedSources(root, policy, lock);
  const { edges, consumers } = expectedConsumerBindings(lock, variants);
  verifyWorkerGraph(root);
  const roots = installedModuleRoots(root, lock);
  const copies = collectInstalledCopies(roots, policy.variants);
  verifyConsumerBindings(consumers, variants, roots, copies);
  for (const [directory, variant] of copies)
    verifyPackageFiles(directory, variant);
  return { edges, copies };
}

export function verifyRuntime(copies) {
  let measured = 0;
  for (const directory of copies.keys()) {
    const run = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts/security/picomatchBackportProbe.mjs"),
        directory,
      ],
      {
        timeout: 4000,
        encoding: "utf8",
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    );
    if (run.error || run.status !== 0 || run.signal)
      refuse("Backport security/compatibility control failed.");
    const result = JSON.parse(run.stdout);
    if (result.measured !== 78)
      refuse("Backport security controls did not measure the complete set.");
    measured += result.measured;
  }
  if (measured === 0) refuse("No backport runtime controls executed.");
  return measured;
}

export function verifyInheritedResponse(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "picomatch") ||
    (body.picomatch !== undefined && !Array.isArray(body.picomatch))
  )
    refuse("Inherited advisory feed is malformed.");
  const advisories = body.picomatch ?? [];
  for (const advisory of advisories) {
    if (
      typeof advisory.url !== "string" ||
      !["info", "low", "moderate", "high", "critical"].includes(
        advisory.severity,
      ) ||
      typeof advisory.vulnerable_versions !== "string"
    )
      refuse("Inherited advisory record is incomplete.");
    if (advisory.url === `https://github.com/advisories/${GHSA}`) {
      if (
        advisory.vulnerable_versions !== "<=4.0.7" ||
        advisory.severity !== "high" ||
        advisory.title !==
          "picomatch vulnerable to ReDoS through single-branch repeated extglobs"
      ) {
        refuse("The inherited advisory changed; reassess the backport.");
      }
      continue;
    }
    if (["high", "critical"].includes(advisory.severity))
      refuse("New inherited picomatch advisory requires remediation.");
  }
  return advisories.length;
}

export async function verifyInheritedAdvisories(fetchImpl = fetch) {
  const response = await fetchImpl(
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ picomatch: VERSIONS }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) refuse("Inherited advisory registry is unavailable.");
  const text = await response.text();
  if (!text.trim() || text.length > 1024 * 1024)
    refuse("Inherited advisory evidence is unavailable.");
  return verifyInheritedResponse(JSON.parse(text));
}

export async function main() {
  const { edges, copies } = verifyInventory();
  const controls = verifyRuntime(copies);
  // This classification is valid only AFTER the exact installed source and
  // causal regressions passed. It is not a registry ignore or a fork-name pass.
  const inheritedAdvisories = await verifyInheritedAdvisories();
  console.log(
    JSON.stringify({
      dependencyEdges: edges,
      installedCopies: copies.size,
      securityAndCompatibilityControls: controls,
      inheritedAdvisories,
      remediatedByVerifiedBackport: GHSA,
    }),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.error(`Picomatch backport verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
