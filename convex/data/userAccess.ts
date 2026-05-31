import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";

async function getApprovedExternalUser(ctx: any, userId: string) {
  return await ctx.db
    .query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
}

export const viewerAccessProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { isAuthenticated: false, kind: "anonymous" as const };

    const approvedExternalUser = await getApprovedExternalUser(ctx, userId);
    return {
      isAuthenticated: true,
      userId,
      kind: approvedExternalUser ? ("external" as const) : ("internal" as const),
      approvedExternalUserId: approvedExternalUser?._id,
    };
  },
});

export const getAccessProfileByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const approvedExternalUser = await getApprovedExternalUser(ctx, args.userId);
    return {
      userId: args.userId,
      kind: approvedExternalUser ? ("external" as const) : ("internal" as const),
      approvedExternalUserId: approvedExternalUser?._id,
    };
  },
});

export const getAccessProfileByThread = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (!thread) return null;

    const approvedExternalUser = await getApprovedExternalUser(
      ctx,
      thread.userId,
    );
    return {
      userId: thread.userId,
      kind: approvedExternalUser ? ("external" as const) : ("internal" as const),
      approvedExternalUserId: approvedExternalUser?._id,
    };
  },
});
