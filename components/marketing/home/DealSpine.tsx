"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { pick, SPINE_CHIPS, SPINE_NODES, type SpineChip, type SpineNode } from "./content";

/**
 * The hero's signature element: a deal travelling the rail, on a loop.
 *
 * One deal crosses the rail at constant speed, lights every stage it passes,
 * the completed pipeline holds, then the trail fades and the next deal starts.
 * The deal itself fades in and out WHILE moving, so it is never seen standing
 * still at either end.
 *
 * Stage thresholds are derived from each node's RENDERED centre rather than
 * from its authored percentage, so the same engine drives the desktop diagonal
 * and the mobile flat rail, in both LTR and RTL, with no separate tables. It
 * re-measures once per lap, where layout is unambiguously settled.
 *
 * The engine is deliberately imperative: it writes a transform, a dash offset
 * and an opacity every animation frame, which is not work React should be
 * reconciling.
 */

const TRAVEL = 7600;
const HOLD = 1700;
const FADE = 900;
const GAP = 700;
const CYCLE = TRAVEL + HOLD + FADE + GAP;
/* the travel overshoots both ends by OVER and fades across FADE_SPAN */
const OVER = 0.045;
const FADE_SPAN = 0.07;
const SAMPLES = 160;

const RAIL_D = "M40 168 L250 168 L400 118 L600 118 L750 168 L960 168";

type Sample = { p: number; x: number; y: number };
type Stage = { el: HTMLElement; at: number; on: boolean };
type Chip = { el: HTMLElement; at: number };

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function NodeIcon({ icon }: { icon: SpineNode["icon"] }) {
  switch (icon) {
    case "lead":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M19.6 8.45a8.4 8.4 0 1 1-4.05-4.06" />
          <path d="M8 12.2l2.7 2.7L16 9" />
        </svg>
      );
    case "drive":
      return (
        <svg viewBox="0 0 24 24">
          <g transform="translate(0 -0.8)">
            <path d="M3 14h18M6 14l1.6-5.2A3 3 0 0 1 10.5 7h3a3 3 0 0 1 2.9 1.8L18 14" />
            <circle cx="7.5" cy="17" r="1.6" />
            <circle cx="16.5" cy="17" r="1.6" />
          </g>
        </svg>
      );
    case "check":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M4 12.5l5.2 5L20 6.5" />
        </svg>
      );
    case "finance":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
          <path d="M2.5 10h19M6 14.5h4" />
        </svg>
      );
    case "delivered":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M9 3.5h6l1.2 4H7.8z" />
          <rect x="5" y="7.5" width="14" height="13" rx="2.5" />
          <path d="M9.5 13.5h5M9.5 17h3" />
        </svg>
      );
  }
}

function chipStyle(c: SpineChip): CSSProperties {
  const style: Record<string, string> = { "--d": `${c.delayMs}ms`, top: `${c.top}%` };
  if (c.edge === "start") style.insetInlineStart = `${c.inset}%`;
  else style.insetInlineEnd = `${c.inset}%`;
  return style as CSSProperties;
}

