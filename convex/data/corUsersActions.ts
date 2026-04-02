"use node";

// convex/data/corUsersActions.ts
// =====================================================
// Actions para resolución de usuarios en COR.
// Separado de corUsers.ts porque requiere "use node" (HTTP a COR).
//
// Queries y mutations están en convex/data/corUsers.ts
// =====================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";

/**
 * Resuelve un usuario de Convex en COR.
 * 
 * 1. Lee el user de Convex (name, email de authTables)
 * 2. Busca por nombre en COR via provider.searchUsersByName
 * 3. De los resultados, busca coincidencia por email (más confiable)
 * 4. Si encuentra match → upsert en tabla corUsers
 * 5. Si no encuentra → log warning (el usuario no existe en COR)
 * 
 * Se ejecuta en background (schedulado desde afterUserCreatedOrUpdated).
 * Si COR está caído, falla silenciosamente — no bloquea el login.
 */
export const resolveUserInCOR = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    console.log(`[corUsers] 🔍 Intentando resolver usuario ${args.userId} en COR...`);

    try {
      // 1. Leer name/email del usuario de Convex (authTables)
      const userInfo = await ctx.runQuery(internal.data.corUsers.getUserBasicInfo, {
        userId: args.userId,
      });

      if (!userInfo) {
        console.warn(`[corUsers] ⚠️ Usuario ${args.userId} no encontrado en la base de datos.`);
        return;
      }

      const userName = userInfo.name;
      const userEmail = userInfo.email;

      if (!userName && !userEmail) {
        console.warn(`[corUsers] ⚠️ No se pudo obtener name/email del usuario ${args.userId}. Abortando resolución.`);
        return;
      }

      // 2. Buscar en COR por nombre
      const provider = getProjectManagementProvider();
      const searchTerm = userName || userEmail || "";

      if (!searchTerm) {
        console.warn(`[corUsers] ⚠️ Sin término de búsqueda para usuario ${args.userId}`);
        return;
      }

      const corUsers = await provider.searchUsersByName(searchTerm);

      if (corUsers.length === 0) {
        console.log(`[corUsers] ℹ️ No se encontró usuario en COR para "${searchTerm}". El usuario puede no existir en COR.`);
        return;
      }

      // 3. Buscar coincidencia por email (más confiable que nombre)
      let match = userEmail
        ? corUsers.find((u) => u.email.toLowerCase() === userEmail!.toLowerCase())
        : null;

      // Si no hay match por email, intentar por nombre completo
      if (!match && userName) {
        const nameLower = userName.toLowerCase();
        match = corUsers.find((u) => {
          const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
          return fullName === nameLower;
        });
      }

      // Si aún no hay match, tomar el primer resultado como fallback
      // (solo si hay un único resultado, para evitar ambigüedades)
      if (!match && corUsers.length === 1) {
        match = corUsers[0];
        console.log(`[corUsers] ℹ️ Único resultado en COR, usando como match: ${match.firstName} ${match.lastName}`);
      }

      if (!match) {
        console.log(`[corUsers] ℹ️ ${corUsers.length} resultados en COR para "${searchTerm}" pero ninguno coincide por email/nombre exacto.`);
        return;
      }

      // 4. Guardar en tabla corUsers
      await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
        userId: args.userId,
        corUserId: match.id,
        corFirstName: match.firstName,
        corLastName: match.lastName,
        corEmail: match.email,
        corRoleId: match.roleId,
        corPositionName: match.positionName,
      });

      console.log(`[corUsers] ✅ Usuario ${args.userId} resuelto en COR: ${match.firstName} ${match.lastName} (ID: ${match.id})`);
    } catch (error) {
      // No propagamos el error — es background, no debe afectar el login
      console.error(`[corUsers] ❌ Error resolviendo usuario en COR:`, error);
    }
  },
});

/**
 * Verifica que un usuario cacheado sigue existiendo en COR.
 * Busca por nombre y verifica que el corUserId coincida.
 * Actualiza lastVerifiedAt si el usuario sigue existiendo.
 */
export const verifyUserInCOR = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    try {
      // 1. Obtener el registro cacheado
      const corUser = await ctx.runQuery(internal.data.corUsers.getCorUserByUserId, {
        userId: args.userId,
      });

      if (!corUser) {
        console.log(`[corUsers] ℹ️ No hay registro de COR para usuario ${args.userId}. Nada que verificar.`);
        return;
      }

      // 2. Buscar en COR por nombre
      const provider = getProjectManagementProvider();
      const searchName = `${corUser.corFirstName} ${corUser.corLastName}`;
      const corUsers = await provider.searchUsersByName(searchName);

      // 3. Verificar que nuestro usuario sigue en los resultados
      const stillExists = corUsers.some((u) => u.id === corUser.corUserId);

      if (stillExists) {
        // Re-upsert para actualizar lastVerifiedAt y datos que pudieron cambiar
        const updatedData = corUsers.find((u) => u.id === corUser.corUserId)!;
        await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
          userId: args.userId,
          corUserId: updatedData.id,
          corFirstName: updatedData.firstName,
          corLastName: updatedData.lastName,
          corEmail: updatedData.email,
          corRoleId: updatedData.roleId,
          corPositionName: updatedData.positionName,
        });
        console.log(`[corUsers] ✅ Usuario verificado en COR: ${searchName} (ID: ${corUser.corUserId})`);
      } else {
        console.warn(`[corUsers] ⚠️ Usuario ${searchName} (COR ID: ${corUser.corUserId}) ya no se encuentra en COR.`);
      }
    } catch (error) {
      console.error(`[corUsers] ❌ Error verificando usuario en COR:`, error);
    }
  },
});
