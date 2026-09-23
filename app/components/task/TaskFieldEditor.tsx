"use client";

import { useLayoutEffect, useRef, useState, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { TaskFieldButton } from "./TaskFieldButton";
import styles from "./TaskFieldEditor.module.css";

/** Presentation only: the supplied form retains its existing save/cancel handlers. */
export function TaskFieldEditor({ floating, label, value, onClose, busy, children }: {
  floating: boolean; label: string; value: ReactNode; onClose: () => void; busy: boolean; children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const saving = useRef(busy); saving.current = busy;
  const titleId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  useLayoutEffect(() => {
    if (!floating) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const field = anchor.current?.parentElement;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const width = panel.current.offsetWidth;
      const height = panel.current.offsetHeight;
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top, ready: true });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    const outside = (event: PointerEvent) => {
      if (!saving.current && event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) close.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving.current) close.current(); }
      if (event.key === "Tab") {
        const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('input, select, textarea, [data-calendar-focus="true"], [data-field-focus="true"]')?.focus({ preventScroll: true }));
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      // The compact trigger remounts after save/cancel. Avoid moving page scroll.
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        const target = previous?.isConnected ? previous : field?.querySelector<HTMLButtonElement>("button");
        target?.focus({ preventScroll: true });
      });
    };
  }, [floating]);
  if (!floating) return <>{children}</>;
  return <div ref={anchor}>
    <TaskFieldButton label={label} editable onEdit={() => { if (!busy) onClose(); }} expanded>{value}</TaskFieldButton>
    {createPortal(<div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`${styles.panel} fixed z-[80] w-[320px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-xl border border-border bg-card text-foreground shadow-xl`} style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><h4 id={titleId} className="text-sm font-semibold">{label}</h4><button type="button" disabled={busy} onClick={onClose} aria-label="Cerrar editor" className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted disabled:cursor-default"><X className="h-4 w-4" /></button></header>
      <div className="p-4">{children}</div>
    </div>, document.body)}
  </div>;
}
