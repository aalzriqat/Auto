import * as SecureStore from "expo-secure-store";

/**
 * Local, account-free record of the Request Rooms this buyer has opened on this
 * device. Anonymous buyers have no Clerk account, so their publicIds live in
 * SecureStore — the Offers tab reads this to list "my requests" and to badge
 * offers that arrived since the buyer last looked (house rule: never lose the
 * buyer's link to their room).
 *
 * The pure helpers (upsert/remove/seen/unread/parse) are separated from the
 * SecureStore I/O below so they can be unit-tested without a native module.
 */

const STORAGE_KEY = "autoflow.marketplace.buyerRequests.v1";
/** SecureStore values are size-limited on Android; keep the newest rooms only. */
export const MAX_SAVED_REQUESTS = 20;

export interface SavedBuyerRequest {
  publicId: string;
  phone: string;
  make?: string;
  model?: string;
  createdAt: number;
  /** Offer count the last time the buyer opened this room — drives unread badges. */
  seenOfferCount: number;
}

function isSavedRequest(value: unknown): value is SavedBuyerRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.publicId === "string" &&
    record.publicId.length > 0 &&
    typeof record.phone === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.seenOfferCount === "number"
  );
}

/** Parses stored JSON into a clean, newest-first list, dropping malformed rows. */
export function deserializeSavedRequests(raw: string | null): SavedBuyerRequest[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedRequest).slice(0, MAX_SAVED_REQUESTS);
  } catch {
    return [];
  }
}

export function serializeSavedRequests(list: readonly SavedBuyerRequest[]): string {
  return JSON.stringify(list.slice(0, MAX_SAVED_REQUESTS));
}

/**
 * Inserts or refreshes a saved request, keeping newest first and preserving the
 * existing seenOfferCount so re-saving a room doesn't wrongly clear its unread
 * badge. Metadata (make/model) is updated from the newer entry.
 */
export function upsertSavedRequest(
  list: readonly SavedBuyerRequest[],
  entry: SavedBuyerRequest
): SavedBuyerRequest[] {
  const existing = list.find((item) => item.publicId === entry.publicId);
  const merged: SavedBuyerRequest = existing
    ? { ...entry, seenOfferCount: existing.seenOfferCount }
    : entry;
  const rest = list.filter((item) => item.publicId !== entry.publicId);
  return [merged, ...rest].slice(0, MAX_SAVED_REQUESTS);
}

export function removeSavedRequest(
  list: readonly SavedBuyerRequest[],
  publicId: string
): SavedBuyerRequest[] {
  return list.filter((item) => item.publicId !== publicId);
}

/** Records that the buyer has now seen `offerCount` offers in this room. */
export function markRequestSeen(
  list: readonly SavedBuyerRequest[],
  publicId: string,
  offerCount: number
): SavedBuyerRequest[] {
  return list.map((item) =>
    item.publicId === publicId ? { ...item, seenOfferCount: Math.max(offerCount, 0) } : item
  );
}

/** Unread = offers that arrived since the buyer last opened the room. */
export function computeUnreadCount(seenOfferCount: number, currentOfferCount: number): number {
  return Math.max(currentOfferCount - seenOfferCount, 0);
}

/**
 * Extracts a publicId from either a raw id or a pasted Request Room link
 * (`.../marketplace/r/<publicId>`), tolerating query strings and trailing
 * slashes. Returns null when nothing usable is found.
 */
export function parsePublicIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutQuery = trimmed.split(/[?#]/u)[0];
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  const candidate = segments.length > 0 ? segments[segments.length - 1] : withoutQuery;

  // publicIds are hex tokens (a UUID with dashes stripped). Accept anything that
  // looks like a bare token so a slightly different format still resolves; the
  // backend is the final arbiter (returns null for an unknown id).
  if (/^[a-zA-Z0-9_-]{6,64}$/u.test(candidate)) return candidate;
  return null;
}

async function readRaw(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEY);
  } catch (error) {
    console.error("Failed to read saved marketplace requests", error);
    return null;
  }
}

async function writeList(list: readonly SavedBuyerRequest[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, serializeSavedRequests(list));
  } catch (error) {
    console.error("Failed to persist saved marketplace requests", error);
  }
}

export async function loadSavedRequests(): Promise<SavedBuyerRequest[]> {
  return deserializeSavedRequests(await readRaw());
}

export async function saveBuyerRequest(entry: SavedBuyerRequest): Promise<SavedBuyerRequest[]> {
  const next = upsertSavedRequest(await loadSavedRequests(), entry);
  await writeList(next);
  return next;
}

export async function removeBuyerRequest(publicId: string): Promise<SavedBuyerRequest[]> {
  const next = removeSavedRequest(await loadSavedRequests(), publicId);
  await writeList(next);
  return next;
}

export async function setRequestSeenOfferCount(
  publicId: string,
  offerCount: number
): Promise<SavedBuyerRequest[]> {
  const next = markRequestSeen(await loadSavedRequests(), publicId, offerCount);
  await writeList(next);
  return next;
}
