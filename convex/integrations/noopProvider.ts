// convex/integrations/noopProvider.ts
// =====================================================
// Provider "No-Op" para tenants sin integración con herramientas externas.
// Todos los métodos retornan null o lanzan errores descriptivos.
//
// Se usa cuando:
// - integrationConfig.projectManagement.enabled === false
// - integrationConfig.projectManagement.provider === "noop"
// - El provider configurado no existe (fallback)
// =====================================================

import type {
  ProjectManagementProvider,
  ExternalUser,
  ExternalClient,
  ExternalProject,
  ExternalTask,
  CreateProjectInput,
  CreateTaskInput,
  UpdateTaskInput,
} from "./types";

/**
 * Crea un provider vacío que no realiza operaciones externas.
 * Útil para tenants que solo usan Convex sin herramienta de gestión.
 */
export function createNoopProvider(): ProjectManagementProvider {
  return {
    name: "noop",

    async searchUsersByName(_name: string): Promise<ExternalUser[]> {
      console.log("[Noop Provider] searchUsersByName — no hay integración externa configurada");
      return [];
    },

    async searchClient(_name: string): Promise<ExternalClient | null> {
      console.log("[Noop Provider] searchClient — no hay integración externa configurada");
      return null;
    },

    async createProject(_data: CreateProjectInput): Promise<ExternalProject> {
      throw new Error(
        "No hay integración de gestión de proyectos configurada. " +
        "No se puede crear un proyecto externo. " +
        "Configura un provider en integrationConfig.projectManagement.provider"
      );
    },

    async createTask(_data: CreateTaskInput): Promise<ExternalTask> {
      throw new Error(
        "No hay integración de gestión de proyectos configurada. " +
        "No se puede crear una task externa. " +
        "Configura un provider en integrationConfig.projectManagement.provider"
      );
    },

    async getTask(_taskId: number): Promise<ExternalTask | null> {
      console.log("[Noop Provider] getTask — no hay integración externa configurada");
      return null;
    },

    async updateTask(
      _taskId: number,
      _data: UpdateTaskInput
    ): Promise<{ success: boolean; error?: string }> {
      return {
        success: false,
        error: "No hay integración de gestión de proyectos configurada.",
      };
    },
  };
}
