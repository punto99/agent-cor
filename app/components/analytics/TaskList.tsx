import { CheckCircle2 } from "lucide-react";
import { formatDate } from "./utils";

export function TaskList({
  items,
}: {
  items: Array<{
    _id: string;
    title: string;
    deadline?: string;
    status: string;
    source?: "internal" | "external";
  }>;
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        No hay tasks para mostrar.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <div key={item._id} className="py-2 first:pt-0 last:pb-0">
          <div className="text-sm font-medium text-foreground truncate">
            {item.title}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {item.deadline ? formatDate(item.deadline) : "Sin fecha"} ·{" "}
            {item.status} · {item.source === "external" ? "Externa" : "Interna"}
          </div>
        </div>
      ))}
    </div>
  );
}
