"use client";
import { createContext, useContext, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export const TaskFieldButtonsContext = createContext(false);
export function useTaskFieldButtons() { return useContext(TaskFieldButtonsContext); }
export function TaskFieldButton({ label, editable, onEdit, children, expanded = false }: { expanded?: boolean; label: string; editable: boolean; onEdit: () => void; children: ReactNode }) {
  if (!editable) return <div data-field-value className="flex h-11 items-center text-sm">{children}</div>;
  return <button type="button" aria-label={`Editar ${label}`} aria-haspopup="dialog" aria-expanded={expanded} onClick={onEdit} className="inline-flex h-11 w-full max-w-full justify-between cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><span className="min-w-0 truncate" title={typeof children === "string" ? children : undefined}>{children}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></button>;
}
