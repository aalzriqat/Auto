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

/** CS-686-1: `!== null` leaves `undefined` (absence) possible, so a required id can be absent. */
export function strictNullKeepsUndefined(args: { id: Id<"vehicles"> | null | undefined }) {
  const active = args.id !== null;
  return useQuery(
    api.skipGate.strictNullKeepsUndefined,
    active ? { id: args.id as Id<"vehicles"> } : "skip",
  );
}

/** CS-686-1 control: `!= null` removes both null and undefined. */
export function looseNullClean(args: { id: Id<"vehicles"> | null | undefined }) {
  const active = args.id != null;
  return useQuery(
    api.skipGate.looseNullClean,
    active ? { id: args.id as Id<"vehicles"> } : "skip",
  );
}

/** CS-686-1 control: `!== undefined` removes undefined but keeps null. */
export function strictUndefinedKeepsNull(args: { id: Id<"vehicles"> | null | undefined }) {
  const active = args.id !== undefined;
  return useQuery(
    api.skipGate.strictUndefinedKeepsNull,
    active ? { id: args.id as Id<"vehicles"> } : "skip",
  );
}

type Box = { id: Id<"vehicles"> | null };

/** CS-686-2: the receiver is mutated through ANOTHER reference after the guard. */
export function mutatedViaOther(box: Box) {
  const active = box.id != null;
  const clear = (other: Box) => {
    other.id = null;
  };
  clear(box);
  return useQuery(
    api.skipGate.mutatedViaOther,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}

/** CS-686-2 variants: receiver aliased / spread / captured by a closure. */
export function aliasedReceiver(box: Box) {
  const active = box.id != null;
  const same = box;
  same.id = null;
  return useQuery(
    api.skipGate.aliasedReceiver,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function closureReceiver(box: Box) {
  const active = box.id != null;
  const reset = () => {
    box.id = null;
  };
  reset();
  return useQuery(
    api.skipGate.closureReceiver,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
declare function opaqueMutator(value: unknown): void;
export function escapedAsArgument(box: Box) {
  const active = box.id != null;
  opaqueMutator(box);
  return useQuery(
    api.skipGate.escapedAsArgument,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}

/** CS-686-3: a local binding named `undefined` is not the global. */
export function shadowedUndefinedParam(undefined: string, id: Id<"vehicles"> | null) {
  const active = id != undefined;
  return useQuery(
    api.skipGate.shadowedUndefinedParam,
    active ? { id: id as Id<"vehicles"> } : "skip",
  );
}
export function shadowedUndefinedLocal(id: Id<"vehicles"> | null) {
  const undefined = "x";
  const active = id !== undefined;
  return useQuery(
    api.skipGate.shadowedUndefinedLocal,
    active ? { id: id as Id<"vehicles"> } : "skip",
  );
}
/** CS-686-3 control: the global `undefined` and `void 0` still prove non-undefined. */
export function globalUndefinedClean(args: { id: Id<"vehicles"> | undefined }) {
  const active = args.id !== undefined;
  return useQuery(
    api.skipGate.globalUndefinedClean,
    active ? { id: args.id as Id<"vehicles"> } : "skip",
  );
}
export function voidZeroClean(args: { id: Id<"vehicles"> | undefined }) {
  const active = args.id !== void 0;
  return useQuery(
    api.skipGate.voidZeroClean,
    active ? { id: args.id as Id<"vehicles"> } : "skip",
  );
}

/** CS-686-2 closure round (Codex): a SECOND parameter may be the same object — `f(shared, shared)`. */
export function sameObjectTwoParams(box: Box, other: Box) {
  const active = box.id != null;
  other.id = null;
  return useQuery(
    api.skipGate.sameObjectTwoParams,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** A property write anywhere in the receiver's function denies the fact, even on a single parameter. */
declare const sharedBox: Box;
export function singleParamOuterWrite(box: Box) {
  const active = box.id != null;
  sharedBox.id = null;
  return useQuery(
    api.skipGate.singleParamOuterWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** CS-686-2-R (Codex): a write wrapped in a TypeScript assertion is still a write. */
export function nonNullWrappedWrite(box: Box) {
  const active = box.id != null;
  sharedBox.id! = null as unknown as Id<"vehicles">;
  return useQuery(
    api.skipGate.nonNullWrappedWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function asWrappedWrite(box: Box) {
  const active = box.id != null;
  (sharedBox.id as Id<"vehicles"> | null) = null;
  return useQuery(
    api.skipGate.asWrappedWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function elementNonNullWrappedWrite(box: Box) {
  const active = box.id != null;
  sharedBox["id"]! = null as unknown as Id<"vehicles">;
  return useQuery(
    api.skipGate.elementNonNullWrappedWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** Control: a wrapped READ is not a write, so the fact stands. */
export function wrappedReadClean(box: Box) {
  const active = box.id != null;
  const seen = sharedBox.id! as Id<"vehicles">;
  void seen;
  return useQuery(
    api.skipGate.wrappedReadClean,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** F1 (Opus seat): a const ALIAS of another reference lets the object escape under its source name. */
export function constAliasOfParamEscapes(a: Box) {
  const box = a;
  const active = box.id != null;
  opaqueMutator(a);
  return useQuery(
    api.skipGate.constAliasOfParamEscapes,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function constAliasOfSecondParam(a: Box, b: Box) {
  const box = a;
  const active = box.id != null;
  opaqueMutator(b);
  return useQuery(
    api.skipGate.constAliasOfSecondParam,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function constAliasOfHolderEscapes(holder: { box: Box }) {
  const box = holder.box;
  const active = box.id != null;
  opaqueMutator(holder);
  return useQuery(
    api.skipGate.constAliasOfHolderEscapes,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** F2 (Opus seat): a non-arrow function's parameter also escapes through `arguments`. */
export function argumentsEscape(box: Box) {
  const active = box.id != null;
  // eslint-disable-next-line prefer-rest-params
  opaqueMutator(arguments);
  return useQuery(
    api.skipGate.argumentsEscape,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** Control: a const receiver built fresh from a literal has no other name. */
declare const maybeId: Id<"vehicles"> | null;
export function constFreshObjectClean() {
  const box: Box = { id: maybeId };
  const active = box.id != null;
  return useQuery(
    api.skipGate.constFreshObjectClean,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** F3 (Opus seat): further write forms that must deny the fact. */
export function nullishAssignWrite(box: Box) {
  const active = box.id != null;
  sharedBox.id ??= null;
  return useQuery(
    api.skipGate.nullishAssignWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function destructuringWrite(box: Box) {
  const active = box.id != null;
  [sharedBox.id] = [null];
  return useQuery(
    api.skipGate.destructuringWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
export function nestedClosureWrite(box: Box) {
  const active = box.id != null;
  const reset = () => {
    sharedBox.id = null;
  };
  reset();
  return useQuery(
    api.skipGate.nestedClosureWrite,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
/** Control: a single parameter, no property writes, stays clean. */
export function singleParamNoWriteClean(box: Box) {
  const active = box.id != null;
  return useQuery(
    api.skipGate.singleParamNoWriteClean,
    active ? { id: box.id as Id<"vehicles"> } : "skip",
  );
}
