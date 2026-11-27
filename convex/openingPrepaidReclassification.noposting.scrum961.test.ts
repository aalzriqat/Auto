// @vitest-environment node
import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { approveArgs, approveReclass, codeOf, ledgerState, requestAndPreview, seedPrepaidReclass, type Seed } from "../test-utils/prepaidReclassificationFixture";
import schema from "./schema";

/**
 * SCRUM-961 review round 1, M1(b). When the posting engine hands back no event or no journal, the approval must refuse
 * and leave every table untouched: the advances are inserted before the posting, so only a refusal that throws (and so
 * rolls the whole mutation back) keeps them from existing without their journal.
 */
const engine = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("./accounting/postingEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounting/postingEngine")>();
  return { ...actual, postAccountingEvent: vi.fn((...args: Parameters<typeof actual.postAccountingEvent>) =>
    engine.result === null ? actual.postAccountingEvent(...args) : Promise.resolve(engine.result)) };
});

async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}

test.each([["no event and no journal", {}], ["an event but no journal", { eventId: "x" }]])("approval refuses and writes nothing when the engine returns %s", (_name, result) => withFrozenScheduler(async () => {
  const s = await seed();
  const args = approveArgs(s, await requestAndPreview(s));
  const before = await ledgerState(s);
  engine.result = result;
  try { expect(await codeOf(s.reviewer.mutation(approveReclass, args))).toContain("The reclassification was not posted."); } finally { engine.result = null; }
  expect(await ledgerState(s)).toEqual(before);
  const rows = await s.t.run((ctx) => ctx.db.query("openingPrepaidReclassifications").collect());
  expect(rows.map((candidate) => candidate.status)).toEqual(["PENDING"]);
}));