"use client";

import { useSyncExternalStore } from "react";

/**
 * Open state of the expense assistant panel (SCRUM-1039). Same shape as the
 * feedback panel's store: there is no floating trigger (SCRUM-612), so the panel
 * is opened from the top bar on desktop or the menu drawer on phones, and the
 * panel itself is mounted once in the dashboard layout.
 *
 * `returnFocusTo` is where focus goes when the panel closes: the element that
 * opened it, or, from the phone drawer (which is gone by then), the menu button.
 * `session` changes on every open and close, so an answer to a request made
 * before the panel closed can be recognised and ignored.
 */
type ExpenseAssistantState = { open: boolean; returnFocusTo: HTMLElement | null; session: number };

let state: ExpenseAssistantState = { open: false, returnFocusTo: null, session: 0 };
const listeners = new Set<() => void>();

function setState(next: ExpenseAssistantState) {
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

export function useExpenseAssistantState(): ExpenseAssistantState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The current session, read when a request comes back (not during render). */
export function currentExpenseAssistantSession(): number {
  return state.session;
}

export function openExpenseAssistant(returnFocusTo: HTMLElement | null = null) {
  setState({ open: true, returnFocusTo, session: state.session + 1 });
}

export function closeExpenseAssistant() {
  if (!state.open) return;
  setState({ ...state, open: false, session: state.session + 1 });
}
