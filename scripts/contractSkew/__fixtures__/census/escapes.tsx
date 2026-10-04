/* eslint-disable */
// @ts-nocheck
/**
 * References the extractor cannot follow, and a negative: an `api` that is not
 * Convex's generated object. Every reference-shaped thing here must end the
 * census with a recorded disposition.
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

declare function pickReference(): never;

/** A hook result bound to a simple name must not hide an unresolved reference. */
export function BinderEscape() {
  const rows = useQuery(pickReference(), { orgId: "o" });
  return rows;
}

/** A mutation handed onward is not invoked here, so its payload cannot be read. */
export function MutationEscapes() {
  const create = useMutation(api.vehicles.create);
  return create;
}

/** An alias that is not a literal api path. */
export function UnresolvableAlias(name: string) {
  const ref = api.vehicles[name];
  return useQuery(ref, {});
}
