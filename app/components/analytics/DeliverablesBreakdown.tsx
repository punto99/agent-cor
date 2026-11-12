import { EmptyState } from "./AnalyticsPanel";
import { formatNumber } from "./utils";

export function DeliverablesBreakdown({
  items,
  total,
}: {
  items: Array<{
    clientId: string;
    name: string;
    deliverablesTotal: number;
    projectCount: number;
    brands: Array<{
      clientBrandId: string;
      name: string;
      deliverablesTotal: number;
      projectCount: number;
      subBrands: Array<{
        subBrandId: string;
        name: string;
        deliverablesTotal: number;
        projectCount: number;
      }>;
    }>;
  }>;
  total: number;
}) {
  if (items.length === 0 || total === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-4">
      {items.map((client) => {
        const percentage = Math.round((client.deliverablesTotal / total) * 100);
        return (
          <div key={client.clientId} className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground font-medium truncate">
                {client.name}
              </span>
              <span className="text-muted-foreground whitespace-nowrap">
                {formatNumber(client.deliverablesTotal)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(percentage, 2)}%` }}
              />
            </div>
            {client.brands.length > 0 && (
              <div className="rounded-md border border-border bg-muted/25 divide-y divide-border">
                {client.brands.slice(0, 4).map((brand) => (
                  <div
                    key={brand.clientBrandId}
                    className="px-3 py-2 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-foreground truncate">
                        {brand.name}
                      </span>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {formatNumber(brand.deliverablesTotal)}
                      </span>
                    </div>
                    {brand.subBrands.length > 0 && (
                      <div className="text-muted-foreground truncate">
                        {brand.subBrands
                          .slice(0, 3)
                          .map(
                            (subBrand) =>
                              `${subBrand.name}: ${formatNumber(subBrand.deliverablesTotal)}`,
                          )
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
