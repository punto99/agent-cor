"use node";

// convex/data/corClientsActions.ts
// =====================================================
// Actions para sincronización de clientes desde COR.
// Separado de corClients.ts porque requiere "use node" (HTTP a COR).
//
// Queries y mutations están en convex/data/corClients.ts
// =====================================================

import { internalAction } from "../_generated/server";
import { getProjectManagementProvider } from "../integrations/registry";

/**
 * Sincroniza la lista completa de clientes desde COR.
 * Placeholder — la sincronización actual se hace por demanda
 * cuando el agente busca un cliente via searchClientInCOR tool.
 * 
 * En el futuro se puede ampliar para hacer sync masivo.
 */
export const syncClientsFromCOR = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log(`[corClients] 🔄 Iniciando sincronización de clientes desde COR...`);

    try {
      const provider = getProjectManagementProvider();

      if (provider.name === "noop") {
        console.log(`[corClients] ℹ️ Provider es noop, no hay clientes que sincronizar.`);
        return { synced: 0 };
      }

      // Por ahora, la sincronización se hace por demanda
      // cuando el agente busca un cliente, se cachea automáticamente.
      // En el futuro se puede agregar un método listClients al provider.
      console.log(`[corClients] ℹ️ Sincronización completada via búsquedas individuales (por demanda).`);
      return { synced: 0 };
    } catch (error) {
      console.error(`[corClients] ❌ Error sincronizando clientes:`, error);
      return { synced: 0, error: String(error) };
    }
  },
});
