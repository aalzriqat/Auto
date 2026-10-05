/**
 * SCRUM-686. A boolean const alias of a `&&` guard chain that gates a
 * `cond ? { ...args } : "skip"` ternary. Mirrors components/sales/ProfitApprovalNotice.tsx
 * (useProfitApproval): the alias proves non-null on the transmitting branch, the
 * `as Id<...>` casts are NOT evidence. NEGATIVE cases keep reporting null.
 * Analysed by the extractor, never compiled by the detector's own project.
 */
declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;
type Id<T extends string> = string & { __table: T };

type Args = {
  orgId: Id<"organizations"> | null | undefined;
  vehicleId: Id<"vehicles"> | null | undefined;
  salePrice: number;
  enabled: boolean;
};

/** Real pattern: const alias of `&&` chain of `!!x.prop`, cast args. */
export function aliasGuard(args: Args) {
  const active = args.enabled && !!args.orgId && !!args.vehicleId && args.salePrice > 0;
  return useQuery(
    api.skipGate.aliasGuard,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles">, salePrice: args.salePrice }
      : "skip",
  );
}

/** Alias over plain identifiers with `!= null` / `!== null` / bare truthiness, no casts. */
export function aliasGuardIdentifiers(a: string | null, b: string | null, c: string | null) {
  const ok = a != null && b !== null && !!c;
  return useQuery(api.skipGate.aliasGuardIdentifiers, ok ? { a, b, c } : "skip");
}

/** NEGATIVE (a): alias built with `||` proves nothing on the true branch. */
export function aliasOr(args: Args) {
  const active = args.enabled || !!args.orgId || !!args.vehicleId;
  return useQuery(
    api.skipGate.aliasOr,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles">, salePrice: args.salePrice }
      : "skip",
  );
}

/** NEGATIVE (b): a `let` alias may be reassigned, so it is not evidence. */
export function aliasLet(args: Args) {
  let active = args.enabled && !!args.orgId && !!args.vehicleId;
  if (args.salePrice < 0) active = true;
  return useQuery(
    api.skipGate.aliasLet,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles">, salePrice: args.salePrice }
      : "skip",
  );
}

/** NEGATIVE (c): a cast with no guard at all. */
export function castNoGuard(args: Args) {
  const active = args.enabled && args.salePrice > 0;
  return useQuery(
    api.skipGate.castNoGuard,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles">, salePrice: args.salePrice }
      : "skip",
  );
}

/** NEGATIVE: the chain guards a DIFFERENT field than the one sent. */
export function aliasGuardsOther(args: Args) {
  const active = args.enabled && !!args.vehicleId;
  return useQuery(
    api.skipGate.aliasGuardsOther,
    active ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles"> } : "skip",
  );
}

/** Alias of null comparisons on property accesses. */
export function aliasNullCompare(args: Args) {
  const active = args.orgId != null && args.vehicleId !== null;
  return useQuery(
    api.skipGate.aliasNullCompare,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles"> }
      : "skip",
  );
}

/** NEGATIVE: the receiver is written, so the alias fact may be stale. */
export function aliasReceiverWritten(args: Args) {
  const active = args.enabled && !!args.orgId;
  args.orgId = null;
  return useQuery(
    api.skipGate.aliasReceiverWritten,
    active ? { orgId: args.orgId as Id<"organizations"> } : "skip",
  );
}
