/// <reference types="jest" />

import * as SecureStore from "expo-secure-store";

import {
  MAX_SAVED_SEARCHES,
  type SavedSearch,
  type SavedSearchFields,
  deserializeSavedSearches,
  isSearchSaved,
  loadSavedSearches,
  markSearchSeen,
  markSearchSeenInList,
  removeSavedSearch,
  removeSavedSearchById,
  saveSearch,
  searchFieldsId,
  serializeSavedSearches,
  upsertSavedSearch,
} from "./savedSearchesStore";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;

function fields(extra: Partial<SavedSearchFields> = {}): SavedSearchFields {
  return {
    make: "",
    city: "",
    priceMin: "",
    priceMax: "",
    maxMonthlyPayment: "",
    transmission: "",
    fuelType: "",
    financeOnly: false,
    sortBy: "price_asc",
    ...extra,
  };
}

function search(id: string, extra: Partial<SavedSearch> = {}): SavedSearch {
  return { id, label: `Search ${id}`, fields: fields(), savedAt: 1, lastSeenAt: 1, ...extra };
}

describe("savedSearchesStore", () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockResolvedValue(undefined);
  });

  test("searchFieldsId is stable for equal fields and differs when a field changes", () => {
    expect(searchFieldsId(fields({ make: "Toyota" }))).toBe(searchFieldsId(fields({ make: "Toyota" })));
    expect(searchFieldsId(fields({ make: "Toyota" }))).not.toBe(searchFieldsId(fields({ make: "Kia" })));
    expect(searchFieldsId(fields({ financeOnly: true }))).not.toBe(searchFieldsId(fields({ financeOnly: false })));
  });

  test("deserialize tolerates null, bad JSON, non-arrays, and malformed rows", () => {
    expect(deserializeSavedSearches(null)).toEqual([]);
    expect(deserializeSavedSearches("not json")).toEqual([]);
    expect(deserializeSavedSearches(JSON.stringify({ id: "x" }))).toEqual([]);
    expect(
      deserializeSavedSearches(
        JSON.stringify([
          null,
          5,
          "x",
          { id: "", label: "l", fields: fields(), savedAt: 1 }, // empty id
          { id: "a", label: "l", fields: null, savedAt: 1 }, // non-object fields
          { id: "a", label: "l", fields: { ...fields(), financeOnly: "no" }, savedAt: 1 }, // financeOnly not boolean
          { id: "a", label: "l", fields: { ...fields(), make: 1 }, savedAt: 1 }, // a string field is not a string
          search("a"),
        ]),
      ),
    ).toEqual([search("a")]);
  });

  test("deserialize defaults lastSeenAt to savedAt for rows saved before it existed", () => {
    const legacy = { id: "a", label: "l", fields: fields(), savedAt: 42 }; // no lastSeenAt
    const [row] = deserializeSavedSearches(JSON.stringify([legacy]));
    expect(row).toEqual({ ...legacy, lastSeenAt: 42 });
  });

  test("markSearchSeenInList updates only the matching id's lastSeenAt", () => {
    const list = [search("a", { lastSeenAt: 1 }), search("b", { lastSeenAt: 1 })];
    const next = markSearchSeenInList(list, "a", 999);
    expect(next.find((s) => s.id === "a")!.lastSeenAt).toBe(999);
    expect(next.find((s) => s.id === "b")!.lastSeenAt).toBe(1);
    // Unknown id is a no-op.
    expect(markSearchSeenInList(list, "zzz", 999)).toEqual(list);
  });

  test("markSearchSeen persists the stamped list", async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify([search("a", { lastSeenAt: 1 })]));
    const next = await markSearchSeen("a");
    expect(next[0]!.lastSeenAt).toBeGreaterThan(1);
    expect(setItemAsync).toHaveBeenCalled();
  });

  test("serialize and deserialize cap at MAX_SAVED_SEARCHES", () => {
    const many = Array.from({ length: MAX_SAVED_SEARCHES + 5 }, (_, i) => search(`s${i}`));
    expect(deserializeSavedSearches(serializeSavedSearches(many))).toHaveLength(MAX_SAVED_SEARCHES);
  });

  test("isSearchSaved reflects membership", () => {
    const list = [search("a")];
    expect(isSearchSaved(list, "a")).toBe(true);
    expect(isSearchSaved(list, "b")).toBe(false);
  });

  test("upsert prepends new and refreshes existing, keeping the cap", () => {
    const list = [search("a"), search("b")];
    expect(upsertSavedSearch(list, search("c")).map((s) => s.id)).toEqual(["c", "a", "b"]);
    const refreshed = upsertSavedSearch(list, search("b", { label: "New" }));
    expect(refreshed.map((s) => s.id)).toEqual(["b", "a"]);
    expect(refreshed[0]!.label).toBe("New");
    const many = Array.from({ length: MAX_SAVED_SEARCHES }, (_, i) => search(`s${i}`));
    expect(upsertSavedSearch(many, search("new"))).toHaveLength(MAX_SAVED_SEARCHES);
  });

  test("remove drops the matching id", () => {
    expect(removeSavedSearch([search("a"), search("b")], "a").map((s) => s.id)).toEqual(["b"]);
  });

  test("loadSavedSearches reads and parses storage", async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify([search("a")]));
    expect(await loadSavedSearches()).toEqual([search("a")]);
  });

  test("loadSavedSearches returns [] when the read throws", async () => {
    getItemAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await loadSavedSearches()).toEqual([]);
  });

  test("saveSearch derives an id from fields, prepends, and persists", async () => {
    getItemAsync.mockResolvedValueOnce(null);
    const searchFields = fields({ make: "Toyota", fuelType: "Electric" });
    const next = await saveSearch(searchFields, "Toyota · Electric");
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe(searchFieldsId(searchFields));
    expect(next[0]!.label).toBe("Toyota · Electric");
    expect(setItemAsync).toHaveBeenCalledWith(expect.any(String), serializeSavedSearches(next));
  });

  test("saveSearch dedupes an identical search, refreshing it to the front", async () => {
    const existing = search(searchFieldsId(fields({ make: "Kia" })), { fields: fields({ make: "Kia" }) });
    getItemAsync.mockResolvedValueOnce(JSON.stringify([existing, search("other")]));
    const next = await saveSearch(fields({ make: "Kia" }), "Kia (updated)");
    expect(next.map((s) => s.id)).toEqual([existing.id, "other"]);
    expect(next[0]!.label).toBe("Kia (updated)");
  });

  test("saveSearch swallows a write failure", async () => {
    getItemAsync.mockResolvedValueOnce(null);
    setItemAsync.mockRejectedValueOnce(new Error("nope"));
    await expect(saveSearch(fields(), "any")).resolves.toHaveLength(1);
  });

  test("removeSavedSearchById removes and persists", async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify([search("a"), search("b")]));
    const next = await removeSavedSearchById("a");
    expect(next.map((s) => s.id)).toEqual(["b"]);
    expect(setItemAsync).toHaveBeenCalled();
  });
});
