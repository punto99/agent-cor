"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function TaskDateCalendar({ value, min, disabled, onChange }: {
  value: string; min: string; disabled: boolean; onChange: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const initial = parseDate(value && value >= min ? value : min);
    return new Date(initial.getFullYear(), initial.getMonth(), 1);
  });
  const grid = useRef<HTMLDivElement>(null);
  const year = month.getFullYear();
  const index = month.getMonth();
  const offset = (month.getDay() + 6) % 7;
  const days = new Date(year, index + 1, 0).getDate();
  const monthLabel = month.toLocaleDateString("es", { month: "long", year: "numeric" });
  const previousAllowed = dateKey(new Date(year, index, 0)) >= min;
  const activeDay = value.startsWith(dateKey(month).slice(0, 7)) && value >= min ? value : min.startsWith(dateKey(month).slice(0, 7)) ? min : dateKey(month);

  function moveFocus(key: string, day: number) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[key];
    if (delta === undefined) return false;
    const next = new Date(year, index, day + delta);
    const nextKey = dateKey(next);
    if (nextKey < min) return true;
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${nextKey}"]`)?.focus());
    return true;
  }

  return <div aria-label="Seleccionar fecha de fin">
    <div className="mb-3 flex items-center justify-between gap-2">
      <button type="button" aria-label="Mes anterior" disabled={disabled || !previousAllowed} onClick={() => setMonth(new Date(year, index - 1, 1))} className="rounded-md p-1.5 hover:bg-muted disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
      <p aria-live="polite" className="text-sm font-semibold capitalize">{monthLabel}</p>
      <button type="button" aria-label="Mes siguiente" disabled={disabled} onClick={() => setMonth(new Date(year, index + 1, 1))} className="rounded-md p-1.5 hover:bg-muted disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
    </div>
    <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground" aria-hidden="true">{["L", "M", "X", "J", "V", "S", "D"].map(day => <span key={day} className="py-1">{day}</span>)}</div>
    <div ref={grid} className="grid grid-cols-7 gap-1" role="group" aria-label={monthLabel}>
      {Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} />)}
      {Array.from({ length: days }, (_, i) => {
        const day = i + 1;
        const date = new Date(year, index, day);
        const key = dateKey(date);
        const selected = key === value;
        return <button key={key} type="button" data-date={key} data-calendar-focus={key === activeDay ? "true" : undefined} tabIndex={key === activeDay ? 0 : -1} aria-label={date.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} aria-pressed={selected} disabled={disabled || key < min} onClick={() => onChange(key)} onKeyDown={event => { if (moveFocus(event.key, day)) event.preventDefault(); }} className={`h-8 rounded-md text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-25 ${selected ? "bg-primary font-semibold text-primary-foreground" : key === min ? "bg-muted font-semibold text-foreground hover:bg-accent" : "hover:bg-muted"}`}>{day}</button>;
      })}
    </div>
    <p className="mt-3 text-xs text-muted-foreground">{value ? `Seleccionada: ${parseDate(value).toLocaleDateString("es")}` : "Elegí un día para la fecha de fin."}</p>
  </div>;
}
