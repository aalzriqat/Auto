/* eslint-disable */
// @ts-nocheck
/** `useQueries` request-map shapes: several entries, an empty branch, a dynamic map. */
import { useQueries } from "convex/react";
import { useMemo } from "react";
import { api } from "@/convex/_generated/api";

export function SeveralEntries(orgId: string, vehicleId: string) {
  return useQueries({
    first: { query: api.vehicles.get, args: { orgId, vehicleId } },
    second: { query: api.organizations.listMine, args: {} },
  });
}

export function EmptyBranchOnly() {
  return useQueries({});
}

export function EmptyBranchPlusEntry(orgId: string, on: boolean) {
  return useQueries(on ? {} : { only: { query: api.vehicles.list, args: { orgId } } });
}

export function DynamicMap(requests: Record<string, never>) {
  return useQueries(requests);
}

export function DynamicEntry(orgId: string, name: string) {
  return useQueries({ x: { query: api.vehicles[name], args: { orgId } } });
}

function freshChunks(ids: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  return chunks;
}

export function NativeMappedRequests(orgId: string, ids: string[]) {
  const chunks = useMemo(() => freshChunks(ids), [ids]);
  const requests = useMemo(() => !orgId ? {} : Object.fromEntries(
    chunks.map((chunk, index) => [`chunk${index}`, {
      query: api.vehicleAvailability.pickerAvailability,
      args: { orgId, vehicleIds: chunk },
    }]),
  ), [orgId, chunks]);
  return useQueries(requests);
}
