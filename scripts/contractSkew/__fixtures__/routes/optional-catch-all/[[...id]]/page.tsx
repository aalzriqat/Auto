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
