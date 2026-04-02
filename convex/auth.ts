import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    afterUserCreatedOrUpdated: async (ctx, { userId, existingUserId }) => {
      // Solo para usuarios nuevos (no actualizaciones de perfil)
      if (existingUserId) return;

      // Resolver usuario en COR en background (no bloquea el login)
      await ctx.scheduler.runAfter(0, internal.data.corUsersActions.resolveUserInCOR, {
        userId,
      });
    },
  },
});
