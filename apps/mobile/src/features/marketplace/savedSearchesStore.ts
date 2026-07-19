import * as SecureStore from "expo-secure-store";

/**
 * Local, account-free list of marketplace searches the buyer has saved on this
 * device. Mirrors {@link ./savedVehiclesStore} (anonymous, marketplace-first) —
 * pure helpers separated from SecureStore I/O so they unit-test without a native
 * module. A saved search stores the exact filter fields plus a human label built
 * at save time, so re-applying it is a one-tap re-run of the same query.
 */

const STORAGE_KEY = "autoflow.marketplace.savedSearches.v1";
/** SecureStore values are size-limited on Android; keep the newest searches only. */
export const MAX_SAVED_SEARCHES = 20;

/** The serializable filter fields of a marketplace search (strings as entered; sortBy is a union stored loosely). */
export interface SavedSearchFields {
  make: string;
  city: string;
  priceMin: string;
  priceMax: string;
  maxMonthlyPayment: string;
  transmission: string;
  fuelType: string;
  financeOnly: boolean;
  sortBy: string;
}

export interface SavedSearch {
  id: string;
  label: string;
  fields: SavedSearchFields;
  savedAt: number;
  /** When the buyer last ran/reviewed this search — cars listed after this are "new". Defaults to savedAt for older rows. */
  lastSeenAt: number;
}

/** The string-valued filter fields (everything except the boolean `financeOnly`). */
const STRING_FIELD_KEYS = [
  "make",
  "city",
  "priceMin",
  "priceMax",
  "maxMonthlyPayment",
  "transmission",
  "fuelType",
  "sortBy",
] as const;

/** Stable identity for a set of filters, so saving the same search twice dedupes instead of piling up. */
export function searchFieldsId(fields: SavedSearchFields): string {
  const stringPart = STRING_FIELD_KEYS.map((key) => `${key}=${fields[key]}`).join("&");
  return `${stringPart}&financeOnly=${fields.financeOnly}`;
}

function isSavedSearchFields(value: unknown): value is SavedSearchFields {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.financeOnly !== "boolean") return false;
  return STRING_FIELD_KEYS.every((key) => typeof record[key] === "string");
}

function isSavedSearch(value: unknown): value is SavedSearch {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.label === "string" &&
    typeof record.savedAt === "number" &&
    isSavedSearchFields(record.fields)
  );
}

/** Parses stored JSON into a clean, newest-first list, dropping malformed rows and defaulting `lastSeenAt` for rows saved before it existed. */
export function deserializeSavedSearches(raw: string | null): SavedSearch[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isSavedSearch)
      .slice(0, MAX_SAVED_SEARCHES)
      .map((item) => ({
        ...item,
        lastSeenAt: typeof item.lastSeenAt === "number" ? item.lastSeenAt : item.savedAt,
      }));
  } catch {
    return [];
  }
}

export function serializeSavedSearches(list: readonly SavedSearch[]): string {
  return JSON.stringify(list.slice(0, MAX_SAVED_SEARCHES));
}

export function isSearchSaved(list: readonly SavedSearch[], id: string): boolean {
  return list.some((item) => item.id === id);
}

/** Inserts (or refreshes) a saved search, newest first, deduped by its field-derived id. */
export function upsertSavedSearch(list: readonly SavedSearch[], entry: SavedSearch): SavedSearch[] {
  const rest = list.filter((item) => item.id !== entry.id);
  return [entry, ...rest].slice(0, MAX_SAVED_SEARCHES);
}

export function removeSavedSearch(list: readonly SavedSearch[], id: string): SavedSearch[] {
  return list.filter((item) => item.id !== id);
}

async function readRaw(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEY);
  } catch (error) {
    console.error("Failed to read saved searches", error);
    return null;
  }
}

async function writeList(list: readonly SavedSearch[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, serializeSavedSearches(list));
  } catch (error) {
    console.error("Failed to persist saved searches", error);
  }
}

export async function loadSavedSearches(): Promise<SavedSearch[]> {
  return deserializeSavedSearches(await readRaw());
}

/** Pure: stamps a saved search as reviewed now, so its "new" count resets. No-op if the id isn't present. */
export function markSearchSeenInList(list: readonly SavedSearch[], id: string, now: number): SavedSearch[] {
  return list.map((item) => (item.id === id ? { ...item, lastSeenAt: now } : item));
}

/** Saves (or refreshes) a search from its fields + a prebuilt label; returns the updated list. */
export async function saveSearch(fields: SavedSearchFields, label: string): Promise<SavedSearch[]> {
  const now = Date.now();
  const entry: SavedSearch = { id: searchFieldsId(fields), label, fields, savedAt: now, lastSeenAt: now };
  const next = upsertSavedSearch(await loadSavedSearches(), entry);
  await writeList(next);
  return next;
}

/** Marks a saved search reviewed now (clears its new-listing count) and persists. */
export async function markSearchSeen(id: string): Promise<SavedSearch[]> {
  const next = markSearchSeenInList(await loadSavedSearches(), id, Date.now());
  await writeList(next);
  return next;
}

export async function removeSavedSearchById(id: string): Promise<SavedSearch[]> {
  const next = removeSavedSearch(await loadSavedSearches(), id);
  await writeList(next);
  return next;
}
