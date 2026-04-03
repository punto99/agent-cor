// convex/tools/validateUserForClientTool.ts
// Tool que valida que el usuario actual exista en COR y esté autorizado para un cliente.
// Reemplaza a searchClientInCORTool en los tools del agente.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import {
  getProjectManagementProvider,
  isProjectManagementEnabled,
} from "../integrations/registry";

export const validateUserForClientTool = createTool({
  description: `Validar que el usuario actual existe en el sistema de gestión (COR) y está autorizado para trabajar con un cliente específico.
  Usar INMEDIATAMENTE cuando el usuario indique para qué cliente/marca quiere crear un brief.
  
  Esta herramienta hace 3 validaciones:
  1. El usuario actual existe en COR
  2. El cliente existe en COR
  3. El usuario está autorizado para ese cliente
  
  Si alguna falla, devuelve un mensaje de error explicativo. NO continúes con el brief si falla.
  Si todo pasa, devuelve los IDs necesarios para crear la task.`,
  args: z.object({
    clientName: z
      .string()
      .describe("Nombre de la marca o cliente a validar"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log(
      `[ValidateUserForClient] 🔍 Validando usuario para cliente: "${args.clientName}"`
    );

    // --- Pre-check: integración habilitada ---
    if (!isProjectManagementEnabled()) {
      console.log(
        "[ValidateUserForClient] ⚠️ Integración de project management deshabilitada"
      );
      return JSON.stringify({
        authorized: false,
        error:
          "La integración con el sistema de gestión de proyectos no está habilitada.",
      });
    }

    const threadId = ctx.threadId;
    if (!threadId) {
      return JSON.stringify({
        authorized: false,
        error: "No se pudo identificar el thread de la conversación.",
      });
    }

    // ====================================================
    // 1. Obtener userId de Convex desde el thread
    // ====================================================
    const userId = await ctx.runQuery(
      internal.data.tasks.getUserIdFromThread,
      { threadId }
    );

    if (!userId) {
      console.log(
        "[ValidateUserForClient] ❌ No se encontró userId en el thread"
      );
      return JSON.stringify({
        authorized: false,
        error:
          "No se pudo identificar al usuario de esta conversación.",
      });
    }

    console.log(`[ValidateUserForClient] UserId: ${userId}`);

    // ====================================================
    // 2. Verificar que el usuario existe en COR
    // ====================================================
    let corUser = await ctx.runQuery(
      internal.data.corUsers.getCorUserByUserId,
      { userId: userId as any }
    );

    if (!corUser) {
      // Intentar resolverlo en COR (HTTP call)
      console.log(
        "[ValidateUserForClient] Usuario sin cache en COR, intentando resolver..."
      );
      try {
        await ctx.runAction(
          internal.data.corUsersActions.resolveUserInCOR,
          { userId: userId as any }
        );
      } catch (err) {
        console.error(
          "[ValidateUserForClient] Error resolviendo usuario en COR:",
          err
        );
      }

      // Re-consultar
      corUser = await ctx.runQuery(
        internal.data.corUsers.getCorUserByUserId,
        { userId: userId as any }
      );
    }

    if (!corUser) {
      console.log(
        "[ValidateUserForClient] ❌ Usuario no existe en COR"
      );
      return JSON.stringify({
        authorized: false,
        error: `Tu usuario no está registrado en el sistema de gestión de proyectos (COR). Contacta al administrador para que te registren.`,
      });
    }

    console.log(
      `[ValidateUserForClient] ✅ Usuario en COR: ${corUser.corFirstName} ${corUser.corLastName} (ID: ${corUser.corUserId})`
    );

    // ====================================================
    // 3. Buscar el cliente en COR
    // ====================================================
    const provider = getProjectManagementProvider();
    let corClient;

    try {
      corClient = await provider.searchClient(args.clientName);
    } catch (err) {
      console.error(
        "[ValidateUserForClient] Error buscando cliente en COR:",
        err
      );
      return JSON.stringify({
        authorized: false,
        error: `Error de conexión al buscar el cliente "${args.clientName}" en COR. Intenta de nuevo.`,
      });
    }

    if (!corClient) {
      console.log(
        `[ValidateUserForClient] ❌ Cliente no encontrado: "${args.clientName}"`
      );
      return JSON.stringify({
        authorized: false,
        error: `El cliente "${args.clientName}" no existe en el sistema de gestión de proyectos (COR). Verifica el nombre e intenta de nuevo.`,
      });
    }

    console.log(
      `[ValidateUserForClient] ✅ Cliente encontrado: ${corClient.name} (ID: ${corClient.id})`
    );

    // ====================================================
    // 4. Buscar cliente local y verificar autorización
    // ====================================================
    let localClient = await ctx.runQuery(
      internal.data.corClients.getClientByCorId,
      { corClientId: corClient.id }
    );

    // Si no existe localmente, hacer upsert
    if (!localClient) {
      console.log(
        "[ValidateUserForClient] Cliente no existe localmente, haciendo upsert..."
      );
      await ctx.runMutation(internal.data.corClients.upsertClient, {
        corClientId: corClient.id,
        name: corClient.name,
        businessName: corClient.businessName,
      });

      localClient = await ctx.runQuery(
        internal.data.corClients.getClientByCorId,
        { corClientId: corClient.id }
      );
    }

    if (!localClient) {
      return JSON.stringify({
        authorized: false,
        error:
          "Error interno al registrar el cliente localmente. Intenta de nuevo.",
      });
    }

    // ====================================================
    // 5. Verificar asignación usuario → cliente
    // ====================================================
    const isAuthorized = await ctx.runQuery(
      internal.data.corClients.isUserAuthorizedForClient,
      {
        clientId: localClient._id,
        userId: userId as any,
      }
    );

    if (!isAuthorized) {
      console.log(
        `[ValidateUserForClient] ❌ Usuario no autorizado para cliente ${corClient.name}`
      );
      return JSON.stringify({
        authorized: false,
        error: `No tienes autorización para crear briefs para el cliente "${corClient.name}". Contacta al administrador para que te asigne a este cliente.`,
      });
    }

    // ====================================================
    // 6. Todo OK — devolver datos validados
    // ====================================================
    console.log(
      `[ValidateUserForClient] ✅ Validación completa — usuario autorizado para ${corClient.name}`
    );

    return JSON.stringify({
      authorized: true,
      corUserId: corUser.corUserId,
      corClientId: corClient.id,
      corClientName: corClient.name,
      localClientId: localClient._id,
    });
  },
});
