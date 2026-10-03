/* eslint-disable */
// @ts-nocheck
/** `useQueries` request-map shapes: several entries, an empty branch, a dynamic map. */
import { useQueries } from "convex/react";
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
