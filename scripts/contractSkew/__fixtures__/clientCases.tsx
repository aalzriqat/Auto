/**
 * Source fixtures for clientPaths.mjs.
 *
 * Every case here pins a defect that a whole-repo run found and that a green
 * unit suite did NOT catch — `clientPaths.mjs` had no direct tests, which is how
 * a syntax error in it once survived 20 passing tests.
 *
 * Deliberately self-contained: the hooks and `api` are declared locally so the
 * extractor can be exercised without type-checking the whole application. It
 * matches on hook identifier text and the syntactic `api.*` path, so local
 * declarations reproduce real call sites faithfully.
 */
// Imported purely so the TypeScript program pulls a backend-shaped module in.
// The extractor must NOT scan it: it is not one of the declared client files.
import { SERVER_MARKER } from "./serverLike";

export const IMPORTED_MARKER = SERVER_MARKER;

declare function useMutation(fn: unknown): (args: unknown) => Promise<unknown>;
declare function useQuery(fn: unknown, args?: unknown): unknown;
declare function usePaginatedQuery(
  fn: unknown,
  args: unknown,
  opts: unknown
): { results: unknown[] };
declare function useState<T>(initial: T): [T, (next: T) => void];
declare const api: Record<string, Record<string, unknown>>;

type ImportRow = { rowId: number; make: string };
type WizardData = { vehicleId: string; sourceLikeVehicle?: { make: string } };

/** CASE 1 — `as any` must strip to the transmitted expression. */
export function CaseAsAny() {
  const importBulk = useMutation(api.vehicles.importBulk);
  const rows: ImportRow[] = [];
  // The cast changes TypeScript's view, not the object sent to Convex, so
  // `vehicles[*].rowId` must still resolve. The `any` is the subject of this
  // fixture, not an oversight — it reproduces the real call site at
  // components/vehicles/VehicleImportDialog.tsx:861.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void importBulk({ orgId: "o", vehicles: rows as any });
}

/**
 * CASE 2a — a `useState` setter that shares a name with a Convex mutation.
 * Keyed by identifier TEXT this was attributed to api.orgCustomFields.setValues
 * and produced eight fabricated BREAKING findings.
 */
export function CaseNameCollisionReactState() {
  const [, setValues] = useState<Record<string, string>>({});
  // In a handler rather than in render: the collision being pinned is the NAME,
  // and calling a setter during render is a lint error in its own right.
  const onChange = () => setValues({ a: "b" });
  void onChange;
}

/** CASE 2b — the real mutation, same name, different scope. */
export function CaseNameCollisionMutation() {
  const setValues = useMutation(api.orgCustomFields.setValues);
  void setValues({ orgId: "o", entityId: "e" });
}

/** CASE 3 — a query's payload is read at the hook call, not a later one. */
export function CaseQueryPayload() {
  useQuery(api.vehicles.list, { orgId: "o", includeSold: true });
}

/** CASE 3b — `"skip"` means the query does not run, so it transmits nothing. */
export function CaseSkippedQuery() {
  useQuery(api.vehicles.list, "skip");
}

/**
 * CASE 3c — the idiom that actually occurs. Every one of the 283 skippable
 * queries in this repo is written as a ternary, and NONE as the bare literal
 * above. The payload type is therefore `{...} | "skip"`, and the sentinel has
 * to be removed from the union — the flat map dropped the string branch by
 * accident, and keeping it without removing it deliberately produced 269
 * fabricated BREAKING findings in one run.
 */
export function CaseConditionallySkippedQuery(ready: boolean) {
  useQuery(api.vehicles.list, ready ? { orgId: "o", includeSold: false } : "skip");
}

/**
 * CASE 3d — `undefined` on the running branch. This query DOES run, with no
 * arguments at all. Dropping it as "never runs" cost three real call sites.
 */
