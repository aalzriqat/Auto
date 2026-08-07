// TEMPORARY — negative control for the production-build CI gate. Delete me.
//
// Attempt 2. Attempt 1 (declaring `params` as a plain object instead of a
// Promise) did NOT fail the build — Next 16's generated route types did not
// reject it. Recording that here because it disproves the justification the
// gate's comment originally claimed.
//
// This one imports a Node built-in into a client component. `tsc --noEmit`
// resolves `fs` fine via @types/node; the browser bundle cannot.
"use client";

import { readFileSync } from "fs";

export default function ProveGatePage() {
  return <div>{readFileSync("/etc/hostname", "utf8")}</div>;
}
