/**
 * SCRUM-868 P2: the vehicle import carries supplier NAMES in a spreadsheet column, and the
 * server stores no name it was not given an id for. This module is the pure bridge: it lists
 * the distinct names the file needs mapped to a supplier in the master, and turns a mapped row
 * into the ids `importBulk` takes.
 *
 * The mapping is the dealer's explicit act, one entry per distinct spelling. Nothing here
 * matches or merges names on its own (the supplier master never merges by name), and the roles
 * stay apart: a consignment supplier and an on-account creditor are separate fields with
 * separate entries, even when the same company fills both.
 */

export type ImportSupplierRole = "SOURCED" | "CREDITOR";

export interface ImportSupplierNeed {
  /** Stable key of this entry: the role plus the exact trimmed spelling. */
  key: string;
  role: ImportSupplierRole;
  name: string;
  rowCount: number;
}

export interface ImportSupplierContext {
  posting: "OPENING_STOCK" | "PURCHASE" | null;
  paymentMethod: string | null;
}

interface ImportSupplierRow {
  sourceType?: string;
  sourcedFromName?: string;
  purchaseSupplierName?: string;
  purchasePrice?: number;
}

export function importSupplierKey(role: ImportSupplierRole, name: string): string {
  return `${role}:${name.trim()}`;
}

/** True when this row opens a payable, which is the only time it names a creditor. */
function opensPayable(row: ImportSupplierRow, context: ImportSupplierContext): boolean {
  return (
    row.sourceType === "STOCK" &&
    context.posting === "PURCHASE" &&
    context.paymentMethod === "ON_ACCOUNT" &&
    Number(row.purchasePrice) > 0
  );
}

/** The role and name a row needs mapped, or null when it names no supplier the server stores. */
function needOf(
  row: ImportSupplierRow,
  context: ImportSupplierContext,
): { role: ImportSupplierRole; name: string } | null {
  if (row.sourceType === "SOURCED") {
    const name = (row.sourcedFromName ?? "").trim();
    return name ? { role: "SOURCED", name } : null;
  }
  if (opensPayable(row, context)) {
    const name = (row.purchaseSupplierName ?? "").trim();
    return name ? { role: "CREDITOR", name } : null;
  }
  return null;
}

/** Every distinct supplier name the valid rows need mapped, in first-seen order. */
export function importSupplierNeeds(
  rows: ReadonlyArray<ImportSupplierRow>,
  context: ImportSupplierContext,
): ImportSupplierNeed[] {
  const needs = new Map<string, ImportSupplierNeed>();
  for (const row of rows) {
    const need = needOf(row, context);
    if (!need) continue;
    const key = importSupplierKey(need.role, need.name);
    const existing = needs.get(key);
    if (existing) existing.rowCount += 1;
    else needs.set(key, { key, ...need, rowCount: 1 });
  }
  return [...needs.values()];
}

/** The needs that have no supplier chosen yet. The import stays blocked while any remain. */
export function unmappedImportSuppliers(
  needs: ReadonlyArray<ImportSupplierNeed>,
  mapped: Readonly<Record<string, { id: string } | undefined>>,
): ImportSupplierNeed[] {
  return needs.filter((need) => !mapped[need.key]?.id);
}

/**
 * The supplier ids one row sends. A row that needs no supplier sends none, so the server's
 * role rules (an id on a row that has no such role is refused) are never tripped by a leftover.
 */
export function importRowSupplierIds<Id extends string>(
  row: ImportSupplierRow,
  context: ImportSupplierContext,
  mapped: Readonly<Record<string, { id: Id } | undefined>>,
): { sourcedSupplierId?: Id; purchaseSupplierId?: Id } {
  const need = needOf(row, context);
  if (!need) return {};
  const id = mapped[importSupplierKey(need.role, need.name)]?.id;
  if (!id) return {};
  return need.role === "SOURCED" ? { sourcedSupplierId: id } : { purchaseSupplierId: id };
}
