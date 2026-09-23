import { CalendarDays } from "lucide-react";

export function RequestDeadline({ deadline }: { deadline?: string }) {
  const value = deadline?.trim();
  if (!value) return null;

  // Preserve the calendar date entered by the internal user across time zones.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  const label = match ? `${match[3]}/${match[2]}/${match[1]}` : value;
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
      <span><span className="font-medium">Deadline:</span> {label}</span>
    </span>
  );
}
