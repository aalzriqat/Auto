import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  verifyInheritedAdvisories,
  verifyInheritedResponse,
  verifyInventory,
  verifyRuntime,
  main,
} from "./verifyPicomatchBackport.mjs";
import { runControls } from "./picomatchBackportProbe.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const temporary = path.join(root, ".tmp");
const fixtures: string[] = [];
interface Variant {
  name: string;
  version: string;
  artifact: string;
  upstreamArtifact: string;
  patch: string;
  files: Record<string, string>;
}
const policy = JSON.parse(
  readFileSync(path.join(root, "vendor/picomatch/provenance.json"), "utf8"),
) as { variants: Variant[] };

function fixture() {
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary, "picomatch-test-"));
  fixtures.push(directory);
  cpSync(path.join(root, "vendor"), path.join(directory, "vendor"), {
    recursive: true,
  });
  cpSync(path.join(root, "patches"), path.join(directory, "patches"), {
    recursive: true,
  });
  mkdirSync(path.join(directory, "dealer-worker"));
  copyFileSync(
    path.join(root, "dealer-worker/package-lock.json"),
    path.join(directory, "dealer-worker/package-lock.json"),
  );
  copyFileSync(
    path.join(root, "pnpm-lock.yaml"),
    path.join(directory, "pnpm-lock.yaml"),
  );
  const store = path.join(directory, "node_modules/.pnpm");
  mkdirSync(store, { recursive: true });
  writeFileSync(
    path.join(directory, "node_modules/.modules.yaml"),
    stringify({ virtualStoreDir: ".pnpm" }),
  );
  const installed = policy.variants.map((variant, index) => {
    const destination = path.join(
      store,
      `copy-${index}/node_modules`,
      variant.name,
    );
    mkdirSync(destination, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(root, variant.artifact),
      "--strip-components=1",
      "-C",
      destination,
    ]);
    return destination;
  });
  const lock = parse(
    readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8"),
  ) as {
    snapshots: Record<
      string,
      {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }
    >;
  };
  const consumerLinks: Array<{ link: string; variant: number }> = [];
  for (const [snapshot, record] of Object.entries(lock.snapshots)) {
    const target =
      record.dependencies?.picomatch ?? record.optionalDependencies?.picomatch;
    if (!target) continue;
    const base = snapshot.split("(")[0];
    const split = base.lastIndexOf("@");
    const name = base.slice(0, split);
    const ownerDirectory = path.join(
      store,
      `consumer-${consumerLinks.length}`,
      "node_modules",
    );
    const owner = path.join(ownerDirectory, name);
    mkdirSync(owner, { recursive: true });
    writeFileSync(
      path.join(owner, "package.json"),
      JSON.stringify({ name, version: base.slice(split + 1) }),
    );
    const variant = policy.variants.findIndex((value) =>
      target.startsWith(`${value.name}@`),
    );
    if (variant < 0)
      throw new Error("Fixture lock has an unknown picomatch target");
    const link = path.join(ownerDirectory, "picomatch");
    symlinkSync(
      installed[variant],
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    consumerLinks.push({ link, variant });
  }
  return { directory, installed, consumerLinks };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of fixtures.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(temporary) + path.sep))
      throw new Error("Unsafe fixture cleanup target");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installed picomatch backport security boundary", () => {
  it("runs the complete installed verification before publishing its measured CLI result", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ picomatch: [known] })),
    );
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      messages.push(String(value));
    });
    await main();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual({
      dependencyEdges: 12,
      installedCopies: 2,
      securityAndCompatibilityControls: 156,
      inheritedAdvisories: 1,
      remediatedByVerifiedBackport: "GHSA-fc5q-39xc-vjpf",
    });
  });
  it("joins all actual lock edges to the two complete installed variants", () => {
    const { directory } = fixture();
    const result = verifyInventory(directory);
    expect(result.edges).toBe(12);
    expect(result.copies.size).toBe(2);
    const require = createRequire(import.meta.url);
    for (const directory of result.copies.keys())
      expect(runControls(require(directory))).toBe(78);
    expect(verifyRuntime(result.copies)).toBe(156);
  });

  it("refuses an added vulnerable installed copy outside the virtual store", () => {
    const { directory } = fixture();
    const extra = path.join(directory, "node_modules/picomatch");
    mkdirSync(extra);
    execFileSync("tar", [
      "-xzf",
      path.join(root, policy.variants[1].upstreamArtifact),
      "--strip-components=1",
      "-C",
      extra,
    ]);
    expect(() => verifyInventory(directory)).toThrow(
      "Unpatched or unknown installed",
    );
  });

  it("reconstructs the same reviewed parser when Git checks patches out with CRLF", () => {
    const { directory } = fixture();
    for (const variant of policy.variants) {
      const patch = path.join(directory, variant.patch);
      writeFileSync(
        patch,
        readFileSync(patch, "utf8").replace(/\r?\n/g, "\r\n"),
      );
    }
    expect(verifyInventory(directory).copies.size).toBe(2);
  });

  it("refuses a changed hash manifest that tries to bless unpatched parser bytes", () => {
    const { directory, installed } = fixture();
    const baseline = path.join(directory, "original-policy-control");
    mkdirSync(baseline);
    execFileSync("tar", [
      "-xzf",
      path.join(root, policy.variants[0].upstreamArtifact),
      "--strip-components=1",
      "-C",
      baseline,
    ]);
    const original = readFileSync(path.join(baseline, "lib/parse.js"));
    writeFileSync(path.join(installed[0], "lib/parse.js"), original);
    const manifestFile = path.join(
      directory,
      "vendor/picomatch/provenance.json",
    );
    const forged = JSON.parse(readFileSync(manifestFile, "utf8"));
    forged.variants[0].files["lib/parse.js"] = createHash("sha256")
      .update(original)
      .digest("hex");
    writeFileSync(manifestFile, JSON.stringify(forged));
    expect(() => verifyInventory(directory)).toThrow(
      "readable patch does not reproduce",
    );
  });

  it("refuses a readable patch that also changes an unrelated file even if its hash is updated", () => {
    const { directory } = fixture();
    const patch = path.join(directory, policy.variants[0].patch);
    const changedPatch =
      readFileSync(patch, "utf8") +
      "\ndiff --git a/unexpected.js b/unexpected.js\nnew file mode 100644\n--- /dev/null\n+++ b/unexpected.js\n@@ -0,0 +1 @@\n+module.exports = true;\n";
    writeFileSync(patch, changedPatch);
    const manifestFile = path.join(
      directory,
      "vendor/picomatch/provenance.json",
    );
    const changed = JSON.parse(readFileSync(manifestFile, "utf8"));
    changed.variants[0].patchSha256 = createHash("sha256")
      .update(changedPatch.replace(/\r\n/g, "\n"))
      .digest("hex");
    writeFileSync(manifestFile, JSON.stringify(changed));
    expect(() => verifyInventory(directory)).toThrow(
      "changes files outside the parser",
    );
  });

  it("refuses replacement of patched parser bytes by the original vulnerable parser", () => {
    const { directory, installed } = fixture();
    const baseline = path.join(directory, "original-v2");
    mkdirSync(baseline);
    execFileSync("tar", [
      "-xzf",
      path.join(root, policy.variants[0].upstreamArtifact),
      "--strip-components=1",
      "-C",
      baseline,
    ]);
    copyFileSync(
      path.join(baseline, "lib/parse.js"),
      path.join(installed[0], "lib/parse.js"),
    );
    expect(() => verifyInventory(directory)).toThrow(
      "Installed backport bytes differ",
    );
  });

  it("refuses a missing installed major", () => {
    const { directory, installed } = fixture();
    unlinkSync(path.join(installed[1], "package.json"));
    expect(() => verifyInventory(directory)).toThrow("variants are missing");
  });

  it("refuses a tampered backport archive before reading or executing its contents", () => {
    const { directory } = fixture();
    writeFileSync(
      path.join(directory, policy.variants[0].artifact),
      "not the approved archive",
    );
    expect(() => verifyInventory(directory)).toThrow("integrity mismatch");
  });

  it("refuses a provenance path that escapes the workspace", () => {
    const { directory } = fixture();
    const file = path.join(directory, "vendor/picomatch/provenance.json");
    const changed = JSON.parse(readFileSync(file, "utf8"));
    changed.variants[0].patch = "../outside.patch";
    writeFileSync(file, JSON.stringify(changed));
    expect(() => verifyInventory(directory)).toThrow("path escapes its root");
  });

  it("refuses a consumer wired to the wrong major even when both valid copies exist", () => {
    const { directory, installed, consumerLinks } = fixture();
    const consumer = consumerLinks.find((value) => value.variant === 1);
    if (
      !consumer ||
      !path
        .resolve(consumer.link)
        .startsWith(path.resolve(directory) + path.sep)
    )
      throw new Error("Missing safe consumer fixture");
    rmSync(consumer.link, { recursive: true, force: true });
    symlinkSync(
      installed[0],
      consumer.link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      JSON.parse(readFileSync(path.join(installed[1], "package.json"), "utf8"))
        .name,
    ).toBe("@autoflow/picomatch-v4");
    expect(() => verifyInventory(directory)).toThrow(
      "consumer resolves the wrong",
    );
  });

  it("refuses an unexpected executable file in an otherwise valid backport", () => {
    const { directory, installed } = fixture();
    writeFileSync(
      path.join(installed[0], "extra.cjs"),
      "throw new Error('unexpected');\n",
    );
    expect(() => verifyInventory(directory)).toThrow(
      "source inventory differs",
    );
  });

  it("refuses an unpatched dependency edge even if valid copies also exist", () => {
    const { directory } = fixture();
    const lockfile = path.join(directory, "pnpm-lock.yaml");
    const lock = parse(readFileSync(lockfile, "utf8"));
    lock.snapshots["negative-control@1.0.0"] = {
      dependencies: { picomatch: "4.0.7" },
    };
    writeFileSync(lockfile, stringify(lock));
    expect(() => verifyInventory(directory)).toThrow(
      "Unpatched picomatch dependency edge",
    );
  });

  it("refuses a residual original lock resolution even when the selected edges use both backports", () => {
    const { directory } = fixture();
    const file = path.join(directory, "pnpm-lock.yaml");
    const lock = parse(readFileSync(file, "utf8"));
    lock.packages["picomatch@4.0.7"] = {
      resolution: { integrity: "unaccounted-original" },
    };
    writeFileSync(file, stringify(lock));
    expect(() => verifyInventory(directory)).toThrow(
      "Unaccounted picomatch lock resolution",
    );
  });

  it("refuses a new worker picomatch path rather than omitting the separate npm tree", () => {
    const { directory } = fixture();
    const lockfile = path.join(directory, "dealer-worker/package-lock.json");
    const lock = JSON.parse(readFileSync(lockfile, "utf8"));
    lock.packages["node_modules/wrapper/node_modules/picomatch"] = {
      version: "4.0.7",
    };
    writeFileSync(lockfile, JSON.stringify(lock));
    expect(() => verifyInventory(directory)).toThrow(
      "Worker picomatch resolution",
    );
  });

  it("refuses empty runtime evidence", () => {
    expect(() => verifyRuntime(new Map())).toThrow(
      "No backport runtime controls executed",
    );
  });

  it("refuses a subprocess that cannot load the selected module instead of reporting zero passing controls", () => {
    const { directory } = fixture();
    expect(() =>
      verifyRuntime(new Map([[path.join(directory, "missing-module"), null]])),
    ).toThrow("security/compatibility control failed");
  });
});

