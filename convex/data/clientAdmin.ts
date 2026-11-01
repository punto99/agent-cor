import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { canAdministerPlatform, requireUserRoleAdmin } from "../lib/userRoles";

export const getDashboard = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!(await canAdministerPlatform(ctx, userId))) return { canAccess: false as const };
    const clients = await ctx.db.query("corClients").collect();
    return {
      canAccess: true as const,
      clients: clients
        .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }))
        .map(client => ({
          _id: client._id,
          name: client.name,
          corClientId: client.corClientId,
          externalBoardEnabled: client.externalBoardEnabled,
          syncedAt: client.syncedAt,
        })),
    };
  },
});

export const setExternalBoardEnabled = mutation({
  args: { clientId: v.id("corClients"), enabled: v.boolean() },
  handler: async (ctx, { clientId, enabled }) => {
    await requireUserRoleAdmin(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) throw new Error("Cliente no encontrado.");
    if (client.externalBoardEnabled !== enabled) {
      await ctx.db.patch(client._id, { externalBoardEnabled: enabled });
    }
    return { ok: true };
  },
});
