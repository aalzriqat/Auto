import { useEffect, useState } from "react";

/** Forces a re-render every `intervalMs` — for components that need to recompute Date.now()-relative state (typing/presence staleness, countdowns). */
export function useTicker(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
