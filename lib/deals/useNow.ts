import { useSyncExternalStore } from "react";

/**
 * The wall clock, as an external store.
 *
 * Two constraints collide here and `useSyncExternalStore` is the one tool that
 * satisfies both:
 *
 *  - Reading `Date.now()` during render makes the server and the client
 *    disagree by however long the request took. React reports that as a
 *    hydration mismatch and the affected text flickers on load.
 *  - Setting the clock from inside an effect is a cascading render, which is
 *    what `react-hooks` flags — and it also renders once with no value at all.
 *
 * The clock is genuinely an external system, so it is modelled as one: the
 * server snapshot is `null` (nothing is known at render time on the server),
 * the client subscribes, and the value updates on a shared interval rather than
 * one timer per component.
 *
 * `current` is module-level and cached deliberately. `getSnapshot` must return
 * a referentially stable value between updates — returning a fresh `Date.now()`
 * on every call would make React see an endlessly-changing store and re-render
 * forever.
 */
const DEFAULT_INTERVAL_MS = 60_000;

let current: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  current = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    // The first tick is immediate so a freshly-mounted queue does not sit for a
    // whole minute with no waiting times on it.
    emit();
    timer = setInterval(emit, DEFAULT_INTERVAL_MS);
  } else {
    // A later subscriber joins an already-running clock; nudge it so it does
    // not render blank until the next tick.
    onChange();
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number | null {
  return current;
}

/** Always `null` on the server: no clock reading is valid across the request. */
function getServerSnapshot(): number | null {
  return null;
}

/**
 * The current time in ms, or `null` before the client clock has started.
 *
 * Callers must treat `null` as "not known yet" and withhold whatever depends on
 * it, rather than substituting a default — a duration rendered against a
 * guessed clock is worse than no duration.
 */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test-only: drops the shared clock so suites cannot leak state into each other. */
export function __resetNowForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  current = null;
  listeners.clear();
}
