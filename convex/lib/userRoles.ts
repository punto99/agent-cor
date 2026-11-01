import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// Check email too: an approved external may not have completed the async link yet.
export async function isExternalRoleTarget(ctx: QueryCtx, userId: Id<"users">) {
  if (await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique()) return true;
  const user = await ctx.db.get(userId);
  const email = user?.email?.trim().toLowerCase();
  return Boolean(email && await ctx.db.query("approvedExternalUsers").withIndex("by_email", q => q.eq("email", email)).unique());
}

// Called only by the auth callback, in the same transaction as account creation.
// Never backfill existing accounts or overwrite a role assigned by an administrator.
export async function ensureDefaultRoleForNewInternalUser(
  ctx: MutationCtx,
  args: { userId: Id<"users">; existingUserId: Id<"users"> | null; providerId: string },
) {
  if (args.providerId !== "google" || args.existingUserId !== null) return;
  if (!(await ctx.db.get(args.userId)) || await isExternalRoleTarget(ctx, args.userId)) return;
  const existing = await ctx.db.query("userAccessProfiles").withIndex("by_user", q => q.eq("userId", args.userId)).unique();
  if (existing) return;

  const now = Date.now();
  await ctx.db.insert("userAccessProfiles", {
    userId: args.userId,
    platformRole: "user",
    updatedAt: now,
    updatedBy: args.userId,
  });
  await ctx.db.insert("userRoleAuditLog", {
    actorId: args.userId,
    targetUserId: args.userId,
    before: JSON.stringify({ platformRole: null }),
    after: JSON.stringify({ platformRole: "user" }),
    createdAt: now,
  });
}

// Administrative roles never bypass client/category/task access checks.
export async function canAdministerPlatform(ctx: QueryCtx, userId: Id<"users"> | null) {
  if (!userId || !(await ctx.db.get(userId)) || await isExternalRoleTarget(ctx, userId)) return false;
  const profile = await ctx.db.query("userAccessProfiles").withIndex("by_user", q => q.eq("userId", userId)).unique();
  return profile?.platformRole === "admin" || profile?.platformRole === "super_admin";
}

export async function listPlatformAdminIds(ctx: QueryCtx) {
  const profiles = (await Promise.all((["admin", "super_admin"] as const).map(platformRole =>
    ctx.db.query("userAccessProfiles").withIndex("by_platform_role", q => q.eq("platformRole", platformRole)).collect(),
  ))).flat();
  const ids: Id<"users">[] = [];
  for (const userId of new Set(profiles.map(profile => profile.userId))) {
    if (await canAdministerPlatform(ctx, userId)) ids.push(userId);
  }
  return ids;
}

export async function requireUserRoleAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId || !(await canAdministerPlatform(ctx, userId))) {
    throw new Error("No tienes permisos para administrar roles de usuarios.");
  }
  return userId;
}

export function normalizeWorkRole(value: string | undefined) {
  const role = value?.trim();
  if (role && role.length > 100) throw new Error("El rol de trabajo admite hasta 100 caracteres.");
  return role || undefined;
}

// Converting/linking an external must not leave a dormant internal admin role.
// Only new role metadata is removed; existing access assignments stay untouched.
export async function removeInternalRoleProfileForExternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  approvedExternalUserId: Id<"approvedExternalUsers">,
  actorId: Id<"users">,
) {
  const profile = await ctx.db.query("userAccessProfiles").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!profile) return;
  await ctx.db.delete(profile._id);
  await ctx.db.insert("userRoleAuditLog", {
    actorId, targetUserId: userId, approvedExternalUserId,
    before: JSON.stringify({ platformRole: profile.platformRole, workRole: profile.workRole }),
    after: JSON.stringify({ platformRole: "user" }), createdAt: Date.now(),
  });
}
