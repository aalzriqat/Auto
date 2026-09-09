import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  DEFAULT_STORAGE_DELETE_BUDGET,
  MAX_STORAGE_CENSUS_CAP,
  MAX_STORAGE_DELETE_BUDGET,
  PURGE_ALL_STORED_FILES_CONFIRMATION,
  deleteStoredFilesBatch,
  storageCensus,
  storageZeroState,
} from "./cutoverStorageZero";

/**
 * SCRUM-306 — deployment-wide `_storage` zero.
 *
 * ⚠️ EVIDENCE BOUNDARY. Everything below is `convex-test`, i.e. REPOSITORY
 * behaviour. The harness does not enforce Convex's transaction limits, so no
 * test here can establish that an invocation fits inside a production
 * transaction. That property is argued STRUCTURALLY instead — every invocation
 * reads at most `budget` rows and writes at most `budget` deletes, whatever
 * the population size — and the tests pin the structure rather than the
 * tolerance of the harness.
 *
 * The harness also throws "Delete on non-existent doc" for a missing storage
 * id. Production's behaviour for that case is NOT established here, which is
 * exactly why the implementation only ever deletes ids it read from `_storage`
 * inside the same transaction.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

type T = ReturnType<typeof setup>;

/** Stores `count` files and returns their ids in creation order. */
async function storeFiles(t: T, count: number): Promise<Id<"_storage">[]> {
  const ids: Id<"_storage">[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await t.run((ctx) => ctx.storage.store(new Blob([`file-${i}`]))));
  }
  return ids;
}

/** Reads `_storage` directly — the independent oracle, never the code under test. */
async function liveStorageIds(t: T): Promise<Id<"_storage">[]> {
  const rows = await t.run((ctx) => ctx.db.system.query("_storage").collect());
  return rows.map((row) => row._id);
}

async function seedOrg(t: T): Promise<Id<"organizations">> {
  return await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Cutover Motors", createdAt: Date.now() }),
  );
}

async function insertVehicle(
  t: T,
  orgId: Id<"organizations">,
  vin: string,
  imageIds?: Id<"_storage">[],
): Promise<Id<"vehicles">> {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 10,
      color: "White",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 20000,
      status: "AVAILABLE",
      ...(imageIds ? { imageIds } : {}),
    }),
  );
}

/** Drives the purge to completion in bounded steps. Returns every id it deleted. */
async function purgeUntilZero(
  t: T,
  budget: number,
  maxInvocations = 50,
): Promise<{ deletedIds: Id<"_storage">[]; invocations: number }> {
  const deletedIds: Id<"_storage">[] = [];
  let invocations = 0;
  for (; invocations < maxInvocations; ) {
    const result = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget,
    });
    invocations++;
    deletedIds.push(...result.deletedIds);
    if (result.deleted === 0) break;
  }
  return { deletedIds, invocations };
}

// ─── 1. The control: database zero does not mean cutover complete ───────────

describe("the gap SCRUM-306 exists to close", () => {
  test("CONTROL: every domain row can be gone while _storage still holds files", async () => {
    const t = setup();
    const orgId = await seedOrg(t);
    const [blobId] = await storeFiles(t, 1);
    const vehicleId = await insertVehicle(t, orgId, "VIN306CONTROL", [blobId]);

    // Drive the DATABASE to zero, exactly as a row-counting reset would.
    await t.run(async (ctx) => {
      await ctx.db.delete(vehicleId);
      await ctx.db.delete(orgId);
    });

    // A row-counting proof is satisfied...
    expect(await t.run((ctx) => ctx.db.query("vehicles").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("organizations").collect())).toHaveLength(0);

    // ...while the file the tenant uploaded is still there, and now unreachable
    // from every domain row in the deployment.
    const state = await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {});
    expect(state.zero).toBe(false);
    expect(state.survivors).toContain(blobId);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", blobId))).not.toBeNull();
  });

  test("after the storage-zero phase the verifier proves zero", async () => {
    const t = setup();
    const orgId = await seedOrg(t);
    const blobIds = await storeFiles(t, 5);
    await insertVehicle(t, orgId, "VIN306AFTER", blobIds.slice(0, 2));

    await purgeUntilZero(t, 10);

    const state = await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {});
    expect(state.zero).toBe(true);
    expect(state.survivors).toEqual([]);
    // Proven independently of the verifier, against the system table itself.
    expect(await liveStorageIds(t)).toEqual([]);
  });
});

