// SPDX-License-Identifier: Apache-2.0
// Self-written windowing for the message stream (no react-window: it would be a new
// dependency for one list). Turn groups far outside the viewport render as a spacer with
// their last measured height, so a 500-turn session keeps a bounded DOM. Unmeasured turns
// always render (we cannot size a spacer for them), which keeps scroll-to-anchor working.
import { useCallback, useEffect, useRef, useState } from "react";

export const WINDOW_MARGIN_PX = 1600;
/** Below this many turns the whole stream renders (windowing is only worth it for long sessions). */
export const WINDOW_MIN_TURNS = 40;

export interface Windowed {
  /** Whether the turn with this key should render fully. */
  visible(key: number): boolean;
  /** Spacer height for a turn that is not rendered. */
  height(key: number): number;
  /** Attach to each rendered turn element to keep its height measured. */
  measure(key: number): (el: HTMLElement | null) => void;
  enabled: boolean;
}

export function useWindowed(scrollRef: React.RefObject<HTMLElement | null>, keys: number[]): Windowed {
  const enabled = keys.length >= WINDOW_MIN_TURNS;
  const heights = useRef(new Map<number, number>());
  const tops = useRef(new Map<number, number>());
  const [, bump] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const els = useRef(new Map<number, HTMLElement>());
  /** Vertical gap between consecutive turns (the stream's flex gap), measured from adjacent rendered turns. */
  const gap = useRef(0);
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    let changed = false;
    for (const [k, node] of els.current) {
      const r = node.getBoundingClientRect();
      const h = Math.round(r.height);
      const top = Math.round(r.top - base);
      if (heights.current.get(k) !== h) { heights.current.set(k, h); changed = true; }
      if (tops.current.get(k) !== top) { tops.current.set(k, top); changed = true; }
    }
    // Gap = distance between one rendered turn's bottom and the next rendered turn's top (median over pairs).
    const gaps: number[] = [];
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1];
      if (!els.current.has(a) || !els.current.has(b)) continue;
      const ta = tops.current.get(a), ha = heights.current.get(a), tb = tops.current.get(b);
      if (ta === undefined || ha === undefined || tb === undefined) continue;
      gaps.push(tb - (ta + ha));
    }
    if (gaps.length) { gaps.sort((x, y) => x - y); const g = Math.max(0, gaps[Math.floor(gaps.length / 2)]); if (g !== gap.current) { gap.current = g; changed = true; } }
    if (changed) bump((n) => n + 1);
  }, [scrollRef, keys]);
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; bump((n) => n + 1); }); };
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.current = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => recompute()) : null;
    for (const node of els.current.values()) ro.current?.observe(node);
    recompute();
    return () => { el.removeEventListener("scroll", onScroll); ro.current?.disconnect(); ro.current = null; if (raf) cancelAnimationFrame(raf); };
  }, [enabled, scrollRef, recompute]);
  const measure = useCallback((key: number) => (node: HTMLElement | null) => {
    const prev = els.current.get(key);
    if (prev && prev !== node) ro.current?.unobserve(prev);
    if (node) { els.current.set(key, node); ro.current?.observe(node); } else els.current.delete(key);
  }, []);
  // A spacer's `top` is not re-measured while it is a spacer, so it goes stale when an earlier turn grows.
  // Derive it from the running sum of heights in key order instead; an unmeasured turn before it means "render".
  const prefixTop = (key: number): number | undefined => {
    const idx = keys.indexOf(key);
    if (idx < 0) return tops.current.get(key);
    let top = tops.current.get(keys[0]) ?? 0;
    for (let i = 0; i < idx; i++) { const h = heights.current.get(keys[i]); if (h === undefined) return undefined; top += h + gap.current; }
    return top;
  };
  const visible = (key: number) => {
    if (!enabled) return true;
    const el = scrollRef.current;
    const top = prefixTop(key);
    const h = heights.current.get(key);
    if (!el || top === undefined || h === undefined) return true;
    const lo = el.scrollTop - WINDOW_MARGIN_PX;
    const hi = el.scrollTop + el.clientHeight + WINDOW_MARGIN_PX;
    return top + h >= lo && top <= hi;
  };
  const height = (key: number) => heights.current.get(key) ?? 0;
  return { visible, height, measure, enabled };
}