const known = {
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  title:
    "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
  severity: "high",
  vulnerable_versions: "<=4.0.7",
};

describe("inherited advisory coverage", () => {
  it("recognizes only the independently verified known advisory contract", () => {
    expect(verifyInheritedResponse({ picomatch: [known] })).toBe(1);
  });
  it("refuses a changed scope for the same advisory", () => {
    expect(() =>
      verifyInheritedResponse({
        picomatch: [{ ...known, vulnerable_versions: "<=4.0.8" }],
      }),
    ).toThrow("advisory changed");
  });
  it("refuses new inherited high advisories after a fork changes the registry name", () => {
    expect(() =>
      verifyInheritedResponse({
        picomatch: [
          known,
          {
            ...known,
            url: "https://github.com/advisories/GHSA-new1-new2-new3",
          },
        ],
      }),
    ).toThrow("New inherited");
  });
  it("refuses unrecognized severity instead of treating it as low", () => {
    expect(() =>
      verifyInheritedResponse({ picomatch: [{ ...known, severity: "HIGH" }] }),
    ).toThrow("incomplete");
  });
  it("refuses malformed advisory records", () => {
    expect(() => verifyInheritedResponse({ picomatch: [{}] })).toThrow(
      "incomplete",
    );
  });
  it("fails closed on registry failure and on absent response evidence", async () => {
    await expect(
      verifyInheritedAdvisories(
        async () => new Response("unavailable", { status: 503 }),
      ),
    ).rejects.toThrow("registry is unavailable");
    await expect(
      verifyInheritedAdvisories(async () => new Response("", { status: 200 })),
    ).rejects.toThrow("evidence is unavailable");
  });
});
