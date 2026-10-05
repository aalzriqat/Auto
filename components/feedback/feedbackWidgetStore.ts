"use client";

import { useSyncExternalStore } from "react";

/**
 * Open state of the feedback panel. The panel has no floating trigger — a
 * floating button covered page actions (SCRUM-609 F-01, SCRUM-612) — so it is
 * opened from the top bar (desktop) or the menu drawer (mobile).
 */
type FeedbackWidgetState = { open: boolean };

let state: FeedbackWidgetState = { open: false };
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
