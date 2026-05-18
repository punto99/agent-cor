import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export const checkExternalEmailApproved = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) return { approved: false };

    const approvedUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    return { approved: approvedUser !== null };
  },
});

export const isApprovedExternalEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) return false;

    const approvedUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    return approvedUser !== null;
  },
});

export const getApprovedExternalUserByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const linkApprovedExternalUser = internalMutation({
  args: {
    email: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const approvedUser = await ctx.db
      .query("approvedExternalUsers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (!approvedUser) return;
    if (approvedUser.userId === args.userId) return;

    await ctx.db.patch(approvedUser._id, {
      userId: args.userId,
    });
  },
});
