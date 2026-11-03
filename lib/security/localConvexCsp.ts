/**
 * SCRUM-892: CI runs the app against a self-hosted Convex backend on the
 * runner's loopback instead of a cloud preview deployment. The browser then
 * talks to `http://127.0.0.1:3210` and `ws://127.0.0.1:3210`, which the
 * cloud-only CSP refuses, so every authenticated page stalls on
 * "Loading your workspace...".
 *
 * The extra sources are added only when the build's Convex URL is EXACTLY the
 * local CI backend. Any other value (production, a cloud preview, a typo)
 * adds nothing, so the production policy stays byte-identical.
 */
export const LOCAL_CONVEX_URL = "http://127.0.0.1:3210";

export interface LocalConvexCspSources {
  connect: string[];
  img: string[];
}

export function localConvexCspSources(convexUrl: string | undefined): LocalConvexCspSources {
  if (convexUrl !== LOCAL_CONVEX_URL) return { connect: [], img: [] };
  return {
    connect: [LOCAL_CONVEX_URL, "ws://127.0.0.1:3210"],
    // File storage URLs are served from the backend origin.
    img: [LOCAL_CONVEX_URL],
  };
}

/** The sources as a CSP suffix: empty, or a leading space and the list. */
export function cspSuffix(sources: string[]): string {
  return sources.length > 0 ? ` ${sources.join(" ")}` : "";
}
