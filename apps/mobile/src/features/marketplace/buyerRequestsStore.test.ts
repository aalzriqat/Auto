import * as SecureStore from "expo-secure-store";

import {
  computeUnreadCount,
  deserializeSavedRequests,
  loadSavedRequests,
  markRequestSeen,
  MAX_SAVED_REQUESTS,
  parsePublicIdFromInput,
  removeBuyerRequest,
  removeSavedRequest,
  saveBuyerRequest,
  serializeSavedRequests,
  setRequestSeenOfferCount,
  upsertSavedRequest,
  type SavedBuyerRequest,
} from "./buyerRequestsStore";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;

function entry(overrides: Partial<SavedBuyerRequest> = {}): SavedBuyerRequest {
  return {
    publicId: overrides.publicId ?? "abc123",
    phone: overrides.phone ?? "+962791234567",
    make: overrides.make,
    model: overrides.model,
    createdAt: overrides.createdAt ?? 1000,
    seenOfferCount: overrides.seenOfferCount ?? 0,
  };
}

describe("upsertSavedRequest", () => {
  it("adds a new request to the front", () => {
    const list = upsertSavedRequest([entry({ publicId: "a" })], entry({ publicId: "b" }));
    expect(list.map((r) => r.publicId)).toEqual(["b", "a"]);
  });

  it("de-duplicates by publicId and preserves the existing seen count", () => {
    const list = upsertSavedRequest(
      [entry({ publicId: "a", seenOfferCount: 3, make: "Toyota" })],
      entry({ publicId: "a", seenOfferCount: 0, make: "Honda" })
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ publicId: "a", seenOfferCount: 3, make: "Honda" });
  });

  it("caps the list at MAX_SAVED_REQUESTS, dropping the oldest", () => {
    let list: SavedBuyerRequest[] = [];
    for (let i = 0; i < MAX_SAVED_REQUESTS + 5; i += 1) {
      list = upsertSavedRequest(list, entry({ publicId: `id-${i}` }));
    }
    expect(list).toHaveLength(MAX_SAVED_REQUESTS);
    expect(list[0].publicId).toBe(`id-${MAX_SAVED_REQUESTS + 4}`);
  });
});

describe("removeSavedRequest + markRequestSeen", () => {
  it("removes by publicId", () => {
    const list = removeSavedRequest([entry({ publicId: "a" }), entry({ publicId: "b" })], "a");
    expect(list.map((r) => r.publicId)).toEqual(["b"]);
  });

  it("updates only the matching request's seen count", () => {
    const list = markRequestSeen([entry({ publicId: "a", seenOfferCount: 1 }), entry({ publicId: "b", seenOfferCount: 1 })], "b", 4);
    expect(list.find((r) => r.publicId === "a")?.seenOfferCount).toBe(1);
    expect(list.find((r) => r.publicId === "b")?.seenOfferCount).toBe(4);
  });
});

describe("computeUnreadCount", () => {
  it("counts offers arrived since last seen and never goes negative", () => {
    expect(computeUnreadCount(1, 4)).toBe(3);
    expect(computeUnreadCount(4, 4)).toBe(0);
    expect(computeUnreadCount(6, 4)).toBe(0);
  });
});

describe("serialize/deserialize", () => {
  it("round-trips a list", () => {
    const list = [entry({ publicId: "a" }), entry({ publicId: "b" })];
    expect(deserializeSavedRequests(serializeSavedRequests(list)).map((r) => r.publicId)).toEqual(["a", "b"]);
  });

  it("returns an empty list for null or malformed JSON", () => {
    expect(deserializeSavedRequests(null)).toEqual([]);
    expect(deserializeSavedRequests("not json")).toEqual([]);
    expect(deserializeSavedRequests('{"not":"array"}')).toEqual([]);
  });

  it("drops malformed rows including null, primitives, and empty ids", () => {
    const raw = JSON.stringify([
      { publicId: "ok", phone: "x", createdAt: 1, seenOfferCount: 0 },
      null,
      "just-a-string",
      { publicId: "", phone: "x", createdAt: 1, seenOfferCount: 0 },
    ]);
    expect(deserializeSavedRequests(raw).map((r) => r.publicId)).toEqual(["ok"]);
  });
});

describe("parsePublicIdFromInput", () => {
  it("returns a bare id unchanged", () => {
    expect(parsePublicIdFromInput("abc123def456")).toBe("abc123def456");
  });

  it("extracts the id from a full room link", () => {
    expect(parsePublicIdFromInput("https://autoflowdealer.com/marketplace/r/abc123def456")).toBe("abc123def456");
  });

  it("tolerates query strings and trailing slashes", () => {
    expect(parsePublicIdFromInput("https://x.com/marketplace/r/tok123/?utm=1")).toBe("tok123");
  });

  it("returns null for empty or nonsense input", () => {
    expect(parsePublicIdFromInput("   ")).toBeNull();
    expect(parsePublicIdFromInput("!!")).toBeNull();
  });

  it("returns null for slash-only input with no usable segment", () => {
    expect(parsePublicIdFromInput("/")).toBeNull();
  });
});

describe("SecureStore-backed persistence", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
  });

  it("loads and parses stored requests", async () => {
    getItemAsync.mockResolvedValue(serializeSavedRequests([entry({ publicId: "a" })]));
    expect((await loadSavedRequests()).map((r) => r.publicId)).toEqual(["a"]);
  });

  it("returns an empty list and logs when reading fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    getItemAsync.mockRejectedValue(new Error("read boom"));
    expect(await loadSavedRequests()).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it("upserts and persists a new request", async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockResolvedValue(undefined);
    const next = await saveBuyerRequest(entry({ publicId: "a" }));
    expect(next.map((r) => r.publicId)).toEqual(["a"]);
    expect(setItemAsync).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs a write failure", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error("write boom"));
    await saveBuyerRequest(entry({ publicId: "a" }));
    expect(spy).toHaveBeenCalled();
  });

  it("removes a request and persists the result", async () => {
    getItemAsync.mockResolvedValue(serializeSavedRequests([entry({ publicId: "a" }), entry({ publicId: "b" })]));
    setItemAsync.mockResolvedValue(undefined);
    const next = await removeBuyerRequest("a");
    expect(next.map((r) => r.publicId)).toEqual(["b"]);
  });

  it("updates a request's seen offer count and persists", async () => {
    getItemAsync.mockResolvedValue(serializeSavedRequests([entry({ publicId: "a", seenOfferCount: 0 })]));
    setItemAsync.mockResolvedValue(undefined);
    const next = await setRequestSeenOfferCount("a", 5);
    expect(next.find((r) => r.publicId === "a")?.seenOfferCount).toBe(5);
  });
});
