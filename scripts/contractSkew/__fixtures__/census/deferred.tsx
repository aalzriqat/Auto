/* eslint-disable */
// @ts-nocheck
/**
 * Deferred and client-method forms: a bound mutation (invoked, listed in a
 * dependency array, handed onward), `useConvex().query`, and a name-only use.
 */
import { useCallback } from "react";
import { useConvex, useConvexAuth, useMutation } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";

export function InvokedAndListed(orgId: string) {
  const create = useMutation(api.vehicles.create);
  const submit = useCallback(() => create({ orgId }), [create, orgId]);
  return submit;
}

export function HandedOnward() {
  const remove = useMutation(api.vehicles.remove);
  return [remove];
}

export function ClientMethod(orgId: string) {
  const convex = useConvex();
  return convex.query(api.vehicles.list, { orgId });
}

export function NameOnly() {
  return getFunctionName(api.vehicles.list);
}

export function TypeOnly() {
  const update = useMutation(api.vehicles.update);
  type Args = Parameters<typeof update>[0];
  return (args: Args) => update(args);
}

export function AuthOnly() {
  return useConvexAuth();
}