export function CaseSkippableNoArgQuery(ready: boolean) {
  useQuery(api.organizations.listMine, ready ? undefined : "skip");
}

/**
 * CASE 3e — a MAPPED TYPE has no declaration for its members.
 * `Partial<Record<K, V>>` synthesises every property, so `valueDeclaration` is
 * undefined for all of them and the declaration-based type lookup fails. The
 * flat model recorded those as "unresolved", which its comparator treated as
 * compatible: an unreadable value passing as verified.
 */
type Overrides = Partial<Record<"email" | "phone", string>>;
export function CaseMappedTypePayload(overrides: Overrides) {
  const merge = useMutation(api.customers.mergeCustomers);
  void merge({ orgId: "o", fieldOverrides: overrides });
}

/**
 * CASE 3f — an INDEX SIGNATURE means the key set is not enumerable.
 * `Record<string, string>` may already carry a field under a name we cannot
 * see, so a required field missing from OUR reading of it is absence of
 * evidence, not evidence of absence, and must never be demanded.
 */
export function CaseIndexSignaturePayload(bag: Record<string, string>) {
  const save = useMutation(api.wizardDrafts.saveDraft);
  void save({ orgId: "o", wizardData: bag });
}

/**
 * CASE 3g — a NULL BRANCH IS A VALUE, not an absence.
 *
 * `undefined` in a client union means the property is not transmitted at all;
 * `null` means the property IS transmitted, carrying null. Discarding both as
 * "not a value" made `"A" | null` read as the exact set {"A"}, so a backend
 * declaring `v.literal("A")` — which Convex refuses null for — compared clean.
 * That is a false negative in the one dimension this comparator exists for.
 */
type NullableEnum = "SELF_REPORTED" | null;
export function CaseNullableEnumPayload(status: NullableEnum, note: string | null) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", inspectionStatus: status, notes: note });
}

/**
 * CASE 3h — the OTHER half of the null/undefined distinction.
 *
 * `status?: "AVAILABLE" | "SOLD"` types as `"AVAILABLE" | "SOLD" | undefined`.
 * `undefined` means the property is simply not sent, so the transmitted domain
 * is still the exact set {"AVAILABLE", "SOLD"} and stays provable. Treating it
 * as a value instead would widen every optional enum in the codebase into
 * "not verifiable" — noise that hides the findings that matter.
 */
type OptionalStatus = { status?: "AVAILABLE" | "SOLD" };
export function CaseOptionalLiteralUnion(opts: OptionalStatus) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", status: opts.status });
}

/**
 * CASE 3i — an EMPTY array literal, from the round-1 cross-family review.
 *
 * `vehicles: []` is valid Convex: zero elements are validated, so the element
 * validator cannot refuse anything. The extractor used to hand the comparator
 * `array(unresolved)`, which was then compared against `v.array(v.object(...))`
 * as though it were a real element — fabricating a BREAKING finding at
 * `vehicles[*]` for correct code. A false production-skew alarm is the worst
 * thing this control can emit.
 */
export function CaseEmptyArrayLiteral() {
  const importBulk = useMutation(api.vehicles.importBulk);
  void importBulk({ orgId: "o", vehicles: [] });
}

/**
 * CASE 3j — a BRANDED PRIMITIVE is a primitive.
 *
 * Convex ids are `string & { __tableName: T }` — an INTERSECTION, which carries
 * neither StringLike nor Object. It fell through to "unresolved", which was
 * invisible while unresolved silently passed. The moment unresolved began
 * reporting an honest unknown, every id argument in the app became one: 810 new
 * TYPE_UNKNOWNs in one whole-repo run.
 */
type BrandedId = string & { __tableName: "vehicles" };
export function CaseBrandedIdPayload(id: BrandedId) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", vehicleId: id });
}

/**
 * CASE 5a — the DIRECT invocation form, `convex.mutation(api.x.y, {...})`.
 * Server components and plain modules use this instead of a hook, and it is the
 * only form where the function reference and the payload are both arguments.
 */
