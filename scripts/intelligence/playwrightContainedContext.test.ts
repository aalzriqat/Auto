// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContextOptions } from "@playwright/test";
import { newContainedContext } from "../../playwright/containedContext";

// SCRUM-350 G4 M-1: a context built with `browser.newContext()` inherits the
// browser-wide proxy launch arguments but NOT the project's `serviceWorkers:
// "block"`. Every spec must therefore build its own contexts through the one
// helper that applies it.

const root = path.resolve(__dirname, "../..", "playwright");
const HELPER = path.join(root, "containedContext.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [full] : [];
  });
}

/** Strip comments so prose that mentions `browser.newContext()` is not a call. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("playwright specs build contexts only through newContainedContext (M-1)", () => {
  it("scans a non-trivial set of files", () => {
    expect(sourceFiles(root).length).toBeGreaterThan(15);
  });

  it("no file outside the helper calls .newContext(, .newPage( on a browser, or launches a browser", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      if (file === HELPER) continue;
      const text = code(file);
      if (/\.newContext\s*\(/.test(text)) offenders.push(`${path.relative(root, file)}: .newContext(`);
      if (/\bbrowser\s*\.\s*newPage\s*\(/.test(text)) offenders.push(`${path.relative(root, file)}: browser.newPage(`);
      if (/\.launch\s*\(/.test(text)) offenders.push(`${path.relative(root, file)}: .launch(`);
    }
    expect(offenders).toEqual([]);
  });

  it("the helper itself applies the shared containment options last", () => {
    const text = code(HELPER);
    expect(text).toContain("EGRESS_CONTEXT_OPTIONS");
    expect(text).toMatch(/\{\s*\.\.\.options,\s*\.\.\.EGRESS_CONTEXT_OPTIONS\s*\}/);
  });

  it("helper blocks service workers, keeps the caller's other options and cannot be overridden", async () => {
    const seen: BrowserContextOptions[] = [];
    const browser = {
      newContext: async (options: BrowserContextOptions) => {
        seen.push(options);
        return {} as never;
      },
    } as unknown as Browser;

    await newContainedContext(browser, { storageState: "playwright/.auth/user.json", viewport: { width: 1, height: 2 } });
    await newContainedContext(browser);
    await newContainedContext(browser, { serviceWorkers: "allow" });

    expect(seen[0]).toMatchObject({
      storageState: "playwright/.auth/user.json",
      viewport: { width: 1, height: 2 },
      serviceWorkers: "block",
    });
    expect(seen[1]).toEqual({ serviceWorkers: "block" });
    expect(seen[2]?.serviceWorkers).toBe("block");
  });
});
