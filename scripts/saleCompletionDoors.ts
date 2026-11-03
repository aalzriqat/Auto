/**
 * SCRUM-894: derive the list of sale-completing Convex mutations from source, so a test never hand-maintains a list that can drift.
 *
 * A "door" is an exported `mutation` / `internalMutation` whose own declaration calls one of the three sale-completion entry points
 * defined in `convex/utils/saleCompletion.ts`. Any call from something that is not an exported mutation (a helper, a module-level
 * statement) is reported as unclassified, because a helper that wraps an entry point is a hidden door.
 *
 * Used by `convex/saleDoorCostDisclosureClass.scrum894.test.ts`. Lives in `scripts/` because it needs `node:fs`, which a Convex source
 * file may not import.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const COMPLETION_ENTRY_POINTS = ["completeSale", "completeSalesForLineItems", "completeExistingSale"] as const;
export const DOOR_GATE = "assertActorMayCompleteConsignedSale";
/** The module that defines the entry points; its own internals are not doors. */
const ENTRY_POINT_MODULE = "utils/saleCompletion.ts";

export interface DoorDiscovery {
  /** `module.name` of every exported mutation that calls a completion entry point. */
  doors: string[];
  /** Callers that are not an exported mutation: someone must classify them (a wrapper is a new door). */
  unclassifiedCallers: string[];
  /** Doors whose own body never runs the door permission gate. */
  doorsWithoutGate: string[];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments removed, so a sentence that mentions `completeSale(` is not a call. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Scan one file's text. `moduleName` is the path under `convex/` without its extension. */
export function discoverInSource(moduleName: string, source: string, into: DoorDiscovery & { sets?: never }): void {
  const text = withoutComments(source);
  const callPattern = new RegExp(`(?<![\\w.])(${COMPLETION_ENTRY_POINTS.join("|")})\\s*\\(`, "g");
  if (!new RegExp(callPattern.source).test(text)) return;
  const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|function)\s+(\w+)/gm;
  const starts: Array<{ name: string; index: number; exported: boolean }> = [];
  for (let m = declaration.exec(text); m; m = declaration.exec(text)) {
    starts.push({ name: m[1], index: m.index, exported: m[0].startsWith("export") });
  }
  for (let m = callPattern.exec(text); m; m = callPattern.exec(text)) {
    const callIndex = m.index;
    const owner = [...starts].reverse().find((start) => start.index <= callIndex);
    if (!owner) {
      into.unclassifiedCallers.push(`${moduleName}:<module top level>`);
      continue;
    }
    const next = starts.find((start) => start.index > owner.index);
    const body = text.slice(owner.index, next ? next.index : text.length);
    const isMutation = owner.exported && /=\s*(?:internalMutation|mutation)\s*\(/.test(body.slice(0, 400));
    const key = `${moduleName}.${owner.name}`;
    if (!isMutation) {
      into.unclassifiedCallers.push(key);
      continue;
    }
    into.doors.push(key);
    if (!body.includes(`${DOOR_GATE}(`)) into.doorsWithoutGate.push(key);
  }
}

export function discoverCompletionDoors(convexDir: string): DoorDiscovery {
  const found: DoorDiscovery = { doors: [], unclassifiedCallers: [], doorsWithoutGate: [] };
  for (const file of sourceFiles(convexDir)) {
    const rel = path.relative(convexDir, file).split(path.sep).join("/");
    if (rel === ENTRY_POINT_MODULE) continue;
    discoverInSource(rel.replace(/\.tsx?$/, ""), fs.readFileSync(file, "utf8"), found);
  }
  const unique = (xs: string[]) => [...new Set(xs)].sort();
  return {
    doors: unique(found.doors),
    unclassifiedCallers: unique(found.unclassifiedCallers),
    doorsWithoutGate: unique(found.doorsWithoutGate),
  };
}
