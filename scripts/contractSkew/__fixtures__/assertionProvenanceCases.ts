/**
 * Assertion-provenance fixtures for SCRUM-178.
 *
 * These are deliberately real TypeScript programs. The regression lives at
 * the TypeChecker/extractor boundary, so hand-built ClientNodes cannot prove
 * that an assertion hidden in syntax, an alias, or a callee body is rejected.
 */
declare function useMutation(fn: unknown): (args: unknown) => Promise<unknown>;
declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;

type Id<Table extends string> = string & { readonly __tableName: Table };
type OrgId = Id<"organizations">;
type UserId = Id<"users">;

const identity = <T>(value: T): T => value;

function assertedByCallee(raw: string): OrgId {
  return raw as OrgId;
}

export function BaselineRaw(raw: string) {
  const mutate = useMutation(api.assertions.baselineRaw);
  void mutate({ orgId: raw });
}

export function DirectAs(raw: string) {
  const mutate = useMutation(api.assertions.directAs);
  void mutate({ orgId: raw as OrgId });
}

export function AngleAssertion(raw: string) {
  const mutate = useMutation(api.assertions.angleAssertion);
  void mutate({ orgId: <OrgId>raw });
}

export function AssertedSpread(raw: { orgId: string }) {
  const mutate = useMutation(api.assertions.assertedSpread);
  void mutate({ ...(raw as unknown as { orgId: OrgId }) });
}

export function BaselineSpread(raw: { orgId: string }) {
  const mutate = useMutation(api.assertions.baselineSpread);
  void mutate({ ...raw });
}

export function ConditionalAssertion(pick: boolean, raw: string, real: OrgId) {
  const mutate = useMutation(api.assertions.conditionalAssertion);
  void mutate({ orgId: pick ? (raw as OrgId) : real });
}

export function ConditionalBaseline(pick: boolean, raw: string, real: OrgId) {
  const mutate = useMutation(api.assertions.conditionalBaseline);
  void mutate({ orgId: pick ? raw : real });
}

export function AliasAssertion(raw: string) {
  const mutate = useMutation(api.assertions.aliasAssertion);
  const asserted = raw as OrgId;
  void mutate({ orgId: asserted });
}

export function AliasBaseline(raw: string) {
  const mutate = useMutation(api.assertions.aliasBaseline);
  const value = raw;
  void mutate({ orgId: value });
}

export function CallArgumentAssertion(raw: string) {
  const mutate = useMutation(api.assertions.callArgumentAssertion);
  void mutate({ orgId: identity(raw as OrgId) });
}

export function CallArgumentBaseline(raw: string) {
  const mutate = useMutation(api.assertions.callArgumentBaseline);
  void mutate({ orgId: identity(raw) });
}

export function CalleeBodyAssertion(raw: string) {
  const mutate = useMutation(api.assertions.calleeBodyAssertion);
  void mutate({ orgId: assertedByCallee(raw) });
}

export function PropertyAccessAssertion(raw: string) {
  const mutate = useMutation(api.assertions.propertyAccessAssertion);
  const claimed = raw as unknown as { orgId: OrgId };
  void mutate({ orgId: claimed.orgId });
}

export function MutableAssertion(raw: string) {
  const mutate = useMutation(api.assertions.mutableAssertion);
  let claimed = raw as OrgId;
  claimed = raw as OrgId;
  void mutate({ orgId: claimed });
}

export function NumberAssertion(value: number) {
  const mutate = useMutation(api.assertions.numberAssertion);
  void mutate({ orgId: value as unknown as OrgId });
}

export function RedundantIdAssertion(orgId: OrgId) {
  const mutate = useMutation(api.assertions.redundantIdAssertion);
  void mutate({ orgId: orgId as OrgId });
}

export function CrossTableAssertion(userId: UserId) {
  const mutate = useMutation(api.assertions.crossTableAssertion);
  void mutate({ orgId: userId as unknown as OrgId });
}

export function ProvenSameTable(orgId: OrgId) {
  const mutate = useMutation(api.assertions.provenSameTable);
  void mutate({ orgId });
}

export function ProvenCrossTable(orgId: UserId) {
  const mutate = useMutation(api.assertions.provenCrossTable);
  void mutate({ orgId });
}

export function SpreadNonNull(draft: { orgId: OrgId | null }) {
  const mutate = useMutation(api.assertions.spreadNonNull);
  void mutate({ ...draft, orgId: draft.orgId! });
}

export function SpreadAfterNonNull(draft: { orgId?: OrgId | null }) {
  const mutate = useMutation(api.assertions.spreadAfterNonNull);
  void mutate({ orgId: draft.orgId!, ...draft });
}

export function OpaqueSpreadAfterId(raw: unknown, orgId: OrgId) {
  const mutate = useMutation(api.assertions.opaqueSpreadAfterId);
  void mutate({ orgId, ...(raw as Record<string, unknown>) });
}

export function IdAfterOpaqueSpread(raw: unknown, orgId: OrgId) {
  const mutate = useMutation(api.assertions.idAfterOpaqueSpread);
  void mutate({ ...(raw as Record<string, unknown>), orgId });
}

export function QueryNonNull(input: { orgId: OrgId } | null) {
  useQuery(api.assertions.queryNonNull, input!);
}

export function ArrayNonNull(active: OrgId | null, fallback: OrgId) {
  const mutate = useMutation(api.assertions.arrayNonNull);
  void mutate({ orgIds: [active!, fallback] });
}

export function NoOpNonNull(value: OrgId | number) {
  const mutate = useMutation(api.assertions.noOpNonNull);
  void mutate({ orgId: value! });
}

export function IdBesideString(pick: boolean, orgId: OrgId, raw: string) {
  const mutate = useMutation(api.assertions.idBesideString);
  void mutate({ orgId: pick ? orgId : raw });
}
