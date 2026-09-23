"use client";

import { useRef } from "react";
import { Check } from "lucide-react";

export function TaskFieldOptions({ label, options, value, disabled, onChange, colorFn }: {
  label: string; options: { value: string; label: string }[]; value: string;
  disabled: boolean; onChange: (value: string) => void; colorFn?: (value: string) => string;
}) {
  const list = useRef<HTMLDivElement>(null);
  return <div ref={list} role="radiogroup" aria-label={label} className="space-y-0.5" onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || disabled) return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    onChange(options[next].value);
  }}>
    {options.map((option, index) => {
      const selected = option.value === value;
      const focusable = selected || (!options.some(item => item.value === value) && index === 0);
      const color = colorFn?.(option.value);
      return <button key={option.value} type="button" role="radio" aria-checked={selected} disabled={disabled} tabIndex={focusable ? 0 : -1} data-field-focus={focusable ? "true" : undefined} onClick={() => onChange(option.value)} className={`flex min-h-8 w-full items-center justify-between gap-3 rounded-lg border px-2.5 py-1 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${selected ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted"}`}>
        <span className={color ? `rounded-md px-2 py-0.5 text-xs ${color}` : ""}>{option.label}</span>
        <span className="h-4 w-4 shrink-0">{selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}</span>
      </button>;
    })}
  </div>;
}
