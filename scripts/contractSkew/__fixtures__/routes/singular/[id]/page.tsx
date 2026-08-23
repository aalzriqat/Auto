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