// ─── 2. Bounded, resumable, nothing skipped ─────────────────────────────────

describe("bounded batching converges without skipping", () => {
  test("a population larger than one budget converges over repeated calls", async () => {
    const t = setup();
    const stored = await storeFiles(t, 7);

    const { deletedIds, invocations } = await purgeUntilZero(t, 3);

    // Every stored file deleted exactly once — no skips, no duplicates.
    expect(new Set(deletedIds)).toEqual(new Set(stored));
    expect(deletedIds).toHaveLength(stored.length);
    expect(new Set(deletedIds).size).toBe(deletedIds.length);
    // 3 + 3 + 1, then one call that finds nothing.
    expect(invocations).toBe(4);
    expect(await liveStorageIds(t)).toEqual([]);
  });

  test("a single invocation never exceeds its budget", async () => {
    const t = setup();
    await storeFiles(t, 9);

    const first = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 4,
    });

    expect(first.deleted).toBe(4);
    expect(first.exhaustedAtReadTime).toBe(false);
    // The rest survive this invocation — the bound is real, not advisory.
    expect(await liveStorageIds(t)).toHaveLength(5);
  });

  test("an exact budget boundary leaves nothing behind and reports honestly", async () => {
    const t = setup();
    const budget = 4;
    const stored = await storeFiles(t, budget * 2);

    const first = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget,
    });
    // Exactly a full budget: the table may or may not be empty, and the result
    // says so rather than guessing.
    expect(first.deleted).toBe(budget);
    expect(first.exhaustedAtReadTime).toBe(false);

    const second = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget,
    });
    expect(second.deleted).toBe(budget);

    expect(new Set([...first.deletedIds, ...second.deletedIds])).toEqual(new Set(stored));
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(true);
  });

  test("restarting from the beginning is safe because there is no cursor to lose", async () => {
    const t = setup();
    const stored = await storeFiles(t, 6);

    // Two independent "sessions" that share no state whatsoever. A cursor-based
    // design would need the second to resume the first; this one does not.
    const a = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 2,
    });
    const b = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 2,
    });
    const c = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 2,
    });

    const all = [...a.deletedIds, ...b.deletedIds, ...c.deletedIds];
    expect(new Set(all)).toEqual(new Set(stored));
    expect(all).toHaveLength(6);
    expect(await liveStorageIds(t)).toEqual([]);

    // The contract, pinned: the destructive mutation takes no cursor argument,
    // so no caller can resume it at a wrong position.
    const args = internal.cutoverStorageZero.purgeAllStoredFiles;
    expect(JSON.stringify(args)).not.toContain("cursor");
  });

  test("a file stored between invocations is still collected by the next one", async () => {
    const t = setup();
    await storeFiles(t, 2);

    await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 5,
    });
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(true);

    // Something lands after the "done" answer — which is precisely why the
    // mutation's own report is not the proof.
    const [late] = await storeFiles(t, 1);
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(false);

    await purgeUntilZero(t, 5);
    expect(await liveStorageIds(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", late))).toBeNull();
  });
});

// ─── 3. Domain references are irrelevant under a deployment-wide wipe ────────

