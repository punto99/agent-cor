import type { Id } from "../_generated/dataModel";

/** Only an explicit false disables a user, preserving all existing records. */
export async function isInternalUserActive(
  ctx: any,
  userId: Id<"users">,
): Promise<boolean> {
  const corUser = await ctx.db
    .query("corUsers")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .unique();
  return corUser?.isActive !== false;
}
