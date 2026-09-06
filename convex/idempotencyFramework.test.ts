/**
 * SCRUM-57 — the economic-command idempotency invariant.
 *
 * The property under test is not "callers pass a key". It is that the SERVER
 * refuses to produce an economic effect it cannot identify, and refuses to
 * replay an identity whose canonical intent has materially changed.
 *
 * Two distinct fail-open holes existed on `main @ bf5769ed1` and each gets its
 * own failing-first test here:
 *
 *   A. `if (!idempotencyKey) return await run();` — a missing identity executed
 *      normally, so every economic command was protected only by the caller's
 *      good manners.
 *
 *   B. `if (args.fingerprint && existing.fingerprint && ...)` — the conflict
 *      check was an ALLOWLIST that failed open by omission. With no fingerprint
 *      on either side, the same key carrying a materially different amount
 *      silently replayed the first command's stored result.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { runWithIdempotency } from "./utils/idempotency";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function seedOrg() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Idempotency Fixture",
      createdAt: Date.now(),
    } as any)
  );
  return { t, orgId: orgId as Id<"organizations"> };
}

describe("SCRUM-57 A — an economic command refuses to run without an identity", () => {
  test("missing identity fails closed instead of executing", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;

    await expect(
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            // No idempotencyKey. The whole point.
            idempotencyKey: undefined as unknown as string,
            fingerprint: JSON.stringify({ amountMinor: 100 }),
          },
          async () => {
            ran += 1;
            return "moved money";
          }
        )
      )
    ).rejects.toThrow(/identity/i);

    // The economic effect must NOT have happened.
    expect(ran).toBe(0);
  });

  test("blank / whitespace identity fails closed too", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    await expect(
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "   ",
            fingerprint: JSON.stringify({ amountMinor: 100 }),
          },
          async () => {
            ran += 1;
            return "moved money";
          }
        )
      )
    ).rejects.toThrow();
    expect(ran).toBe(0);
  });

  test("a NON-economic command may still run without an identity", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const out = await t.run(async (ctx) =>
      runWithIdempotency(
        ctx,
        { orgId, operation: "test.harmless", economic: false },
        async () => {
          ran += 1;
          return "ok";
        }
      )
    );
    expect(out).toBe("ok");
    expect(ran).toBe(1);
  });
});

describe("SCRUM-57 B — identity reuse with a changed canonical intent fails closed", () => {
  test("same key + SAME intent replays exactly once", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const fp = JSON.stringify({ amountMinor: 5000, counterparty: "c1" });
    const call = () =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-1",
            fingerprint: fp,
          },
          async () => {
            ran += 1;
            return { seq: ran };
          }
        )
      );
    const first = await call();
    const second = await call();
    expect(ran).toBe(1);
    expect(second).toEqual(first);
  });

  test("same key + changed AMOUNT fails closed", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const run = (amountMinor: number) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-1",
            fingerprint: JSON.stringify({
              amountMinor,
              counterparty: "c1",
              source: "CASH",
              effectiveDate: "2026-09-06",
            }),
          },
          async () => {
            ran += 1;
            return { amountMinor };
          }
        )
      );
    await run(5000);
    await expect(run(9900)).rejects.toThrow(
      /different request content|IDEMPOTENCY_CONFLICT/i
    );
    expect(ran).toBe(1);
  });

  test("same key + changed COUNTERPARTY fails closed", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const run = (counterparty: string) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-1",
            fingerprint: JSON.stringify({
              amountMinor: 5000,
              counterparty,
              source: "CASH",
              effectiveDate: "2026-09-06",
            }),
          },
          async () => {
            ran += 1;
            return { counterparty };
          }
        )
      );
    await run("customer-a");
    await expect(run("customer-b")).rejects.toThrow();
    expect(ran).toBe(1);
  });

  test("same key + changed SOURCE fails closed", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const run = (source: string) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-1",
            fingerprint: JSON.stringify({
              amountMinor: 5000,
              counterparty: "c1",
              source,
              effectiveDate: "2026-09-06",
            }),
          },
          async () => {
            ran += 1;
            return { source };
          }
        )
      );
    await run("CASH");
    await expect(run("BANK")).rejects.toThrow();
    expect(ran).toBe(1);
  });

  test("same key + changed EFFECTIVE DATE fails closed", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const run = (effectiveDate: string) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-1",
            fingerprint: JSON.stringify({
              amountMinor: 5000,
              counterparty: "c1",
              source: "CASH",
              effectiveDate,
            }),
          },
          async () => {
            ran += 1;
            return { effectiveDate };
          }
        )
      );
    await run("2026-09-06");
    await expect(run("2026-08-01")).rejects.toThrow();
    expect(ran).toBe(1);
  });

  /**
   * Hole B in its purest form. A stored row with NO fingerprint cannot be
   * proven to describe the same intent, so an economic replay against it must
   * refuse rather than hand back a result that may have been for another amount.
   */
  test("an economic replay against a fingerprint-less stored row fails closed", async () => {
    const { t, orgId } = await seedOrg();
    await t.run(async (ctx) => {
      await ctx.db.insert("commandIdempotency", {
        orgId,
        operation: "test.economic",
        idempotencyKey: "intent-legacy",
        status: "COMPLETED",
        result: { amountMinor: 1 },
        // fingerprint deliberately absent — the legacy / no-fp shape.
        createdAt: Date.now(),
        completedAt: Date.now(),
      } as any);
    });

    let ran = 0;
    await expect(
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "intent-legacy",
            fingerprint: JSON.stringify({ amountMinor: 999999 }),
          },
          async () => {
            ran += 1;
            return { amountMinor: 999999 };
          }
        )
      )
    ).rejects.toThrow();
    expect(ran).toBe(0);
  });

  test("a genuinely NEW intent gets its own identity and runs again", async () => {
    const { t, orgId } = await seedOrg();
    let ran = 0;
    const run = (key: string) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId,
            operation: "test.economic",
            economic: true,
            idempotencyKey: key,
            fingerprint: JSON.stringify({ amountMinor: 5000 }),
          },
          async () => {
            ran += 1;
            return { seq: ran };
          }
        )
      );
    await run("intent-1");
    await run("intent-2");
    expect(ran).toBe(2);
  });

  test("identities do not leak across organizations", async () => {
    const { t, orgId } = await seedOrg();
    const otherOrgId = (await t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Other",
        createdAt: Date.now(),
      } as any)
    )) as Id<"organizations">;
    let ran = 0;
    const run = (org: Id<"organizations">) =>
      t.run(async (ctx) =>
        runWithIdempotency(
          ctx,
          {
            orgId: org,
            operation: "test.economic",
            economic: true,
            idempotencyKey: "shared-key",
            fingerprint: JSON.stringify({ amountMinor: 1 }),
          },
          async () => {
            ran += 1;
            return { ran };
          }
        )
      );
    await run(orgId);
    await run(otherOrgId);
    expect(ran).toBe(2);
  });
});
