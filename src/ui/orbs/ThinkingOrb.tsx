// SPDX-License-Identifier: Apache-2.0
// Monochrome animated orb (own implementation of the thinking-orbs idea; pure 2D canvas, no deps).
// One 64 px orb per screen at most + 20 px inline ones; unmount when collapsed/background.
import { useEffect, useRef } from "react";
import type { OrbState } from "../orb-state";

interface Props { state: OrbState; size?: number; className?: string; label?: string }

interface Motion { particles: number; orbit: number; jitter: number; pulse: number; spin: number; ring: number }

const MOTION: Record<OrbState, Motion> = {
  working: { particles: 7, orbit: 0.7, jitter: 0.12, pulse: 0.6, spin: 1.0, ring: 0.9 },
  searching: { particles: 5, orbit: 0.9, jitter: 0.25, pulse: 0.3, spin: 1.6, ring: 0.6 },
  composing: { particles: 6, orbit: 0.55, jitter: 0.05, pulse: 0.9, spin: 0.6, ring: 1.0 },
  weaving: { particles: 8, orbit: 0.85, jitter: 0.08, pulse: 0.4, spin: 1.2, ring: 0.8 },
  solving: { particles: 6, orbit: 0.6, jitter: 0.3, pulse: 0.5, spin: -1.2, ring: 0.7 },
  shaping: { particles: 6, orbit: 0.75, jitter: 0.02, pulse: 0.3, spin: 0.8, ring: 1.0 },
  listening: { particles: 4, orbit: 0.5, jitter: 0.0, pulse: 1.2, spin: 0.3, ring: 1.0 },
  connecting: { particles: 3, orbit: 0.95, jitter: 0.4, pulse: 0.2, spin: 2.2, ring: 0.4 },
  breathing: { particles: 3, orbit: 0.4, jitter: 0.0, pulse: 1.0, spin: 0.2, ring: 0.9 },
  paused: { particles: 0, orbit: 0, jitter: 0, pulse: 0, spin: 0, ring: 1.0 },
  none: { particles: 0, orbit: 0, jitter: 0, pulse: 0, spin: 0, ring: 0 },
};

function cssVar(el: Element, name: string, fallback: string): string {
  try { return getComputedStyle(el).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
}

export function ThinkingOrb({ state, size = 20, className, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const m = MOTION[state];
    // Fallbacks resolve through the same tokens; a raw literal here would bypass the theme (design-lint).
    const stroke = cssVar(canvas, "--gray-900", cssVar(canvas, "--fg", "currentColor"));
    const strong = cssVar(canvas, "--fg", "currentColor");
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = reduced ? 0 : (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const R = size * 0.42;
      // outer ring
      ctx.lineWidth = Math.max(1, size / 20);
      ctx.strokeStyle = stroke;
      ctx.globalAlpha = 0.35 + 0.35 * m.ring;
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.stroke();
      // core
      const pulse = 1 + m.pulse * 0.12 * Math.sin(t * 2.2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = strong;
      ctx.beginPath();
      ctx.arc(c, c, R * 0.28 * pulse, 0, Math.PI * 2);
      ctx.fill();
      // particles
      for (let i = 0; i < m.particles; i++) {
        const a = (i / m.particles) * Math.PI * 2 + t * m.spin;
        const jr = R * m.orbit * (1 + m.jitter * Math.sin(t * 3 + i * 1.7));
        const x = c + Math.cos(a) * jr;
        const y = c + Math.sin(a * 1.0 + Math.sin(t + i) * m.jitter) * jr * 0.8;
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 1.5 + i));
        ctx.fillStyle = stroke;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size / 18), 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced && state !== "none" && state !== "paused") raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state, size]);
  if (state === "none") return null;
  return <canvas ref={ref} className={["orb", className].filter(Boolean).join(" ")} style={{ width: size, height: size }} role="img" aria-label={label} aria-hidden={label ? undefined : true} />;
}
