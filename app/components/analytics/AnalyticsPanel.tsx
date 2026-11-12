import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";

export function AnalyticsPanel({
  title,
  children,
  className = "",
  icon,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-border bg-card p-4 ${className}`}
    >
      <div className="flex items-center gap-2 mb-4">
        {icon ?? <BarChart3 className="h-4 w-4 text-primary" />}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function EmptyState() {
  return <div className="text-sm text-muted-foreground">Sin datos.</div>;
}
