import * as SecureStore from "expo-secure-store";

/**
 * Local, account-free list of vehicles the buyer has saved on this device.
 * Anonymous buyers have no Clerk account (marketplace-first), so favorites live
 * in SecureStore — the Saved tab reads this, and a later phase syncs it to a
 * buyer account. Pure helpers are separated from the SecureStore I/O so they can
 * be unit-tested without a native module (mirrors buyerRequestsStore).
 */

const STORAGE_KEY = "autoflow.marketplace.savedVehicles.v1";
/** SecureStore values are size-limited on Android; keep the newest saves only. */
export const MAX_SAVED_VEHICLES = 50;

export interface SavedVehicle {
  id: string;
  orgId: string;
  title: string;
  price?: number;
  monthlyPayment?: number;
  imageUrl?: string;
  dealershipName?: string;
  savedAt: number;
}

function isSavedVehicle(value: unknown): value is SavedVehicle {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.orgId === "string" &&
    typeof record.title === "string" &&
    typeof record.savedAt === "number"
  );
}

/** Parses stored JSON into a clean, newest-first list, dropping malformed rows. */
export function deserializeSavedVehicles(raw: string | null): SavedVehicle[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedVehicle).slice(0, MAX_SAVED_VEHICLES);
  } catch {
    return [];
  }
}

export function serializeSavedVehicles(list: readonly SavedVehicle[]): string {
  return JSON.stringify(list.slice(0, MAX_SAVED_VEHICLES));
}

export function isVehicleSaved(list: readonly SavedVehicle[], vehicleId: string): boolean {
  return list.some((item) => item.id === vehicleId);
}

/** Inserts (or refreshes) a saved vehicle, newest first. */
export function upsertSavedVehicle(
  list: readonly SavedVehicle[],
  entry: SavedVehicle,
): SavedVehicle[] {
  const rest = list.filter((item) => item.id !== entry.id);
  return [entry, ...rest].slice(0, MAX_SAVED_VEHICLES);
}

export function removeSavedVehicle(list: readonly SavedVehicle[], vehicleId: string): SavedVehicle[] {
  return list.filter((item) => item.id !== vehicleId);
}

/** Pure toggle: removes when already present, otherwise inserts newest-first. */
export function toggleSavedVehicleList(
  list: readonly SavedVehicle[],
  entry: SavedVehicle,
): SavedVehicle[] {
  return isVehicleSaved(list, entry.id)
    ? removeSavedVehicle(list, entry.id)
    : upsertSavedVehicle(list, entry);
}

async function readRaw(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEY);
  } catch (error) {
    console.error("Failed to read saved vehicles", error);
    return null;
  }
}

async function writeList(list: readonly SavedVehicle[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, serializeSavedVehicles(list));
  } catch (error) {
    console.error("Failed to persist saved vehicles", error);
  }
}

export async function loadSavedVehicles(): Promise<SavedVehicle[]> {
  return deserializeSavedVehicles(await readRaw());
}

export async function toggleSavedVehicle(entry: SavedVehicle): Promise<SavedVehicle[]> {
  const next = toggleSavedVehicleList(await loadSavedVehicles(), entry);
  await writeList(next);
  return next;
}

export async function removeSavedVehicleById(vehicleId: string): Promise<SavedVehicle[]> {
  const next = removeSavedVehicle(await loadSavedVehicles(), vehicleId);
  await writeList(next);
  return next;
}
