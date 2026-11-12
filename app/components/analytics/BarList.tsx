import { EmptyState } from "./AnalyticsPanel";

export function BarList({
  items,
  total,
  scale = "total",
}: {
  items: Array<{ key: string; label: string; count: number }>;
  total: number;
  scale?: "total" | "max";
}) {
  const scaleMaximum =
    scale === "max" ? Math.max(...items.map((item) => item.count), 0) : total;

  if (items.length === 0 || scaleMaximum <= 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const percentage = Math.min((item.count / scaleMaximum) * 100, 100);
        const width = item.count > 0 ? Math.max(percentage, 2) : 0;
        return (
          <div key={item.key}>
            <div className="flex items-center justify-between gap-3 text-xs mb-1">
              <span className="text-foreground truncate">{item.label}</span>
              <span className="text-muted-foreground">{item.count}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
