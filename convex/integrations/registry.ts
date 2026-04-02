// convex/integrations/registry.ts
// =====================================================
// Registry central de providers de gestión de proyectos.
//
// Este módulo lee la configuración del tenant (integrationConfig)
// y devuelve la instancia correcta del provider.
//
// Uso desde cualquier Convex action:
//   import { getProjectManagementProvider, isProjectManagementEnabled } from "../integrations/registry";
//   
//   const provider = getProjectManagementProvider();
//   const client = await provider.searchClient("Coca Cola");
// =====================================================

import type { ProjectManagementProvider } from "./types";
import { createCORProvider } from "./corProvider";
import { createNoopProvider } from "./noopProvider";
import { integrationConfig } from "../lib/serverConfig";

/**
 * Devuelve el provider de gestión de proyectos activo según la configuración del tenant.
 * 
 * - Si `enabled === false` → retorna NoopProvider
 * - Si `provider === "cor"` → retorna CORProvider
 * - Si `provider === "noop"` → retorna NoopProvider
 * - Si `provider` no reconocido → retorna NoopProvider con warning
 */
export function getProjectManagementProvider(): ProjectManagementProvider {
  const config = integrationConfig.projectManagement;

  // Si la integración está deshabilitada, siempre retornar noop
  if (!config.enabled) {
    return createNoopProvider();
  }

  // Crear el provider según la configuración
  switch (config.provider) {
    case "cor":
      return createCORProvider();

    case "noop":
      return createNoopProvider();

    default:
      console.warn(
        `[Integration Registry] ⚠️ Provider desconocido: "${config.provider}". Usando noop como fallback.`
      );
      return createNoopProvider();
  }
}

/**
 * Verifica si la integración de gestión de proyectos está habilitada.
 * Útil para condicionar la disponibilidad de tools del agente.
 */
export function isProjectManagementEnabled(): boolean {
  return integrationConfig.projectManagement.enabled;
}

