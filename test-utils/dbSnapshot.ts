/**
 * Full-content snapshot of tables, for "a refusal wrote nothing" assertions
 * (SCRUM-705).
 *
 * Comparing row COUNTS before and after cannot see an in-place modification: a
 * refused mutation that patched an existing row (a status, an amount, a
 * revision) leaves every count unchanged and the assertion green. This reads the
 * rows themselves, ordered by `_id`, so any inserted, deleted or modified row
 * makes two snapshots differ.
 *
 * Callers pass the table names (usually `Object.keys(schema.tables)`).
 */
type Collectable = { collect(): Promise<Array<{ _id: string }>> };
type SnapshotCtx = { db: { query(table: never): unknown } };
type Runnable = { run<T>(fn: (ctx: never) => Promise<T>): Promise<T> };

export type DbSnapshot = Record<string, unknown[]>;

export async function dbSnapshot(t: unknown, tables: readonly string[]): Promise<DbSnapshot> {
  return await (t as Runnable).run(async (rawCtx) => {
    const ctx = rawCtx as SnapshotCtx;
    const snapshot: DbSnapshot = {};
    for (const name of tables) {
      const rows = await (ctx.db.query(name as never) as Collectable).collect();
      snapshot[name] = [...rows].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    }
    return snapshot;
  });
}