export function DealSpine({ locale, isRtl, reduced }: { locale: string; isRtl: boolean; reduced: boolean }) {
  const spineRef = useRef<HTMLDivElement>(null);
  const litRef = useRef<SVGPathElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  /* chips flash once for the life of the page, never again on a later lap */
  const fired = useRef(new WeakSet<HTMLElement>());

  useEffect(() => {
    const spine = spineRef.current;
    const lit = litRef.current;
    const pulse = pulseRef.current;
    if (!spine || !lit || !pulse) return;

    const S = {
      raf: 0,
      t0: 0,
      lastT: 0,
      running: false,
      mobile: false,
      dir: isRtl ? -1 : 1,
      len: 0,
      samples: [] as Sample[],
      nodes: [] as Stage[],
      chips: [] as Chip[],
    };

    const progressAtX = (cx: number, width: number) => {
      if (S.mobile) {
        const f = cx / width;
        return clamp01(S.dir > 0 ? f : 1 - f);
      }
      let best = 0;
      let bestD = Infinity;
      for (const s of S.samples) {
        const d = Math.abs(s.x - cx);
        if (d < bestD) {
          bestD = d;
          best = s.p;
        }
      }
      return best;
    };

    const measure = () => {
      const box = spine.getBoundingClientRect();
      if (!box.width) return false;
      S.mobile = getComputedStyle(lit.ownerSVGElement as SVGSVGElement).display === "none";
      S.dir = isRtl ? -1 : 1;
      S.len = S.mobile ? 0 : lit.getTotalLength();
      S.samples = [];
      if (!S.mobile) {
        for (let i = 0; i <= SAMPLES; i++) {
          const p = i / SAMPLES;
          const l = (S.dir > 0 ? p : 1 - p) * S.len;
          const pt = lit.getPointAtLength(l);
          S.samples.push({ p, x: (pt.x / 1000) * box.width, y: (pt.y / 250) * box.height });
        }
      }
      S.nodes = [];
      spine.querySelectorAll<HTMLElement>(".spine-node").forEach((n) => {
        if (!n.offsetParent) return; /* the decorative node hidden on mobile */
        const r = n.getBoundingClientRect();
        const cx = r.left + r.width / 2 - box.left;
        S.nodes.push({ el: n, at: progressAtX(cx, box.width), on: n.classList.contains("lit") });
      });
      S.nodes.sort((a, b) => a.at - b.at);
      /* the three floating chips narrate stages 1, 3 and 5 */
      const chips = spine.querySelectorAll<HTMLElement>(".spine-chip");
      S.chips = [];
      [0, 2, 4].forEach((idx, i) => {
        const n = S.nodes[idx];
        if (chips[i] && n) S.chips.push({ el: chips[i], at: n.at });
      });
      return true;
    };

    /* p is allowed OUTSIDE [0,1]: the deal enters and leaves the frame still
       moving. Clamping the sample index would park it on the end point. */
    const pointAt = (p: number, box: DOMRect) => {
      if (S.mobile) return { x: (S.dir > 0 ? p : 1 - p) * box.width, y: box.height / 2 };
      const n = S.samples.length;
      if (n < 2) return { x: 0, y: 0 };
      if (p < 0) {
        const a = S.samples[0];
        const b = S.samples[1];
        const k = p * (n - 1);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
      if (p > 1) {
        const a = S.samples[n - 1];
        const b = S.samples[n - 2];
        const k = (p - 1) * (n - 1);
        return { x: a.x + (a.x - b.x) * k, y: a.y + (a.y - b.y) * k };
      }
      /* lerp between adjacent samples — rounding made the deal step, not glide */
      const f = p * (n - 1);
      const i = Math.min(n - 2, Math.floor(f));
      const k = f - i;
      const a = S.samples[i];
      const b = S.samples[i + 1];
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    };

    const paint = (p: number, litP: number, alpha: number) => {
      const box = spine.getBoundingClientRect();
      const l = clamp01(litP);
      spine.style.setProperty("--lit", String(l));
      if (!S.mobile && S.len) {
        /* a NEGATIVE offset reveals from the far end — what RTL needs, since
           the SVG itself never mirrors */
        lit.style.strokeDasharray = String(S.len);
        lit.style.strokeDashoffset = String(S.len * (1 - l) * S.dir);
      }
      const pt = pointAt(p, box);
      pulse.style.left = `${pt.x}px`;
      pulse.style.top = `${pt.y}px`;
      pulse.style.opacity = String(alpha);
    };

    const setStages = (p: number) => {
      for (const n of S.nodes) {
        const on = p >= n.at;
        if (on === n.on) continue;
        n.on = on;
        n.el.classList.toggle("lit", on);
        if (on) {
          n.el.classList.remove("ping");
          void n.el.offsetWidth;
          n.el.classList.add("ping");
        }
      }
      for (const c of S.chips) {
        if (p < c.at || fired.current.has(c.el)) continue;
        fired.current.add(c.el);
        c.el.classList.add("ping");
        setTimeout(() => c.el.classList.remove("ping"), 900);
      }
    };

    const clearStages = () => {
      for (const n of S.nodes) {
        n.on = false;
        n.el.classList.remove("lit", "ping");
      }
    };

    const pulseAlpha = (p: number) =>
      clamp01(Math.min((p + OVER) / FADE_SPAN, (1 + OVER - p) / FADE_SPAN, 1));

    const frame = (now: number) => {
      if (!S.t0) S.t0 = now;
      const t = (now - S.t0) % CYCLE;
      if (t < S.lastT) measure(); /* once per lap, where layout is settled */
      S.lastT = t;

      if (t < TRAVEL) {
        const p = -OVER + (t / TRAVEL) * (1 + 2 * OVER);
        spine.classList.add("running");
        paint(p, p, pulseAlpha(p));
        setStages(clamp01(p));
      } else if (t < TRAVEL + HOLD) {
        paint(1 + OVER, 1, 0);
        setStages(1);
      } else if (t < TRAVEL + HOLD + FADE) {
        spine.classList.remove("running");
      } else {
        clearStages();
        paint(-OVER, 0, 0);
      }
      S.raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (S.running || !measure()) return;
      S.running = true;
      S.t0 = 0;
      S.lastT = 0;
      S.raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!S.running) return;
      S.running = false;
      cancelAnimationFrame(S.raf);
      spine.classList.remove("running");
    };

    if (reduced) {
      /* no loop, but the rail should still READ as a completed pipeline */
      if (measure()) {
        spine.classList.add("lit-static");
        spine.style.setProperty("--lit", "1");
        if (!S.mobile && S.len) {
          lit.style.strokeDasharray = String(S.len);
          lit.style.strokeDashoffset = "0";
        }
        S.nodes.forEach((n) => n.el.classList.add("lit"));
      }
      return () => {
        spine.classList.remove("lit-static");
        spine.querySelectorAll(".spine-node").forEach((n) => n.classList.remove("lit"));
      };
    }

    /* burn no frames while the hero is off-screen */
    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => entries.forEach((en) => (en.isIntersecting ? start() : stop())),
            { threshold: 0.08 },
          )
        : null;
    if (io) io.observe(spine);
    else start();

    let rz: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        if (S.running) measure();
      }, 150);
    };
    window.addEventListener("resize", onResize, { passive: true });

    /* after a direction flip the document is briefly wider than it settles at,
       so measure again once fonts and layout have caught up */
    const late = setTimeout(() => S.running && measure(), 400);
    document.fonts?.ready.then(() => S.running && measure()).catch(() => undefined);

    return () => {
      stop();
      io?.disconnect();
      clearTimeout(rz);
      clearTimeout(late);
      window.removeEventListener("resize", onResize);
      clearStages();
      paint(-OVER, 0, 0);
    };
  }, [isRtl, reduced]);

  return (
    <div className="spine" ref={spineRef}>
      <svg className="spine-rail" viewBox="0 0 1000 250" preserveAspectRatio="none" aria-hidden="true">
        <path className="rail-base" d={RAIL_D} />
        <path className="rail-lit" d={RAIL_D} ref={litRef} />
      </svg>

      {SPINE_NODES.map((n) => (
        <div
          key={n.icon}
          className="spine-node"
          style={{ "--d": `${n.delayMs}ms`, insetInlineStart: `${n.start}%`, top: `${n.top}%` } as CSSProperties}
        >
          <div className={n.icon === "check" ? "node-tile is-primary" : "node-tile"}>
            <NodeIcon icon={n.icon} />
          </div>
          {n.label ? <div className="node-label">{pick(locale, n.label)}</div> : null}
        </div>
      ))}

      {SPINE_CHIPS.map((c) => (
        <div
          key={c.title.en}
          className="spine-chip"
          style={chipStyle(c)}
        >
          <span className="chip-dot" style={{ background: c.color }} />
          <span>
            <span>{pick(locale, c.title)}</span>
            <br />
            <span className="chip-sub">{pick(locale, c.sub)}</span>
          </span>
        </div>
      ))}

      {/* LAST child on purpose: the mobile rail addresses nodes by :nth-of-type,
          so a <div> inserted ahead of them would shift every stage. */}
      <div className="spine-pulse" ref={pulseRef} aria-hidden="true" />
    </div>
  );
}
