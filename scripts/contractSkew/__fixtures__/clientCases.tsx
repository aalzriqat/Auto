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
