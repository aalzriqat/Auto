/**
 * The two sale rules hold DIFFERENT tax conventions on purpose (SCRUM-22), and
 * that is only safe while one of them is unreachable.
 *
 * `ruleSaleCompleted` now treats `saleAmountMinor` as tax-exclusive and bills
 * the tax on top. `ruleSaleCancelled` still treats it as tax-inclusive, because
 * it can only ever be reached by an event queued before `hookSaleCancelled`
 * became a reversal hook — and such an event must reverse what the OLD
 * convention actually posted. Aligning it would make a reversal disagree with
 * the entry it reverses and strand the tax in AR permanently.
 *
 * That reasoning collapses the moment something emits `SALE_CANCELLED` again: a
 * fresh event would be produced under the new convention and reversed under the
 * old one, silently re-opening the exact defect SCRUM-22 closed. A comment
 * cannot catch that. This scans the source instead, so wiring up an emitter
 * fails CI rather than quietly misstating revenue.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = join(__dirname, "..");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Files that emit a domain event of this type. `postDomainEvent` is the only
 * way an event reaches the posting rules, so an `eventType: "SALE_CANCELLED"`
 * anywhere outside the rule table is an emitter.
 */
function emittersOf(eventType: string): string[] {
  const emitters: string[] = [];
  for (const file of sourceFiles(CONVEX_DIR)) {
    const source = readFileSync(file, "utf8");
    // postingRules.ts necessarily NAMES the type — in the union, the ordered
    // list and the dispatch switch. Naming it is not emitting it.
    if (file.endsWith(join("accounting", "postingRules.ts"))) continue;
    if (new RegExp(`eventType:\\s*["'\`]${eventType}["'\`]`).test(source)) {
      // Normalised to forward slashes so the assertions read the same on
      // Windows and CI. The first version of this got the escaping wrong and
      // returned `accounting\workflowHooks.ts`; the self-test below is what
      // caught it, which is the whole reason it is here.
      emitters.push(file.slice(CONVEX_DIR.length + 1).split("\\").join("/"));
    }
  }
  return emitters;
}

describe("the divergent tax convention in ruleSaleCancelled stays unreachable", () => {
  test("nothing emits SALE_CANCELLED", () => {
    expect(emittersOf("SALE_CANCELLED")).toEqual([]);
  });

  test("the scan can actually find an emitter", () => {
    // Without this, the assertion above would pass just as well if the scan
    // were broken, matched nothing, or looked in the wrong directory —
    // exactly the vacuous-guard failure it is meant to prevent. SALE_COMPLETED
    // is emitted by workflowHooks.ts, so it must come back non-empty.
    expect(emittersOf("SALE_COMPLETED")).toContain("accounting/workflowHooks.ts");
  });
});
