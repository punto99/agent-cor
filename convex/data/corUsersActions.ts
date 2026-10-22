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
import type { Id } from "../_generated/dataModel";
import { getProjectManagementProvider } from "../integrations/registry";

function getFirstName(name: string | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

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
      const searchTerm = getFirstName(userName);

      if (!searchTerm) {
        console.warn(`[corUsers] ⚠️ Sin término de búsqueda para usuario ${args.userId}`);
        return;
      }

      if (!userEmail) {
        console.warn(`[corUsers] ⚠️ El usuario ${args.userId} no tiene email para validar su identidad en COR.`);
        return;
      }

      const corUsers = await provider.searchUsersByName(searchTerm);

      if (corUsers.length === 0) {
        console.log(`[corUsers] No se encontró usuario en COR para "${searchTerm}". El usuario puede no existir en COR.`);
        return;
      }

      // 3. Buscar siempre coincidencia exacta por email.
      const normalizedUserEmail = userEmail.trim().toLowerCase();
      const match = corUsers.find(
        (u) => u.email.trim().toLowerCase() === normalizedUserEmail,
      );

      if (!match) {
        console.log(`[corUsers] ${corUsers.length} resultados en COR para "${searchTerm}" pero ninguno coincide con el email ${normalizedUserEmail}.`);
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
        console.log(`[corUsers] No hay registro de COR para usuario ${args.userId}. Nada que verificar.`);
        return;
      }

      // 2. Buscar en COR por nombre
      const provider = getProjectManagementProvider();
      const searchName = getFirstName(corUser.corFirstName);
      const corUsers = await provider.searchUsersByName(searchName);

      // 3. Verificar por email exacto que nuestro usuario sigue en los resultados
      const corEmail = corUser.corEmail.trim().toLowerCase();
      const updatedData = corUsers.find(
        (u) => u.email.trim().toLowerCase() === corEmail,
      );

      if (updatedData) {
        // Re-upsert para actualizar lastVerifiedAt y datos que pudieron cambiar
        await ctx.runMutation(internal.data.corUsers.upsertCorUser, {
          userId: args.userId,
          corUserId: updatedData.id,
          corFirstName: updatedData.firstName,
          corLastName: updatedData.lastName,
          corEmail: updatedData.email,
          corRoleId: updatedData.roleId,
          corPositionName: updatedData.positionName,
        });
        console.log(`[corUsers] ✅ Usuario verificado en COR: ${searchName} (${corEmail})`);
      } else {
        console.warn(`[corUsers] ⚠️ Usuario ${searchName} (${corEmail}) ya no se encuentra en COR.`);
      }
    } catch (error) {
      console.error(`[corUsers] ❌ Error verificando usuario en COR:`, error);
    }
  },
});

function haveSameUserIds(first: number[], second: number[]): boolean {
  if (first.length !== second.length) return false;
  const secondIds = new Set(second);
  return first.every((id) => secondIds.has(id));
}

type LocalCorUserForStatusSync = {
  corUserDocumentId: Id<"corUsers">;
  corUserId: number;
};

type CorUserStatusSyncResult = {
  status:
    | "no_users"
    | "unchanged"
    | "unstable_snapshot"
    | "completed"
    | "error";
  deactivated: number;
};

/**
 * Verificación diaria, conservadora y unidireccional de bajas en COR.
 *
 * - Los usuarios presentes no generan ninguna escritura local.
 * - Una ausencia debe repetirse en dos snapshots completos e idénticos.
 * - Cualquier error o diferencia entre snapshots aborta sin cambios.
 * - La única escritura permitida es isActive=false.
 */
export const syncInactiveCorUsersDaily = internalAction({
  args: {},
  handler: async (ctx): Promise<CorUserStatusSyncResult> => {
    try {
      const localCorUsers: LocalCorUserForStatusSync[] = await ctx.runQuery(
        internal.data.corUsers.listActiveCorUsersForStatusSync,
        {},
      );

      if (localCorUsers.length === 0) {
        console.log(
          "[CorUserStatusSync] Sin usuarios internos activos para verificar.",
        );
        return { status: "no_users" as const, deactivated: 0 };
      }

      const provider = getProjectManagementProvider();
      const firstSnapshot = await provider.listActiveUserIds();
      if (firstSnapshot.length < localCorUsers.length) {
        throw new Error(
          `COR devolvió menos usuarios (${firstSnapshot.length}) que los vínculos internos activos (${localCorUsers.length}).`,
        );
      }
      const firstIds = new Set(firstSnapshot);
      const missingOnFirstRead = localCorUsers.filter(
        (corUser: LocalCorUserForStatusSync) =>
          !firstIds.has(corUser.corUserId),
      );

      if (missingOnFirstRead.length === 0) {
        console.log(
          `[CorUserStatusSync] Verificación completa: ${localCorUsers.length} usuarios continúan activos en COR.`,
        );
        return { status: "unchanged" as const, deactivated: 0 };
      }

      const secondSnapshot = await provider.listActiveUserIds();
      if (!haveSameUserIds(firstSnapshot, secondSnapshot)) {
        console.warn(
          "[CorUserStatusSync] Los snapshots de COR no coinciden. Verificación abortada sin cambios.",
        );
        return { status: "unstable_snapshot" as const, deactivated: 0 };
      }

      const secondIds = new Set(secondSnapshot);
      const confirmedMissing = missingOnFirstRead.filter(
        (corUser: LocalCorUserForStatusSync) =>
          !secondIds.has(corUser.corUserId),
      );

      if (confirmedMissing.length === 0) {
        console.log(
          "[CorUserStatusSync] La segunda verificación encontró todos los usuarios. Sin cambios.",
        );
        return { status: "unchanged" as const, deactivated: 0 };
      }

      const result: { deactivatedCorUserIds: number[] } = await ctx.runMutation(
        internal.data.corUsers.deactivateConfirmedMissingCorUsers,
        {
          candidates: confirmedMissing.map(
            (corUser: LocalCorUserForStatusSync) => ({
              corUserDocumentId: corUser.corUserDocumentId,
              expectedCorUserId: corUser.corUserId,
            }),
          ),
        },
      );

      console.warn(
        `[CorUserStatusSync] Usuarios desactivados tras dos verificaciones: [${result.deactivatedCorUserIds.join(", ")}].`,
      );
      return {
        status: "completed" as const,
        deactivated: result.deactivatedCorUserIds.length,
      };
    } catch (error) {
      console.error(
        `[CorUserStatusSync] Verificación abortada sin cambios: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "error" as const, deactivated: 0 };
    }
  },
});
