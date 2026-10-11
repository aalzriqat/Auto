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

export function MappedEntries(orgId: string, chunks: string[][]) {
  const queries = useMemo(() => {
    if (!orgId) return {};
    return Object.fromEntries(chunks.map((chunk, index) => [
      `chunk${index}`,
      { query: api.vehicleAvailability.pickerAvailability, args: { orgId, vehicleIds: chunk } },
    ]));
  }, [orgId, chunks]);
  return useQueries(queries);
}

export function MappedDynamicEntry(orgId: string, names: string[]) {
  return useQueries(Object.fromEntries(names.map((name, index) => [
    `query${index}`,
    { query: api.organizations[name], args: { orgId } },
  ])));
}

export function ShadowedFromEntries(orgId: string, chunks: string[][]) {
  const Object = { fromEntries: (pairs: unknown) => pairs };
  return useQueries(Object.fromEntries(chunks.map((chunk, index) => [
    `shadow${index}`,
    { query: api.vehicles.list, args: { orgId, vehicleIds: chunk } },
  ])));
}
