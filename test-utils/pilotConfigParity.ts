/**
 * SCRUM-810: proves a suite is running with the SHIPPED pilot configuration.
 *
 * `PILOT_SWITCHES` reads each switch through the export the server reads, so a `vi.mock` that
 * opens a door changes what it returns. The shipped value is read from the source text of the
 * leaf module that declares the switch, which no mock can reach. A suite that claims pilot
 * certification calls `assertPilotCertifyingConfig()` in `beforeAll`; any difference throws
 * `NOT PILOT CERTIFIED`, even if every assertion in the suite would otherwise pass.
 *
 * A suite that must open a door (a historical lifecycle suite) cannot satisfy SCRUM-760 G2/G3/G7.
 * It carries the header `NON-PILOT-CERTIFYING` (see `pilotConfigParity.test.ts`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PILOT_SWITCHES, type PilotSwitchKey } from "../lib/pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["convex/utils", "lib"];

export interface PilotConfigMismatch {
  readonly switch: PilotSwitchKey;
  readonly shipped: boolean | null;
  readonly effective: boolean;
}

let sources: string[] | null = null;
function switchSources(): string[] {
  sources ??= SOURCE_DIRS.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => readFileSync(path.join(ROOT, dir, name), "utf8"))
  );
  return sources;
}

/** The value written in source: `export const KEY = true as const` or `KEY: true,` inside a door map. */
function shippedValue(key: string): boolean | null {
  const own = new RegExp(`^export const ${key}\\s*=\\s*(true|false)\\b`, "m");
  const entry = new RegExp(`^\\s*${key}:\\s*(true|false)\\b`, "m");
  for (const text of switchSources()) {
    const hit = own.exec(text) ?? entry.exec(text);
    if (hit) return hit[1] === "true";
  }
  return null;
}

export function pilotConfigMismatches(): PilotConfigMismatch[] {
  const out: PilotConfigMismatch[] = [];
  for (const key of Object.keys(PILOT_SWITCHES) as PilotSwitchKey[]) {
    const shipped = shippedValue(key);
    const effective = PILOT_SWITCHES[key]();
    if (shipped === null || shipped !== effective) out.push({ switch: key, shipped, effective });
  }
  return out;
}

export function assertPilotCertifyingConfig(): void {
  const mismatches = pilotConfigMismatches();
  if (mismatches.length === 0) return;
  const detail = mismatches
    .map((m) => `${m.switch} (shipped ${m.shipped === null ? "not found in source" : m.shipped}, effective ${m.effective})`)
    .join("; ");
  throw new Error(`NOT PILOT CERTIFIED: this suite runs with a pilot configuration that differs from the shipped one: ${detail}`);
}
