/* eslint-disable react-hooks/immutability -- adversarial detector fixtures intentionally mutate hook results */
import { useParams } from "next/navigation";

declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;
type RequestId = string & { __tableName: "requests" };

export function SingularRouteCase() {
  const params = useParams();
  const requestId = params.id as string;
  useQuery(api.routes.singular, { requestId: requestId as RequestId });
}

export function ShadowedRouteCase(
  useParams: () => { id: string | string[] },
) {
  const params = useParams();
  useQuery(api.routes.shadowed, { requestId: params.id });
}

export function MutableRouteCase(rewrite: boolean) {
  let params = useParams();
  if (rewrite) params = { id: ["a", "b"] };
  useQuery(api.routes.mutable, { requestId: params.id });
}

export function StableRouteAliasCase() {
  const params = useParams();
  const renamed = params;
  useQuery(api.routes.stableAlias, { requestId: renamed.id });
}

export function DestructuredRouteAliasCase() {
  const params = useParams();
  const { id: requestId } = params;
  useQuery(api.routes.destructuredAlias, { requestId });
}

export function DirectRouteMutationCase() {
  const params = useParams();
  (params as { id: string | string[] }).id = ["a", "b"];
  useQuery(api.routes.directMutation, { requestId: params.id });
}

export function BracketRouteMutationCase() {
  const params = useParams();
  (params as { id: string | string[] })["id"] = ["a", "b"];
  useQuery(api.routes.bracketMutation, { requestId: params.id });
}

export function AliasMutationAfterCreationCase() {
  const params = useParams();
  const alias = params;
  (alias as { id: string | string[] }).id = ["a", "b"];
  useQuery(api.routes.aliasMutationAfterCreation, { requestId: params.id });
}

export function AliasMutationBeforeCreationCase() {
  const params = useParams();
  (params as { id: string | string[] }).id = ["a", "b"];
  const alias = params;
  useQuery(api.routes.aliasMutationBeforeCreation, { requestId: alias.id });
}

export function IndirectRouteMutationCase() {
  const params = useParams();
  const alias = params;
  const secondAlias = alias;
  (secondAlias as { id: string | string[] }).id = ["a", "b"];
  useQuery(api.routes.indirectMutation, { requestId: params.id });
}

export function DestructuringRouteMutationCase(
  replacement: { id: string | string[] },
) {
  const params = useParams();
  ({ id: params.id } = replacement);
  useQuery(api.routes.destructuringMutation, { requestId: params.id });
}