declare const convex: { mutation: (fn: unknown, args: unknown) => Promise<unknown> };
export function CaseDirectInvocation() {
  void convex.mutation(api.vehicles.update, { orgId: "o", status: "SOLD" });
}

/** CASE 5b — a SPREAD contributes fields that are not written at the call site. */
export function CaseSpreadPayload(rest: { notes: string; mileage: number }) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", ...rest });
}

/**
 * CASE 5c — a COMPUTED KEY makes the key set unknowable. The object may already
 * carry a field under a name we cannot read, so nothing may be demanded of it.
 */
export function CaseComputedKey(key: string) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", [key]: "whatever" });
}

/** CASE 5d — a POPULATED array literal, the ordinary counterpart to CASE 3i. */
export function CasePopulatedArrayLiteral() {
  const importBulk = useMutation(api.vehicles.importBulk);
  void importBulk({ orgId: "o", vehicles: [{ vin: "V1", make: "M" }] });
}

/**
 * CASE 5e — binders that cannot be followed. Each is a COVERAGE GAP the run
 * must report with a cause, never silently skip: a destructured binding, a hook
 * result returned straight out of a wrapper, and a reference that is not a
 * literal `api.*` path.
 */
export function CaseDestructuredBinder() {
  // A binding pattern rather than a simple name: the hook result cannot be
  // followed to a call site, so its payload is never examined.
  const { length } = useMutation(api.vehicles.update);
  void length;
}
export function CaseWrapperReturn() {
  return useMutation(api.vehicles.update);
}
export function CaseDynamicIdentity(pick: () => unknown) {
  // The function reference is not a literal `api.*` path, so which backend
  // function this even targets is unknowable.
  void useMutation(pick());
}

/** CASE 5f — an `any` payload value: knowable as unknowable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the `any` IS the case under test
export function CaseAnyValue(blob: any) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", notes: blob });
}

/**
 * CASE 6a — a TUPLE payload field. Tuples reach the element type by a different
 * checker call than arrays do, and the two had never been distinguished.
 */
export function CaseTuplePayload(pair: [string, string]) {
  const update = useMutation(api.vehicles.update);
  void update({ orgId: "o", tags: pair });
}

/**
 * CASE 6b — nesting past MAX_DEPTH. The walk has to stop somewhere, and when it
 * does it must record an unknown rather than quietly return a shallow answer
 * that reads as complete.
 */
export function CaseVeryDeepPayload() {
  const update = useMutation(api.vehicles.update);
  void update({
    orgId: "o",
    a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: "deep" } } } } } } } } } } } },
  });
}

/**
 * CASE 6c — a field whose name begins with a double underscore.
 *
 * The extractor used to skip every such property while walking a TYPE, which
 * dropped it from `fields`, left it out of `unknowns`, and still reported
 * `keysComplete: true`. It asserted the key set was PROVEN COMPLETE having
 * silently discarded a field — a false PASS on a real undeclared-field skew.
 */
type LegacyPayload = { orgId: string; __legacyFlag: boolean };
export function CaseDunderField(p: LegacyPayload) {
  const update = useMutation(api.vehicles.update);
  void update(p);
}

/**
 * CASE 4 — an optional parent makes its required child unproven.
 * `sourceLikeVehicle` is optional and unset here, so `sourceLikeVehicle.make`
 * is never transmitted even though it is required WITHIN that object.
 */
export function CaseOptionalParent() {
  const saveDraft = useMutation(api.wizardDrafts.saveDraft);
  const wizardData: WizardData = { vehicleId: "v" };
  void saveDraft({ orgId: "o", wizardData });
}

/** CASE 5 — paginated queries are tagged so the comparator can exempt them. */
export function CasePaginated() {
  usePaginatedQuery(api.transactions.list, { orgId: "o" }, { initialNumItems: 10 });
}
