import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";

const OTP_REQUEST_LIMIT = 6;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;

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

export const recordExternalOtpRequest = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) {
      throw new Error("OTP_RESEND_RATE_LIMITED");
    }

    const now = Date.now();
    const windowStart = now - OTP_REQUEST_WINDOW_MS;
    const existing = await (ctx.db as any)
      .query("externalOtpRequestLimits")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .unique();

    const recentRequests = (existing?.requestTimestamps ?? []).filter(
      (timestamp: number) => timestamp > windowStart,
    );

    if (recentRequests.length >= OTP_REQUEST_LIMIT) {
      throw new Error("OTP_RESEND_RATE_LIMITED");
    }

    const requestTimestamps = [...recentRequests, now];
    if (existing) {
      await (ctx.db as any).patch(existing._id, {
        requestTimestamps,
        updatedAt: now,
      });
      return;
    }

    await (ctx.db as any).insert("externalOtpRequestLimits", {
      email,
      requestTimestamps,
      updatedAt: now,
    });
  },
});
