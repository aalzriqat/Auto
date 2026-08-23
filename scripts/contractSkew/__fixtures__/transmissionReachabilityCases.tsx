/**
 * Real use-site reachability shapes for the TypeChecker -> extractor ->
 * comparator controls. These are deliberately self-contained so the tests
 * exercise TypeScript flow analysis without pulling application modules into
 * the fixture program.
 */
declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;

type ScopedArgs = { orgId: string; customerId: string };

export function CaseScopedArgs(
  ready: boolean,
  orgId: string | null,
  customerId: string | null,
  activeTab: "overview" | "financials",
) {
  const scopedArgs: ScopedArgs | null =
    ready && orgId && customerId ? ({ orgId, customerId } as ScopedArgs) : null;
  useQuery(
    api.reachability.scopedArgs,
    scopedArgs && activeTab === "financials" ? scopedArgs : "skip",
  );
}

export function CaseNonRunningBaseline() {
  const args = { value: "ok" } as { value: string };
  useQuery(api.reachability.nonRunningBaseline, args ? args : "skip");
}

export function CaseNonRunningNull(ready: boolean) {
  const args = ready ? ({ value: "ok" } as { value: string }) : null;
  useQuery(api.reachability.nonRunningNull, args ? args : "skip");
}

export function CaseNonRunningFalse(ready: boolean) {
  const args = ready ? ({ value: "ok" } as { value: string }) : false;
  useQuery(api.reachability.nonRunningFalse, args ? args : "skip");
}

export function CaseNonRunningZero(ready: boolean) {
  const args = ready ? ({ value: "ok" } as { value: string }) : 0;
  useQuery(api.reachability.nonRunningZero, args ? args : "skip");
}

export function CaseNonRunningEmptyString(ready: boolean) {
  const args = ready ? ({ value: "ok" } as { value: string }) : "";
  useQuery(api.reachability.nonRunningEmptyString, args ? args : "skip");
}

export function CaseTransmittedIncompatibleConditional(sendArray: boolean) {
  useQuery(
    api.reachability.transmittedConditional,
    sendArray ? { value: ["bad"] } : { value: "ok" },
  );
}

export function CaseMutableUnprovableAlias(source: unknown, rewrite: boolean) {
  let args = source as { value: string } | null;
  if (rewrite) args = null;
  useQuery(api.reachability.mutableAlias, args ? args : "skip");
}

export function CaseMutatedAssertedObject(source: unknown) {
  const args = { value: "ok" } as { value: string };
  args.value = source as string;
  useQuery(api.reachability.mutatedAssertedObject, args ? args : "skip");
}
