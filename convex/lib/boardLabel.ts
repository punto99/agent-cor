import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Read the same persisted label used when publishing the brand to Trello.
// Cache per query so a column of tasks does not reread the same brand.
export function createBoardLabelReader(ctx: QueryCtx) {
  const labels = new Map<string, Promise<{ name: string; color?: string } | undefined>>();
  return (subBrandId?: Id<"subBrands">) => {
    if (!subBrandId) return Promise.resolve(undefined);
    if (!labels.has(subBrandId)) {
      labels.set(subBrandId, ctx.db.get(subBrandId).then(brand => brand ? {
        name: brand.trelloLabelName || brand.name,
        color: brand.trelloLabelColor,
      } : undefined));
    }
    return labels.get(subBrandId)!;
  };
}
