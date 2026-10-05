import { useParams } from "next/navigation";

declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;

/*
 * The guarded cases copy the param into a local first, as every real page does:
 * a guard on `params.id` itself proves nothing, because useParams() hands every
 * caller ONE shared, unfrozen object (SCRUM-686, Codex CS-686-5).
 */
export function OptionalCatchAllRouteCase() {
  const params = useParams();
  const requestId = params.id;
  useQuery(
    api.routes.optionalCatchAll,
    requestId ? { requestId } : "skip",
  );
}

export function OptionalCatchAllAbsentRouteCase() {
  const params = useParams();
  useQuery(api.routes.optionalCatchAllAbsent, { requestId: params.id });
}

export function OptionalCatchAllSpreadRouteCase() {
  const params = useParams();
  const requestId = params.id;
  useQuery(
    api.routes.optionalCatchAllSpread,
    requestId ? { ...{ requestId } } : "skip",
  );
}
