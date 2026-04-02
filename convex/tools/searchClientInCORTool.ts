// convex/tools/searchClientInCORTool.ts
// Tool para buscar un cliente/marca en el sistema externo (COR)
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { getProjectManagementProvider, isProjectManagementEnabled } from "../integrations/registry";

// Solo se registra en el agente si la integración de project management está habilitada
export const searchClientInCORTool = createTool({
  description: `Buscar un cliente o marca en el sistema de gestión de proyectos externo (COR).
  Usar esta herramienta INMEDIATAMENTE después de que el usuario proporcione el nombre de la marca.
  Esto permite asociar la task con el cliente correcto en COR para cuando se publique.
  
  Recibe el nombre de la marca/cliente tal como lo dijo el usuario.
  Devuelve el ID del cliente si se encuentra, o un mensaje indicando que no se encontró.`,
  args: z.object({
    clientName: z.string().describe("Nombre de la marca o cliente a buscar en COR"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log(`[SearchClient] 🔍 Buscando cliente: "${args.clientName}"`);

    // Verificar si la integración está habilitada
    if (!isProjectManagementEnabled()) {
      console.log("[SearchClient] ⚠️ Integración de project management deshabilitada");
      return "La búsqueda de clientes en sistema externo no está habilitada para este tenant.";
    }

    try {
      const provider = getProjectManagementProvider();
      const client = await provider.searchClient(args.clientName);

      if (!client) {
        console.log(`[SearchClient] ⚠️ No se encontró cliente: "${args.clientName}"`);
        return `❌ No se encontró un cliente con el nombre "${args.clientName}" en el sistema de gestión de proyectos (COR).

IMPORTANTE: NO puedes crear un requerimiento para un cliente que no existe en COR.
Debes informar al usuario que el cliente "${args.clientName}" no existe en el sistema y pedirle que proporcione el nombre correcto de un cliente que ya esté registrado en COR.

NO continúes con la creación del brief hasta que el usuario proporcione un nombre de cliente válido que exista en COR.`;
      }

      console.log(`[SearchClient] ✅ Cliente encontrado: ${client.name} (ID: ${client.id})`);
      
      return `✅ Cliente encontrado en el sistema de gestión:

**Nombre:** ${client.name}
**ID:** ${client.id}
${client.businessName ? `**Razón social:** ${client.businessName}` : ""}

Este cliente se asociará automáticamente al brief cuando se cree la task.
Guarda este ID (${client.id}) para usarlo al crear el brief con createTask.

IMPORTANTE: Usa corClientId: ${client.id} y corClientName: "${client.name}" cuando llames a createTask.`;
    } catch (error) {
      console.error(`[SearchClient] ❌ Error:`, error);
      return `Error al buscar cliente: ${error instanceof Error ? error.message : String(error)}

Esto no impide crear el brief — puedes continuar normalmente.`;
    }
  },
});
