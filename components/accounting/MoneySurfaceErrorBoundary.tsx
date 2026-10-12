"use client";

import { Component, type ReactNode } from "react";

/**
 * Convex's `useQuery` rethrows a failed query during render. A money surface
 * mounted inside a larger screen (the deal cockpit, the Collections tab) must
 * degrade to its own localized fallback instead of taking that screen down.
 * The raw error is logged, never shown. Key the boundary by whatever identifies
 * the surface's data (org, sale) so moving to other data clears a failure.
 */
export class MoneySurfaceErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
