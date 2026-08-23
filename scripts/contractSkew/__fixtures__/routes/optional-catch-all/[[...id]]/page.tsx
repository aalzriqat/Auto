import { useParams } from "next/navigation";

declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;

export function OptionalCatchAllRouteCase() {
  const params = useParams();
  useQuery(
    api.routes.optionalCatchAll,
    params.id ? { requestId: params.id } : "skip",
  );
}

export function OptionalCatchAllAbsentRouteCase() {
  const params = useParams();
  useQuery(api.routes.optionalCatchAllAbsent, { requestId: params.id });
}

export function OptionalCatchAllSpreadRouteCase() {
  const params = useParams();
  useQuery(
    api.routes.optionalCatchAllSpread,
    params.id ? { ...{ requestId: params.id } } : "skip",
  );
}
