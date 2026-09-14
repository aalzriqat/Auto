import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/* ---------------------------------------------------------------------- */
/* Reduced motion                                                          */
/* ---------------------------------------------------------------------- */

export type MotionState = Readonly<{
  /** true when the system asks for reduced motion AND the visitor has not overridden it */
  reduced: boolean;
  /** true once the visitor clicked "Play anyway" */
  forced: boolean;
  forceMotion: () => void;
}>;

const RM_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(RM_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const readReducedMotion = () => window.matchMedia(RM_QUERY).matches;
const serverReducedMotion = () => false;

/**
 * Reads `prefers-reduced-motion` and keeps the `<html>` class the stylesheet
 * keys on (`force-motion`, the visitor's override) in sync. It is removed on
 * unmount so nothing leaks onto the next route.
 */
export function useMotionPreference(): MotionState {
  const system = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
  const [forced, setForced] = useState(false);
  const reduced = system && !forced;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("force-motion", forced);
    return () => {
      root.classList.remove("force-motion");
    };
  }, [forced]);

  const forceMotion = useCallback(() => setForced(true), []);

  return { reduced, forced, forceMotion };
}

/* ---------------------------------------------------------------------- */
/* Reveal engine                                                           */
/* ---------------------------------------------------------------------- */

export const REVEAL_SELECTOR =
  ".reveal, .reveal-scale, .blur-in, .mini, .spine, .hero-car, .floor-stage, .post-demo";

/**
 * Adds `.in` to every reveal target as it enters the viewport, and removes it
 * again only when the element leaves BELOW the viewport (the reader scrolled
 * back up past it). Re-arming on exit-upwards would make sections flicker as
 * they leave the top of the screen.
 *
 * Re-runs whenever `key` changes so remounted targets (a headline keyed by
 * locale) get observed again.
 */
export function useReveal(root: RefObject<HTMLElement | null>, reduced: boolean, key: string) {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const targets = Array.from(host.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));

    if (reduced || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
          } else if (e.boundingClientRect.top > 0) {
            e.target.classList.remove("in");
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [root, reduced, key]);
}

/* ---------------------------------------------------------------------- */
/* Scroll: nav shadow + deal-flow rail progress                            */
/* ---------------------------------------------------------------------- */

/**
 * One rAF-throttled scroll listener that (a) reports whether the page has
 * scrolled past the top and (b) drives the deal-flow rail fill and per-step
 * "on" state directly on the DOM — writing per-frame values through React
 * state would re-render the whole page on every scroll tick.
 */
export function useScrollRail(track: RefObject<HTMLElement | null>, reduced: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  const scrolledRef = useRef(false);

  useEffect(() => {
    let ticking = false;

    const frame = () => {
      ticking = false;
      const next = window.scrollY > 24;
      if (next !== scrolledRef.current) {
        scrolledRef.current = next;
        setScrolled(next);
      }

      const el = track.current;
      if (!el) return;
      const rail = el.querySelector<HTMLElement>(".flow-rail");
      const steps = el.querySelectorAll<HTMLElement>(".flow-step");
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      /* progress 0..1 as the track crosses the middle band of the viewport */
      const raw = (vh * 0.72 - r.top) / (r.height + vh * 0.12);
      const p = Math.max(0, Math.min(1, raw));
      rail?.style.setProperty("--p", String(reduced ? 1 : p));
      steps.forEach((s) => {
        s.classList.toggle("on", reduced || s.getBoundingClientRect().top < vh * 0.78);
      });
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(frame);
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    frame();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [track, reduced]);

  return scrolled;
}

/* ---------------------------------------------------------------------- */
/* Interval that pauses under reduced motion                               */
/* ---------------------------------------------------------------------- */

export function useTicker(ms: number, active: boolean, onTick: () => void) {
  const cb = useRef(onTick);
  useEffect(() => {
    cb.current = onTick;
  });
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => cb.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

/* ---------------------------------------------------------------------- */
/* Smooth anchor scrolling, scoped to this page's lifetime                 */
/* ---------------------------------------------------------------------- */

/**
 * `scroll-behavior` has to live on <html> to affect anchor jumps, and a
 * stylesheet rule there would leak onto every other route once this page's
 * CSS is loaded. Set it on mount, restore on unmount.
 */
export function useSmoothScroll(reduced: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = reduced ? "auto" : "smooth";
    return () => {
      root.style.scrollBehavior = prev;
    };
  }, [reduced]);
}
