/**
 * SCRUM-636 N1 (ruling c22077): the client never turns "no answer" into FREE.
 * Loading, failed and missing chunks leave their cars UNCERTAIN; chunks never
 * exceed what the server answers whole.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { PICKER_AVAILABILITY_MAX_IDS } from "@/convex/vehicleAvailability";
import {
  PICKER_CHUNK_SIZE,
  availabilityOf,
  chunkVehicleIds,
  resolvePickerAvailability,
  usePickerAvailability,
} from "./usePickerAvailability";

const queriesMock = vi.hoisted(() => ({ impl: (_q: Record<string, { args: { vehicleIds: string[] } }>) => ({}) as Record<string, unknown> }));
const seen: Record<string, { args: { vehicleIds: string[] } }>[] = [];
vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, { args: { vehicleIds: string[] } }>) => {
    seen.push(queries);
    return queriesMock.impl(queries);
  },
}));

afterEach(() => {
  seen.length = 0;
  queriesMock.impl = () => ({});
});

const ids = (n: number, prefix = "v") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("chunkVehicleIds", () => {
  test("the client chunk equals the server's per-call cap", () => {
    expect(PICKER_CHUNK_SIZE).toBe(PICKER_AVAILABILITY_MAX_IDS);
  });

  test("dedupes, drops empties and never exceeds the cap", () => {
    const chunks = chunkVehicleIds([...ids(120), ...ids(10), ""]);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(new Set(chunks.flat()).size).toBe(120);
  });
});

describe("resolvePickerAvailability", () => {
  const chunks = [["a", "b"], ["c"]];

  test("loading chunks leave every car UNCERTAIN", () => {
    const map = resolvePickerAvailability(chunks, [undefined, undefined]);
    expect([...map.values()]).toEqual(["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"]);
  });

  test("a failed chunk stays UNCERTAIN while an answered one applies", () => {
    const map = resolvePickerAvailability(chunks, [
      [
        { vehicleId: "a", availability: "FREE" },
        { vehicleId: "b", availability: "HELD" },
      ],
      new Error("no such function"),
    ]);
    expect(Object.fromEntries(map)).toEqual({ a: "FREE", b: "HELD", c: "UNCERTAIN" });
  });

  test("an answer row the chunk did not ask about is ignored", () => {
    const map = resolvePickerAvailability(chunks, [[], [{ vehicleId: "a", availability: "FREE" }]]);
    expect(map.get("a")).toBe("UNCERTAIN");
  });

  test("an id the answer omits, or an unknown verdict, stays UNCERTAIN", () => {
    const map = resolvePickerAvailability(chunks, [[{ vehicleId: "a", availability: "MAYBE" }], []]);
    expect(Object.fromEntries(map)).toEqual({ a: "UNCERTAIN", b: "UNCERTAIN", c: "UNCERTAIN" });
  });

  test("availabilityOf: a car outside the map is UNCERTAIN", () => {
    expect(availabilityOf(undefined, "x")).toBe("UNCERTAIN");
    expect(availabilityOf(new Map(), "x")).toBe("UNCERTAIN");
  });
});

describe("usePickerAvailability", () => {
  test("no org: nothing is queried and every car is UNCERTAIN", () => {
    const { result } = renderHook(() => usePickerAvailability(null, ["a", "b"]));
    expect(seen.at(-1)).toEqual({});
    expect(Object.fromEntries(result.current)).toEqual({ a: "UNCERTAIN", b: "UNCERTAIN" });
  });

  test("sends cap-sized chunks and maps each answer back", () => {
    queriesMock.impl = (queries) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, q]) => [
          key,
          key === "chunk1" ? new Error("backend without pickerAvailability") : q.args.vehicleIds.map((vehicleId) => ({ vehicleId, availability: "FREE" })),
        ])
      );
    const all = ids(70);
    const { result } = renderHook(() => usePickerAvailability("org1" as never, all));
    const sent = Object.values(seen.at(-1)!).map((q) => q.args.vehicleIds.length);
    expect(sent).toEqual([50, 20]);
    expect(result.current.get("v0")).toBe("FREE");
    expect(result.current.get("v69")).toBe("UNCERTAIN");
  });
});
