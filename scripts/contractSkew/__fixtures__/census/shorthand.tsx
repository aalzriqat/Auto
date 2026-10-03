/* eslint-disable */
// @ts-nocheck
/**
 * CS-3: a shorthand property `{ name }` is a USE of the variable `name`. The
 * checker answers `getSymbolAtLocation(name)` with the PROPERTY symbol, so a
 * comparison against the variable's symbol never matched and the bound
 * mutation escaped the census without a record.
 */
import { useConvex, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

export function useVehicleActions() {
  const update = useMutation(api.vehicles.update);
  return { update };
}

export function ExplicitControl() {
  const update = useMutation(api.vehicles.update);
  return { update: update };
}

export function RootInShorthand() {
  const holder = { api };
  return holder;
}

// L-6: the SDK method pulled off a client by a SHORTHAND destructure. The
// reference is a parameter, so nothing rooted in `api` backs the call up.
export function SdkMethodDestructure(ref: unknown, orgId: string) {
  const client = useConvex();
  const { mutation } = client;
  return mutation(ref, { orgId });
}
