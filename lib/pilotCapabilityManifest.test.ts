/**
 * SCRUM-810: the pilot capability manifest keeps the server switches, the UI and the
 * refusal copy in step. Each test below fails when one layer drifts from another.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { PILOT_CAPABILITIES, PILOT_SWITCHES } from "./pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, accept: (rel: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, accept, out);
    else if (accept(rel)) out.push(rel);
  }
  return out;
}

const isSource = (rel: string) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !rel.endsWith(".d.ts");

/** Every switch the repository declares: boolean constants plus the keys of the two door maps. */
function declaredSwitches(): string[] {
  const names = new Set<string>();
  for (const rel of [...walk("convex", isSource), ...walk("lib", isSource)]) {
    const text = read(rel);
    for (const m of text.matchAll(/^export const (\w+_PILOT_(?:DISABLED|REQUIRED|REFUSED))\s*=\s*(true|false)\b/gm)) {
      names.add(m[1]!);
    }
    for (const m of text.matchAll(/^export const \w+_PILOT_DISABLED\s*=\s*\{([\s\S]*?)\n\}\s*as const/gm)) {
      for (const k of m[1]!.matchAll(/^\s*(\w+_PILOT_DISABLED):\s*(?:true|false)/gm)) names.add(k[1]!);
    }
  }
  return [...names].sort();
}

/** The body of `export const <fn> = mutation(...)` up to the next top-level export. */
function doorSource(moduleName: string, fn: string): string {
  const text = read(`convex/${moduleName}.ts`);
  const start = text.search(new RegExp(`^export const ${fn} = \\w+\\(`, "m"));
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(/^export (?:const|async function|function) /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("pilot capability manifest", () => {
  test("discovery: every declared pilot switch is registered", () => {
    const registered = new Set(Object.keys(PILOT_SWITCHES));
    const missing = declaredSwitches().filter((name) => !registered.has(name));
    expect(missing, `register these in lib/pilotCapabilityManifest.ts: ${missing.join(", ")}`).toEqual([]);
  });

  test("discovery: every registered switch exists in the source and belongs to exactly one capability", () => {
    const declared = new Set(declaredSwitches());
    const owners = new Map<string, string[]>();
    for (const cap of PILOT_CAPABILITIES) {
      for (const key of cap.switches) owners.set(key, [...(owners.get(key) ?? []), cap.id]);
    }
    for (const key of Object.keys(PILOT_SWITCHES)) {
      expect(declared.has(key), `${key} is registered but not declared in convex/ or lib/`).toBe(true);
      expect(owners.get(key), `${key} must belong to exactly one capability`).toHaveLength(1);
    }
    expect(PILOT_CAPABILITIES.map((c) => c.id)).toEqual([...new Set(PILOT_CAPABILITIES.map((c) => c.id))]);
  });

  test("copy: every refusal key has English and Arabic text, and the Arabic is a real translation", () => {
    const en = commonEn as Record<string, string>;
    const ar = commonAr as Record<string, string>;
    for (const cap of PILOT_CAPABILITIES) {
      expect(cap.refusalKeys.length + (cap.refusalCopy ? 1 : 0), `${cap.id} needs refusal copy`).toBeGreaterThan(0);
      if (cap.refusalCopy) {
        expect(cap.refusalCopy.ar, `${cap.id} Arabic`).toMatch(/[؀-ۿ]/);
        expect(cap.refusalCopy.ar).not.toBe(cap.refusalCopy.en);
      }
      for (const key of cap.refusalKeys) {
        expect(en[key]?.trim(), `${key} English`).toBeTruthy();
        expect(ar[key]?.trim(), `${key} Arabic`).toBeTruthy();
        expect(ar[key], `${key} Arabic must not equal the English text`).not.toBe(en[key]);
        expect(ar[key], `${key} Arabic must contain Arabic script`).toMatch(/[؀-ۿ]/);
      }
    }
  });

  test("server: every registered door still carries its guard", () => {
    for (const cap of PILOT_CAPABILITIES) {
      for (const door of cap.doors) {
        const [moduleName, fn] = door.name.split(".") as [string, string];
        const src = doorSource(moduleName, fn);
        expect(src.length, `${door.name} was not found in convex/${moduleName}.ts`).toBeGreaterThan(0);
        expect(
          door.guards.some((g) => src.includes(g)),
          `${door.name} no longer calls any of: ${door.guards.join(", ")}`
        ).toBe(true);
      }
    }
  });

  test("ui: every caller of a whole-refusing door is declared, and still holds its gate", () => {
    const wholeDoors = PILOT_CAPABILITIES.flatMap((c) => c.doors.filter((d) => d.scope === "whole"));
    const found = new Map<string, Set<string>>();
    for (const rel of [...walk("components", isSource), ...walk("app", isSource), ...walk("hooks", isSource)]) {
      const text = read(rel);
      for (const door of wholeDoors) {
        if (new RegExp(`\\bapi\\.${door.name.replace(".", "\\.")}\\b`).test(text)) {
          found.set(door.name, (found.get(door.name) ?? new Set()).add(rel));
        }
      }
    }
    for (const cap of PILOT_CAPABILITIES) {
      for (const door of cap.doors.filter((d) => d.scope === "whole")) {
        const declared = new Set((cap.uiCallers ?? []).filter((u) => u.doors.includes(door.name)).map((u) => u.file));
        expect([...(found.get(door.name) ?? [])].sort(), `UI callers of ${door.name}`).toEqual([...declared].sort());
      }
      for (const caller of cap.uiCallers ?? []) {
        const gateFile = caller.gateFile ?? caller.file;
        expect(read(gateFile).includes(caller.gate), `${gateFile} lost its gate ${caller.gate}`).toBe(true);
      }
    }
  });
});