describe("what counts as a stored file comes only from _storage", () => {
  test("an unattached orphan blob is deleted like any other", async () => {
    const t = setup();
    // Referenced by nothing at all: no org, no row, no field anywhere.
    const [orphan] = await storeFiles(t, 1);

    await purgeUntilZero(t, 10);

    expect(await t.run((ctx) => ctx.db.system.get("_storage", orphan))).toBeNull();
  });

  test("two rows sharing one storage id still yield exactly one deletion", async () => {
    const t = setup();
    const orgId = await seedOrg(t);
    const [shared] = await storeFiles(t, 1);
    // The shared-reference case that made a delete-with-the-row strategy unsafe.
    await insertVehicle(t, orgId, "VIN306SHARED1", [shared]);
    await insertVehicle(t, orgId, "VIN306SHARED2", [shared]);

    const { deletedIds } = await purgeUntilZero(t, 10);

    // Once, not once per referencing row: the system table is the authority.
    expect(deletedIds.filter((id) => id === shared)).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", shared))).toBeNull();
  });

  test("opaque payloads and storage-like field names cannot change the outcome", async () => {
    const t = setup();
    const orgId = await seedOrg(t);
    const [real] = await storeFiles(t, 1);

    // Both blind sides of SCRUM-231's name-matching guard, in one row:
    // an ordinary string under a storage-looking key (its false positive), and
    // a storage-looking reference buried in a `v.any()` payload (its false
    // negative). Neither can reach this module, which reads no domain row.
    await t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId,
        operation: "SCRUM306_OPAQUE",
        idempotencyKey: "k1",
        status: "COMPLETED",
        result: {
          fileId: "not-a-storage-id-just-a-string",
          imageIds: ["also-not-a-storage-id"],
          attachmentRef: real,
          nested: { logoStorageId: "still-just-a-string" },
        },
        createdAt: Date.now(),
      }),
    );

    const census = await t.query(internal.cutoverStorageZero.inventoryStoredFiles, {});
    // Exactly the one real file. The four decoys added nothing, and the real
    // reference living inside an opaque field removed nothing.
    expect(census.counted).toBe(1);
    expect(census.complete).toBe(true);

    await purgeUntilZero(t, 10);
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(true);
    // The row itself is untouched: this module deletes files, not domain rows.
    expect(await t.run((ctx) => ctx.db.query("commandIdempotency").collect())).toHaveLength(1);
  });

  test("a file deleted out of band does not throw and does not block completion", async () => {
    const t = setup();
    const stored = await storeFiles(t, 3);

    // Someone else removed one first. The purge must neither double-delete it
    // nor report itself unable to finish.
    await t.run((ctx) => ctx.storage.delete(stored[1]));
    expect(await liveStorageIds(t)).toHaveLength(2);

    const { deletedIds } = await purgeUntilZero(t, 10);

    expect(deletedIds).not.toContain(stored[1]);
    expect(new Set(deletedIds)).toEqual(new Set([stored[0], stored[2]]));
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(true);
  });
});

// ─── 4. The proof is enumeration, and refusals come before destruction ───────

describe("the zero claim is enumerated, never asserted", () => {
  test("the verifier answers from _storage, disagreeing with a stale 'done'", async () => {
    const t = setup();
    const stored = await storeFiles(t, 2);

    const result = await t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
      confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
      budget: 10,
    });
    // The mutation's own report says the table was empty when it read it...
    expect(result.exhaustedAtReadTime).toBe(true);
    expect(result.deleted).toBe(2);

    // ...and a later file makes that report false while the verifier stays right.
    const [late] = await storeFiles(t, 1);
    const state = await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {});
    expect(state.zero).toBe(false);
    expect(state.survivors).toEqual([late]);
    expect(stored.every((id) => !state.survivors.includes(id))).toBe(true);
  });

  test("the verifier reports non-zero for a single surviving file", async () => {
    const t = setup();
    await storeFiles(t, 1);
    expect(
      (await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {})).zero,
    ).toBe(false);
  });

  test("the inventory is read-only and reports a truncated count as a lower bound", async () => {
    const t = setup();
    await storeFiles(t, 5);

    const truncated = await t.query(internal.cutoverStorageZero.inventoryStoredFiles, {
      cap: 2,
    });
    expect(truncated.complete).toBe(false);
    expect(truncated.counted).toBe(2); // "at least 2", never presented as a total
    expect(truncated.totalBytes).toBeNull();

    const full = await t.query(internal.cutoverStorageZero.inventoryStoredFiles, { cap: 50 });
    expect(full.complete).toBe(true);
    expect(full.counted).toBe(5);
    expect(full.totalBytes).toBeGreaterThan(0);

    // A dry run that deleted something would be the worst possible defect here.
    expect(await liveStorageIds(t)).toHaveLength(5);
  });

  test("an empty deployment reports zero honestly", async () => {
    const t = setup();
    const state = await t.query(internal.cutoverStorageZero.verifyStorageZeroState, {});
    expect(state.zero).toBe(true);
    const census = await t.query(internal.cutoverStorageZero.inventoryStoredFiles, {});
    expect(census).toMatchObject({ counted: 0, complete: true, totalBytes: 0 });
  });
});

