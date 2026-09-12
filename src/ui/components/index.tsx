// SPDX-License-Identifier: Apache-2.0
// Component kit (docs/design-system.md §4). Monochrome, token-only, no emoji.
import ReactDOM from "react-dom";
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { icons, type IconName } from "../icons";
import "./components.css";

// ------------------------------------------------------------------ Icon
export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const C = icons[name];
  return <C className={["icon", className].filter(Boolean).join(" ")} width={size} height={size} strokeWidth={1.75} aria-hidden={title ? undefined : true} aria-label={title} />;
}

// ---------------------------------------------------------------- Button
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: IconName;
  loading?: boolean;
  /** Consent buttons only accept activation via focused Enter/Space after being visible ≥ 500 ms (D-17). */
  consent?: boolean;
}
export function Button({ variant = "secondary", size = "md", icon, loading, consent, children, className, onClick, disabled, ...rest }: ButtonProps) {
  const [armed, setArmed] = useState(!consent);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!consent) return;
    const el = ref.current;
    if (!el) return;
    let timer: number | undefined;
    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          const visible = entries.some((e) => e.intersectionRatio >= 0.5);
          if (visible) timer = window.setTimeout(() => setArmed(true), 500);
          else { if (timer) window.clearTimeout(timer); setArmed(false); }
        }, { threshold: [0.5] })
      : null;
    if (io) io.observe(el); else timer = window.setTimeout(() => setArmed(true), 500);
    return () => { if (timer) window.clearTimeout(timer); io?.disconnect(); };
  }, [consent]);
  const handle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (consent && !armed) { e.preventDefault(); return; }
    onClick?.(e);
  }, [consent, armed, onClick]);
  return (
    <button ref={ref} type="button" className={["btn", `btn-${variant}`, `btn-${size}`, consent ? "btn-consent" : "", className].filter(Boolean).join(" ")}
      onClick={handle} disabled={disabled || loading || (consent && !armed)} aria-busy={loading || undefined} data-consent={consent ? (armed ? "armed" : "arming") : undefined} {...rest}>
      {loading ? <Icon name="loading" className="spin" /> : icon ? <Icon name={icon} /> : null}
      {children != null && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, ...rest }: Omit<ButtonProps, "children"> & { icon: IconName; label: string }) {
  return <Button variant="ghost" size="sm" icon={icon} aria-label={label} title={label} className="btn-icon" {...rest} />;
}

// ----------------------------------------------------------------- Input
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; hint?: string; error?: string; mono?: boolean }
export function Input({ label, hint, error, mono, id, className, ...rest }: InputProps) {
  const auto = useId();
  const iid = id ?? auto;
  return (
    <div className={["field", className].filter(Boolean).join(" ")}>
      {label && <label className="field-label" htmlFor={iid}>{label}</label>}
      <input id={iid} className={["input", mono ? "fs-mono" : "", error ? "input-error" : ""].filter(Boolean).join(" ")} aria-invalid={!!error} aria-describedby={hint || error ? `${iid}-hint` : undefined} {...rest} />
      {(hint || error) && <div id={`${iid}-hint`} className={error ? "field-error" : "field-hint"}>{error ?? hint}</div>}
    </div>
  );
}

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string }
export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ label, id, className, ...rest }, ref) {
  const auto = useId();
  const iid = id ?? auto;
  return (
    <div className={["field", className].filter(Boolean).join(" ")}>
      {label && <label className="field-label" htmlFor={iid}>{label}</label>}
      <textarea ref={ref} id={iid} className="input textarea" {...rest} />
    </div>
  );
});

