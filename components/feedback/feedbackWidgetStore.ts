"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * SCRUM-609 F-01 — the floating feedback trigger sits over the bottom-end
 * corner, which is where full-screen flows (the sales wizard) put their
 * primary actions. Such a flow suppresses the floating trigger while it is
 * mounted and offers its own entry point that opens the same panel.
 */
type FeedbackWidgetState = { suppressors: number; open: boolean };

let state: FeedbackWidgetState = { suppressors: 0, open: false };
const listeners = new Set<() => void>();

function setState(next: FeedbackWidgetState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

export function useFeedbackWidgetState(): FeedbackWidgetState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function openFeedbackPanel() {
  setState({ ...state, open: true });
}

export function closeFeedbackPanel() {
  setState({ ...state, open: false });
}

/** Hides the floating trigger while `active` and the calling component is mounted. */
export function useSuppressFeedbackTrigger(active = true) {
  useEffect(() => {
    if (!active) return;
    setState({ ...state, suppressors: state.suppressors + 1 });
    return () => {
      setState({ ...state, suppressors: Math.max(0, state.suppressors - 1) });
    };
  }, [active]);
}