describe("preconditions refuse before any destructive work", () => {
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["NaN — which v.number() accepts", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["over the hard ceiling", MAX_STORAGE_DELETE_BUDGET + 1],
  ])("an unusable budget (%s) refuses and deletes nothing", async (_label, budget) => {
    const t = setup();
    const stored = await storeFiles(t, 3);

    await expect(
      t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
        confirm: PURGE_ALL_STORED_FILES_CONFIRMATION,
        budget,
      }),
    ).rejects.toThrow(/budget must be an integer/);

    // The refusal came BEFORE the first delete, not after a partial one.
    expect(new Set(await liveStorageIds(t))).toEqual(new Set(stored));
  });

  test("the destructive form cannot be reached without the exact confirmation", async () => {
    const t = setup();
    const stored = await storeFiles(t, 2);

    await expect(
      t.mutation(internal.cutoverStorageZero.purgeAllStoredFiles, {
        confirm: "yes",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow();

    expect(new Set(await liveStorageIds(t))).toEqual(new Set(stored));
  });

  test("an unusable census cap refuses instead of silently truncating", async () => {
    const t = setup();
    await storeFiles(t, 1);
    await expect(
      t.query(internal.cutoverStorageZero.inventoryStoredFiles, { cap: 0 }),
    ).rejects.toThrow(/census cap must be an integer/);
    await expect(
      t.query(internal.cutoverStorageZero.inventoryStoredFiles, {
        cap: MAX_STORAGE_CENSUS_CAP + 1,
      }),
    ).rejects.toThrow(/census cap must be an integer/);
  });
});

// ─── 5. The helper SCRUM-231 composes with ──────────────────────────────────

describe("the helper SCRUM-231 calls inside its own cutover transaction", () => {
  test("deleteStoredFilesBatch runs inside a caller's transaction and is bounded", async () => {
    const t = setup();
    const stored = await storeFiles(t, 5);

    const result = await t.run((ctx) => deleteStoredFilesBatch(ctx, 2));
    expect(result.deleted).toBe(2);
    expect(result.exhaustedAtReadTime).toBe(false);
    expect(await liveStorageIds(t)).toHaveLength(3);

    await t.run((ctx) => deleteStoredFilesBatch(ctx, 10));
    expect(await liveStorageIds(t)).toEqual([]);
    expect(stored).toHaveLength(5);
  });

  test("storageZeroState and storageCensus are usable from a caller's context", async () => {
    const t = setup();
    await storeFiles(t, 2);

    expect((await t.run((ctx) => storageZeroState(ctx))).zero).toBe(false);
    expect(await t.run((ctx) => storageCensus(ctx))).toMatchObject({
      counted: 2,
      complete: true,
    });

    await t.run((ctx) => deleteStoredFilesBatch(ctx, DEFAULT_STORAGE_DELETE_BUDGET));
    expect((await t.run((ctx) => storageZeroState(ctx))).zero).toBe(true);
  });

  test("the helper refuses an unusable budget without deleting, like the mutation", async () => {
    const t = setup();
    const stored = await storeFiles(t, 2);
    await expect(
      t.run((ctx) => deleteStoredFilesBatch(ctx, Number.NaN)),
    ).rejects.toThrow(/budget must be an integer/);
    expect(new Set(await liveStorageIds(t))).toEqual(new Set(stored));
  });
});

// ─── 6. Surface: internal only ──────────────────────────────────────────────

describe("production safety boundary", () => {
  test("every registered function in this module is internal, none public", async () => {
    // `isInternal` / `isPublic` are stamped by Convex's own registration impl,
    // so this reads the platform's answer rather than re-deriving visibility
    // from the import name. Asserting against the generated `api` object cannot
    // work: it is a Proxy that manufactures a member for any name asked of it,
    // so `api.cutoverStorageZero` is never `undefined` and a test written that
    // way would pass no matter how the functions were declared.
    const moduleUnderTest = (await import("./cutoverStorageZero")) as unknown as Record<
      string,
      {
        isInternal?: boolean;
        isPublic?: boolean;
        isQuery?: boolean;
        isMutation?: boolean;
        isAction?: boolean;
      }
    >;

    const convexFunctions = Object.entries(moduleUnderTest).filter(
      ([, value]) =>
        value?.isQuery === true || value?.isMutation === true || value?.isAction === true,
    );

    // The three entry points exist and are all registered Convex functions.
    expect(convexFunctions.map(([name]) => name).sort()).toEqual([
      "inventoryStoredFiles",
      "purgeAllStoredFiles",
      "verifyStorageZeroState",
    ]);

    for (const [name, fn] of convexFunctions) {
      expect(`${name}:isInternal=${String(fn.isInternal)}`).toBe(`${name}:isInternal=true`);
      expect(`${name}:isPublic=${String(fn.isPublic)}`).toBe(`${name}:isPublic=undefined`);
    }
  });
});
