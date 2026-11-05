import { beforeAll } from "vitest";
import { assertPilotCertifyingConfig } from "./pilotConfigParity";
import type { PilotSwitchKey } from "../lib/pilotCapabilityManifest";

/** Register the same source-backed parity check for every pilot-certifying UI suite. */
export function beforePilotCertifyingConfig(only?: readonly PilotSwitchKey[]): void {
  // The complete cold census measured 13.60 s under V8 coverage; warm programs are reused.
  beforeAll(() => assertPilotCertifyingConfig(only), 30_000);
}
