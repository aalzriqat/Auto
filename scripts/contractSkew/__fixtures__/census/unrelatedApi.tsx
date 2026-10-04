/* eslint-disable */
// @ts-nocheck
/**
 * NEGATIVE: a local object called `api` that is NOT Convex's generated one.
 * Nothing here reaches a Convex entry point, so the census must not make it a
 * candidate. Name-matching on `api` would.
 */
const api = { vehicles: { get: (id: string) => id, list: () => [] as string[] } };

export function RestStyleClient() {
  const one = api.vehicles.get("x");
  const alias = api.vehicles.list;
  return [one, alias()];
}