// ---------------------------------------------------------------- Select
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> { label?: string; options: { value: string; label: string; disabled?: boolean }[]; hint?: string }
export function Select({ label, options, hint, id, className, ...rest }: SelectProps) {
  const auto = useId();
  const iid = id ?? auto;
  return (
    <div className={["field", className].filter(Boolean).join(" ")}>
      {label && <label className="field-label" htmlFor={iid}>{label}</label>}
      <div className="select-wrap">
        <select id={iid} className="input select" {...rest}>
          {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <Icon name="chevronDown" className="select-chevron" />
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Switch
export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; id?: string }) {
  const auto = useId();
  const iid = id ?? auto;
  return (
    <label className="switch-row" htmlFor={iid}>
      {label && <span className="grow">{label}</span>}
      <button id={iid} type="button" role="switch" aria-checked={checked} className={`switch ${checked ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="switch-knob" />
      </button>
    </label>
  );
}

// ------------------------------------------------------------------ Tabs
export interface TabItem { id: string; label: string; icon?: IconName; badge?: boolean }
export function Tabs({ items, value, onChange, variant = "underline", ariaLabel, iconOnly }: { items: TabItem[]; value: string; onChange: (id: string) => void; variant?: "underline" | "segmented" | "vertical"; ariaLabel?: string; /** Labels are visually hidden (sidebar): expose them as name + tooltip. */ iconOnly?: boolean }) {
  // Roving focus (WAI-ARIA tabs): exactly one tab stop, arrows move and activate; vertical lists use Up / Down
  // as well. When `value` matches no tab (a filter reset, a removed tab) the first tab is the tab stop —
  // otherwise every tab would be tabIndex -1 and the strip would be unreachable by keyboard.
  const selected = items.findIndex((it) => it.id === value);
  const stop = selected >= 0 ? selected : 0;
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === "ArrowRight" || (variant === "vertical" && e.key === "ArrowDown") ? 1 : e.key === "ArrowLeft" || (variant === "vertical" && e.key === "ArrowUp") ? -1 : e.key === "Home" ? -index : e.key === "End" ? items.length - 1 - index : 0;
    if (!next) return;
    e.preventDefault();
    const target = items[(index + next + items.length) % items.length];
    onChange(target.id);
    (e.currentTarget.parentElement?.children[(index + next + items.length) % items.length] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={`tabs tabs-${variant}`} role="tablist" aria-label={ariaLabel} aria-orientation={variant === "vertical" ? "vertical" : undefined}>
      {items.map((it, index) => (
        <button key={it.id} role="tab" type="button" aria-selected={value === it.id} tabIndex={index === stop ? 0 : -1} aria-label={iconOnly ? it.label : undefined} title={iconOnly ? it.label : undefined} className={`tab ${value === it.id ? "active" : ""}`} onClick={() => onChange(it.id)} onKeyDown={(e) => onKey(e, index)}>
          {it.icon && <Icon name={it.icon} />}
          <span>{it.label}</span>
          {it.badge && <span className="tab-badge" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Card
export type CardTone = "plain" | "decision" | "system" | "success" | "warning" | "error";
export function Card({ title, tone = "plain", icon, actions, children, className, collapsed, onToggle, footer }: { title?: React.ReactNode; tone?: CardTone; icon?: IconName; actions?: React.ReactNode; children?: React.ReactNode; className?: string; collapsed?: boolean; onToggle?: () => void; footer?: React.ReactNode }) {
  return (
    <section className={["card", `card-${tone}`, className].filter(Boolean).join(" ")}>
      {title != null && (
        <header className="card-head">
          {onToggle && <IconButton icon={collapsed ? "chevronRight" : "chevronDown"} label="" onClick={onToggle} aria-expanded={!collapsed} />}
          {icon && <Icon name={icon} />}
          <h3 className="grow truncate">{title}</h3>
          {actions}
        </header>
      )}
      {!collapsed && children != null && <div className="card-body">{children}</div>}
      {!collapsed && footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

// ---------------------------------------------------------------- Dialog
/** Open dialogs, innermost last. Only the top one reacts to Escape; the app's global Escape yields while any is open. */
const dialogStack: symbol[] = [];
export function hasOpenDialog(): boolean { return dialogStack.length > 0; }
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

export function Dialog({ open, onClose, title, children, footer, width = 520, closeLabel, destructive, className }: { open: boolean; onClose: () => void; title: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; width?: number; closeLabel: string; destructive?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers pass inline arrows: keep the latest in a ref so the effect below runs only on open/close, never on a
  // parent re-render (re-running it would re-focus the first control and steal focus from whatever the user is typing in).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = Symbol("dialog");
    dialogStack.push(me);
    const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const isTop = () => { const all = document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"); return !all.length || all[all.length - 1] === ref.current; };
    // Escape in the bubble phase: a control inside the dialog (shortcut recorder, combobox) that handled it
    // (`preventDefault`) keeps it; otherwise the innermost dialog closes.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e as KeyboardEvent & { isComposing?: boolean }).isComposing || e.defaultPrevented) return;
      if (!isTop()) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Innermost = last open modal in document order (effects run child-first, so the stack order is not usable).
      if (!isTop()) return;
      if (e.key === "Tab" && ref.current) {
        // Keep Tab inside the dialog: wrap from the last focusable to the first and back.
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !ref.current.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !ref.current.contains(active))) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onEsc);
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keydown", onEsc);
      const i = dialogStack.indexOf(me);
      if (i >= 0) dialogStack.splice(i, 1);
      // Give focus back to whatever opened the dialog (if it is still in the document).
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`dialog ${destructive ? "dialog-destructive" : ""} ${className ?? ""}`} style={className ? undefined : { width }}>
        <header className="dialog-head">
          <h2 className="grow" id={titleId}>{title}</h2>
          <IconButton icon="close" label={closeLabel} onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Tooltip
/**
 * Tooltip rendered into `document.body` (never clipped by a scroll/container
 * ancestor) and flipped to stay inside the viewport.
 */
export function Tooltip({ text, children }: { text: string; children: React.ReactElement }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number; above: boolean; alignRight: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.bottom + 48 > window.innerHeight;
    const alignRight = r.left + 160 > window.innerWidth;
    setPos({ x: alignRight ? r.right : r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above, alignRight });
  };
  const hide = () => setPos(null);
  return (
    <>
      <span ref={ref} className="tooltip-wrap" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>{children}</span>
      {pos && typeof document !== "undefined" && ReactDOM.createPortal(
        <div role="tooltip" className={`tooltip-pop ${pos.above ? "above" : "below"} ${pos.alignRight ? "align-right" : ""}`} style={{ left: pos.x, top: pos.y }}>{text}</div>,
        document.body,
      )}
    </>
  );
}

// ----------------------------------------------------------------- Badge
export function Badge({ children, tone = "neutral", mono }: { children: React.ReactNode; tone?: "neutral" | "error" | "warning" | "success" | "info"; mono?: boolean }) {
  return <span className={`badge badge-${tone} ${mono ? "fs-mono" : ""}`}>{children}</span>;
}

// ---------------------------------------------------------- ProgressRing
export function ProgressRing({ pct, size = 18, level = "ok", label, onClick }: { pct: number; size?: number; level?: "ok" | "hint" | "auto" | "emergency"; label?: string; onClick?: () => void }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  const cls = level === "emergency" ? "ring-emergency" : level === "auto" ? "ring-auto" : level === "hint" ? "ring-hint" : "ring-ok";
  const El = onClick ? "button" : "span";
  return (
    <El type={onClick ? "button" : undefined} className={`ring ${cls}`} onClick={onClick} aria-label={label} title={label} role={onClick ? undefined : "img"}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={2} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-fill" strokeWidth={2} fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
    </El>
  );
}

export function ProgressBar({ pct, tone = "neutral" }: { pct: number; tone?: "neutral" | "warning" | "error" }) {
  return <div className={`bar bar-${tone}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

// ------------------------------------------------------------------- Kbd
export function Kbd({ combo }: { combo: string }) {
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const parts = combo.split("+").map((k) => (k === "Mod" ? (isMac ? "Cmd" : "Ctrl") : k));
  return <span className="kbd-group">{parts.map((p, i) => <kbd key={i} className="kbd">{p}</kbd>)}</span>;
}

// ------------------------------------------------------------ EmptyState
export function EmptyState({ icon, title, hint, primary, secondary }: { icon?: IconName; title: string; hint?: string; primary?: React.ReactNode; secondary?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={20} className="muted" />}
      <div className="label">{title}</div>
      {hint && <div className="muted copy-sm">{hint}</div>}
      {(primary || secondary) && <div className="row">{primary}{secondary}</div>}
    </div>
  );
}

// -------------------------------------------------------------- Skeleton
export function Skeleton({ lines = 3, width }: { lines?: number; width?: string }) {
  return <div className="skeleton" aria-hidden>{Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton-line" style={{ width: width ?? `${90 - (i % 3) * 20}%` }} />)}</div>;
}

// ------------------------------------------------------------- SplitPane
export function SplitPane({ left, right, initial = 280, min = 200, max = 640, side = "left", storageKey }: { left: React.ReactNode; right: React.ReactNode; initial?: number; min?: number; max?: number; side?: "left" | "right"; storageKey?: string }) {
  const [size, setSize] = useState<number>(() => {
    try { const v = storageKey ? localStorage.getItem(`fs.split.${storageKey}`) : null; return v ? Number(v) : initial; } catch { return initial; }
  });
  const dragging = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: React.MouseEvent) => { dragging.current = true; e.preventDefault(); };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const raw = side === "left" ? e.clientX - rect.left : rect.right - e.clientX;
      setSize(Math.max(min, Math.min(max, raw)));
    };
    const up = () => { if (dragging.current) { dragging.current = false; try { if (storageKey) localStorage.setItem(`fs.split.${storageKey}`, String(size)); } catch { /* ignore */ } } };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [min, max, side, size, storageKey]);
  const fixed = <div className="split-fixed" style={{ width: size }}>{side === "left" ? left : right}</div>;
  const flex = <div className="split-flex">{side === "left" ? right : left}</div>;
  const nudge = (delta: number) => {
    const next = Math.max(min, Math.min(max, size + delta));
    setSize(next);
    try { if (storageKey) localStorage.setItem(`fs.split.${storageKey}`, String(next)); } catch { /* ignore */ }
  };
  const onHandleKey = (e: React.KeyboardEvent) => {
    // Keyboard resize: arrows move 16 px (shift: 64), Home / End snap to min / max. `side` decides which arrow grows the pane.
    const grow = side === "left" ? 1 : -1;
    const big = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowRight") nudge(grow * big); else if (e.key === "ArrowLeft") nudge(-grow * big);
    else if (e.key === "Home") nudge(min - size); else if (e.key === "End") nudge(max - size);
    else return;
    e.preventDefault();
  };
  const handle = <div className="split-handle" role="separator" aria-orientation="vertical" tabIndex={0} aria-valuemin={min} aria-valuemax={max} aria-valuenow={size} onMouseDown={onDown} onKeyDown={onHandleKey} />;
  return <div ref={ref} className="split">{side === "left" ? <>{fixed}{handle}{flex}</> : <>{flex}{handle}{fixed}</>}</div>;
}

// ----------------------------------------------------------- ContextMenu
export interface MenuItem { id: string; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean; shortcut?: string }
export function ContextMenu({ items, at, onSelect, onClose }: { items: MenuItem[]; at: { x: number; y: number } | null; onSelect: (id: string) => void; onClose: () => void }) {
  useEffect(() => {
    if (!at) return;
    const off = () => onClose();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", key); };
  }, [at, onClose]);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // WAI-ARIA menu pattern: the menu takes focus when it opens and gives it back to whatever had it.
  const openerRef = useRef<HTMLElement | null>(null);
  const enabledItems = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button.menu-item:not([disabled])") ?? []);
  const focusItem = (i: number) => {
    const els = enabledItems();
    if (els.length) els[((i % els.length) + els.length) % els.length].focus();
  };
  // Keep the menu inside the viewport (the "+" menu opens at the right edge of the tab strip).
  useLayoutEffect(() => {
    if (!at) { setPos(null); return; }
    // Captured before anything inside the menu takes focus, so closing gives it back.
    openerRef.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const w = el?.offsetWidth ?? 200; const h = el?.offsetHeight ?? 120;
    const x = Math.max(4, Math.min(at.x, window.innerWidth - w - 8));
    const y = Math.max(4, Math.min(at.y, window.innerHeight - h - 8));
    setPos({ x, y });
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, [at]);
  // Focus the first item only once the menu is placed: a `visibility: hidden` element cannot take focus.
  useEffect(() => { if (pos) focusItem(0); }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const els = enabledItems();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") focusItem(i + 1);
    else if (e.key === "ArrowUp") focusItem(i < 0 ? els.length - 1 : i - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(els.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  if (!at) return null;
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: (pos ?? at).x, top: (pos ?? at).y, visibility: pos ? "visible" : "hidden" }} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button key={it.id} role="menuitem" type="button" tabIndex={-1} disabled={it.disabled} className={`menu-item ${it.destructive ? "destructive" : ""}`} onClick={() => { onSelect(it.id); onClose(); }}>
          {it.icon && <Icon name={it.icon} />}
          <span className="grow">{it.label}</span>
          {it.shortcut && <Kbd combo={it.shortcut} />}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Chip
export function Chip({ icon, children, onRemove, removeLabel, mono = true, onClick, title }: { icon?: IconName; children: React.ReactNode; onRemove?: () => void; removeLabel?: string; mono?: boolean; onClick?: () => void; title?: string }) {
  const El = onClick ? "button" : "span";
  return (
    <span className="chip" title={title}>
      <El type={onClick ? "button" : undefined} className={`chip-main ${mono ? "fs-mono" : ""}`} onClick={onClick}>
        {icon && <Icon name={icon} className="icon-sm" />}
        <span className="truncate">{children}</span>
      </El>
      {onRemove && <button type="button" className="chip-x" aria-label={removeLabel ?? "remove"} onClick={onRemove}><Icon name="close" className="icon-sm" /></button>}
    </span>
  );
}

// -------------------------------------------------------------- Callout
export function Callout({ tone = "info", icon, children, actions }: { tone?: "info" | "warning" | "error" | "success"; icon?: IconName; children: React.ReactNode; actions?: React.ReactNode }) {
  const ic: IconName = icon ?? (tone === "error" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "done" : "info");
  return (
    <div className={`callout callout-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={ic} />
      <div className="grow">{children}</div>
      {actions}
    </div>
  );
}
