/// <reference types="jest" />

import * as SecureStore from "expo-secure-store";

import {
  MAX_SAVED_VEHICLES,
  type SavedVehicle,
  deserializeSavedVehicles,
  isVehicleSaved,
  loadSavedVehicles,
  removeSavedVehicle,
  removeSavedVehicleById,
  serializeSavedVehicles,
  toggleSavedVehicle,
  toggleSavedVehicleList,
  upsertSavedVehicle,
} from "./savedVehiclesStore";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;

function vehicle(id: string, extra: Partial<SavedVehicle> = {}): SavedVehicle {
  return { id, orgId: `org-${id}`, title: `Car ${id}`, savedAt: 1, ...extra };
}

describe("savedVehiclesStore", () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockResolvedValue(undefined);
  });

  test("deserialize tolerates null, bad JSON, non-arrays, and malformed rows", () => {
    expect(deserializeSavedVehicles(null)).toEqual([]);
    expect(deserializeSavedVehicles("not json")).toEqual([]);
    expect(deserializeSavedVehicles(JSON.stringify({ id: "x" }))).toEqual([]);
    // Includes a null and a primitive to exercise the non-object guard.
    expect(
      deserializeSavedVehicles(JSON.stringify([null, 5, "x", { id: "" }, { nope: true }, vehicle("a")])),
    ).toEqual([vehicle("a")]);
  });

  test("serialize and deserialize cap at MAX_SAVED_VEHICLES", () => {
    const many = Array.from({ length: MAX_SAVED_VEHICLES + 5 }, (_, i) => vehicle(`v${i}`));
    expect(deserializeSavedVehicles(serializeSavedVehicles(many))).toHaveLength(MAX_SAVED_VEHICLES);
  });

  test("isVehicleSaved reflects membership", () => {
    const list = [vehicle("a")];
    expect(isVehicleSaved(list, "a")).toBe(true);
    expect(isVehicleSaved(list, "b")).toBe(false);
  });

  test("upsert prepends new and refreshes existing, keeping the cap", () => {
    const list = [vehicle("a"), vehicle("b")];
    expect(upsertSavedVehicle(list, vehicle("c")).map((v) => v.id)).toEqual(["c", "a", "b"]);
    // Re-saving "b" moves it to the front with the newer snapshot.
    const refreshed = upsertSavedVehicle(list, vehicle("b", { title: "New" }));
    expect(refreshed.map((v) => v.id)).toEqual(["b", "a"]);
    expect(refreshed[0]!.title).toBe("New");
    const many = Array.from({ length: MAX_SAVED_VEHICLES }, (_, i) => vehicle(`v${i}`));
    expect(upsertSavedVehicle(many, vehicle("new"))).toHaveLength(MAX_SAVED_VEHICLES);
  });

  test("remove drops the matching id", () => {
    expect(removeSavedVehicle([vehicle("a"), vehicle("b")], "a").map((v) => v.id)).toEqual(["b"]);
  });

  test("toggle list adds when absent and removes when present", () => {
    expect(toggleSavedVehicleList([], vehicle("a")).map((v) => v.id)).toEqual(["a"]);
    expect(toggleSavedVehicleList([vehicle("a")], vehicle("a"))).toEqual([]);
  });

  test("loadSavedVehicles reads and parses storage", async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify([vehicle("a")]));
    expect(await loadSavedVehicles()).toEqual([vehicle("a")]);
  });

  test("loadSavedVehicles returns [] when the read throws", async () => {
    getItemAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await loadSavedVehicles()).toEqual([]);
  });

  test("toggleSavedVehicle persists the toggled list", async () => {
    getItemAsync.mockResolvedValueOnce(null);
    const next = await toggleSavedVehicle(vehicle("a"));
    expect(next.map((v) => v.id)).toEqual(["a"]);
    expect(setItemAsync).toHaveBeenCalledWith(expect.any(String), serializeSavedVehicles(next));
  });

  test("toggleSavedVehicle swallows a write failure", async () => {
    getItemAsync.mockResolvedValueOnce(null);
    setItemAsync.mockRejectedValueOnce(new Error("nope"));
    await expect(toggleSavedVehicle(vehicle("a"))).resolves.toHaveLength(1);
  });

  test("removeSavedVehicleById removes and persists", async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify([vehicle("a"), vehicle("b")]));
    const next = await removeSavedVehicleById("a");
    expect(next.map((v) => v.id)).toEqual(["b"]);
    expect(setItemAsync).toHaveBeenCalled();
  });
});
