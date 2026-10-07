"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PickerAvailability } from "@/convex/vehicleAvailability";

export type { PickerAvailability };

/**
 * Mirrors `PICKER_AVAILABILITY_MAX_IDS` in convex/vehicleAvailability.ts — the
 * server answers ids beyond it UNCERTAIN, so a chunk never exceeds it. Kept as
 * a copy so the client bundle does not import server code; a test pins the two
 * equal.
 */
export const PICKER_CHUNK_SIZE = 50;

/** Distinct ids in first-seen order, split into chunks the server answers whole. */
export function chunkVehicleIds(ids: readonly string[], size: number = PICKER_CHUNK_SIZE): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

type ChunkAnswer = readonly { vehicleId: string; availability: PickerAvailability }[];

/**
 * ⚠️ FAIL TOWARD UNCERTAIN, NEVER TOWARD FREE (SCRUM-636 N1, ruling c22077).
 * Every requested id starts UNCERTAIN. Only a chunk that came back as an
 * answer may move an id it asked about; a chunk still loading, failed (an
 * Error value — e.g. a backend without the query) or missing leaves its ids
 * UNCERTAIN, and an answer row for an id the chunk did not ask about is
 * ignored.
 */
export function resolvePickerAvailability(
  chunks: readonly (readonly string[])[],
  answers: readonly unknown[]
): Map<string, PickerAvailability> {
  const verdicts = new Map<string, PickerAvailability>();
  chunks.forEach((chunk, index) => {
    for (const id of chunk) verdicts.set(id, "UNCERTAIN");
    const answer = answers[index];
    if (!Array.isArray(answer)) return;
    const asked = new Set(chunk);
    for (const row of answer as ChunkAnswer) {
      if (!asked.has(row?.vehicleId)) continue;
      if (row.availability === "FREE" || row.availability === "HELD") verdicts.set(row.vehicleId, row.availability);
    }
  });
  return verdicts;
}

/** A car the map does not cover is UNCERTAIN — never FREE. */
export function availabilityOf(
  verdicts: ReadonlyMap<string, PickerAvailability> | undefined,
  vehicleId: string
): PickerAvailability {
  return verdicts?.get(vehicleId) ?? "UNCERTAIN";
}

/**
 * The picker's advisory hold badge for each car (SCRUM-636, ruling c22077).
 * Reads through `useQueries` so a failed chunk comes back as a value instead
 * of throwing the wizard into the error boundary (the frontend can meet a
 * backend deployed before `pickerAvailability` existed).
 */
export function usePickerAvailability(
  orgId: Id<"organizations"> | null | undefined,
  vehicleIds: readonly string[]
): Map<string, PickerAvailability> {
  const idsKey = vehicleIds.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not array identity
  const chunks = useMemo(() => chunkVehicleIds(vehicleIds), [idsKey]);
  const queries = useMemo((): RequestForQueries => {
    if (!orgId) return {};
    return Object.fromEntries(
      chunks.map((chunk, index) => [
        `chunk${index}`,
        {
          query: api.vehicleAvailability.pickerAvailability,
          args: { orgId, vehicleIds: chunk as Id<"vehicles">[] },
        },
      ])
    );
  }, [orgId, chunks]);
  const results = useQueries(queries);
  return useMemo(
    () => resolvePickerAvailability(chunks, chunks.map((_, index) => results[`chunk${index}`])),
    [chunks, results]
  );
}
