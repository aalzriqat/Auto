import { useParams } from "next/navigation";

declare function useQuery(fn: unknown, args?: unknown): unknown;
declare const api: Record<string, Record<string, unknown>>;

export function CatchAllRouteCase() {
  const params = useParams();
  useQuery(api.routes.catchAll, { requestId: params.id });
}
