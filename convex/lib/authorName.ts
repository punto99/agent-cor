import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// External profiles own their display name; internal profiles use users.name.
export async function getAuthorName(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users"> | null | undefined,
  fallback = "Autor sin nombre",
): Promise<string> {
  if (!userId) return fallback;
  const external = await ctx.db.query("approvedExternalUsers")
    .withIndex("by_user", q => q.eq("userId", userId)).unique();
  return external?.name?.trim() || (await ctx.db.get(userId))?.name?.trim() || fallback;
}
