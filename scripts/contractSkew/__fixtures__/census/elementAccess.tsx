/* eslint-disable */
// @ts-nocheck
/**
 * CS2-1: an SDK method reached through an ELEMENT ACCESS (`client["query"]`)
 * is the same call as `client.query`. Callee handling accepted only an
 * Identifier or a PropertyAccessExpression.
 */
import { BaseConvexClient } from "convex/browser";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";

export function BracketLiteral(orgId: string) {
  const client = useConvex();
  return client["query"](api.vehicles.list, { orgId });
}

export function DotControl(orgId: string) {
  const client = useConvex();
  return client.query(api.vehicles.list, { orgId });
}

export function BracketUnknownRef(ref: unknown, orgId: string) {
  const client = useConvex();
  return client["query"](ref, { orgId });
}

export function BracketDynamic(method: "query" | "mutation", ref: unknown) {
  const client = useConvex();
  return client[method](ref, {});
}

export function BracketValue() {
  const client = useConvex();
  const q = client["query"];
  return q;
}

export function ConstructedReference() {
  const ref = makeFunctionReference("vehicles:list");
  return ref;
}

// L-3: BaseConvexClient takes the function NAME as a string, so the pinned
// reference-type inventory cannot list it; the table does, as UNSUPPORTED.
export function BaseClientStringName(base: BaseConvexClient) {
  return base.mutation("vehicles:update", {});
}
