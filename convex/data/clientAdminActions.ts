"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

type SyncClientsResult = {
  success: boolean;
  error?: string;
  stats: {
    totalCORClients: number;
    created: number;
    updated: number;
    errors: number;
    errorDetails: string[];
  };
};

export const syncClientsFromCOR = action({
  args: {},
  handler: async (ctx): Promise<SyncClientsResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await ctx.runQuery(internal.data.userAccess.hasPlatformAdminAccess, { userId }))) {
      throw new Error("No tienes permisos para sincronizar clientes.");
    }
    // The existing importer patches by corClientId, retaining Convex IDs and local settings.
    return await ctx.runAction(internal.data.backfill.backfillCorClients, {});
  },
});
