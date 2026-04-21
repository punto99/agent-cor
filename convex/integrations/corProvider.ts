// convex/integrations/corProvider.ts
// =====================================================
// Provider de COR (ProjectCOR) para el sistema de integraciones.
// Implementa la interface ProjectManagementProvider con llamadas
// a la API REST de COR v1.
//
// Este archivo contiene funciones puras (no Convex primitives).
// Se invocan desde dentro de Convex actions.
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
  UpdateProjectInput,
  UploadTaskAttachmentInput,
  ExternalAttachmentResult,
} from "./types";

// ==================== CONFIGURACIÓN ====================

const COR_API_BASE_URL = "https://api.projectcor.com/v1";

// ==================== TIPOS INTERNOS COR ====================

interface CORTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

// ==================== HELPERS HTTP ====================

/**
 * Obtiene un access token de COR usando Client Credentials flow.
 * Las credenciales deben estar en env vars: COR_API_KEY y COR_CLIENT_SECRET
 */
async function getCORAccessToken(): Promise<string> {
  const apiKey = process.env.COR_API_KEY;
  const clientSecret = process.env.COR_CLIENT_SECRET;

  if (!apiKey || !clientSecret) {
    throw new Error(
      "COR credentials not configured. Set COR_API_KEY and COR_CLIENT_SECRET in Convex dashboard."
    );
  }

  const credentials = btoa(`${apiKey}:${clientSecret}`);

  const response = await fetch(
    `${COR_API_BASE_URL}/oauth/token?grant_type=client_credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`COR auth failed: ${response.status} - ${errorText}`);
  }

  const tokenData: CORTokenResponse = await response.json();
  return tokenData.access_token;
}

/**
 * Parsea una fecha en formato DD/MM/YYYY o ISO a un objeto Date válido.
 * JavaScript no entiende DD/MM/YYYY nativamente, así que lo convertimos.
 */
function parseDateFlexible(dateStr: string): Date | null {
  // Intentar formato DD/MM/YYYY
  const ddmmyyyy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (!isNaN(d.getTime())) return d;
  }

  // Intentar formato ISO u otros formatos nativos de JS
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  return null;
}

/**
 * Mapea prioridades internas al formato numérico de COR.
 * Acepta texto ("baja", "media", "alta", "urgente") o número (0-3).
 * COR: 0 = Low, 1 = Medium, 2 = High, 3 = Urgent
 */
function mapPriorityToCOR(priority: string | number | undefined): number {
  if (typeof priority === "number") return priority;
  switch (priority?.toLowerCase()) {
    case "baja":
    case "low":
      return 0;
    case "alta":
    case "high":
      return 2;
    case "urgente":
    case "urgent":
      return 3;
    case "media":
    case "medium":
    default:
      return 1;
  }
}

/**
 * COR espera deliverables como entero. Acepta number o string numérico.
 * Si el valor no es entero válido, retorna undefined para omitir el campo.
 */
function mapDeliverablesToCOR(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  }
  return undefined;
}

function parseDeliverablesFromCOR(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  }
  return undefined;
}

/**
 * Normaliza description al formato esperado por COR.
 * Si ya viene como HTML, se envía tal cual.
 * Si viene como texto plano, se convierte a <br> para mantener saltos de línea.
 */
function normalizeDescriptionForCOR(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // Si contiene tags HTML, asumir que ya viene en rich text
  if (/<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return text;
  }

  // Fallback para compatibilidad: plain text → html con <br>
  return text.replace(/\n/g, "<br>\n");
}

/**
 * Wrapper genérico para llamadas autenticadas a la API de COR.
 * Obtiene el token automáticamente y agrega headers de auth.
 */
async function corApiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const accessToken = await getCORAccessToken();

  return fetch(`${COR_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {}),
    },
  });
}

// ==================== HELPERS: FEES ====================

/**
 * Obtiene el primer fee activo de un cliente en COR.
 * COR requiere fee_id al crear un proyecto.
 * Endpoint: GET /clients/{client_id}/fees
 */
async function getFirstActiveFeeForClient(clientId: number): Promise<number | null> {
  try {
    const response = await corApiFetch(`/clients/${clientId}/fees`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[COR Provider] ❌ Error obteniendo fees del cliente ${clientId}: ${response.status} - ${errorText}`);
      return null;
    }

    const fees = await response.json();
    
    // fees puede ser un array directo o un objeto con propiedad "data"
    const feeList = Array.isArray(fees) ? fees : (fees.data || []);
    
    if (feeList.length === 0) {
      console.log(`[COR Provider] ⚠️ El cliente ${clientId} no tiene fees`);
      return null;
    }

    // Preferir fee activo, si no tomar el primero
    const activeFee = feeList.find((f: any) => f.status === "active") || feeList[0];
    console.log(`[COR Provider] ✅ Fee encontrado: ${activeFee.id} (${activeFee.name || "sin nombre"}, status: ${activeFee.status || "unknown"})`);
    
    return activeFee.id;
  } catch (error) {
    console.error(`[COR Provider] ❌ Error en getFirstActiveFeeForClient:`, error);
    return null;
  }
}

// ==================== FACTORY DEL PROVIDER ====================

/**
 * Crea una instancia del provider de COR.
 * 
 * Uso:
 * ```
 * const provider = createCORProvider();
 * const client = await provider.searchClient("Coca Cola");
 * const project = await provider.createProject({ name: "Campaña Q1", clientId: client.id });
 * const task = await provider.createTask({ projectId: project.id, title: "Diseño banner" });
 * ```
 */
export function createCORProvider(): ProjectManagementProvider {
  return {
    name: "cor",

    // ==================== SEARCH USERS BY NAME ====================

    async searchUsersByName(name: string): Promise<ExternalUser[]> {
      console.log(`[COR Provider] 🔍 Buscando usuarios por nombre: "${name}"`);

      try {
        const encodedName = encodeURIComponent(name);
        const response = await corApiFetch(`/users/search-by-name/${encodedName}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[COR Provider] ❌ Error buscando usuarios: ${response.status} - ${errorText}`);
          return [];
        }

        const result = await response.json();
        const users = Array.isArray(result) ? result : (result.data || []);

        console.log(`[COR Provider] ✅ Encontrados ${users.length} usuarios para "${name}"`);

        return users.map((u: Record<string, unknown>) => ({
          id: u.id as number,
          firstName: (u.first_name as string) || "",
          lastName: (u.last_name as string) || "",
          email: (u.email as string) || "",
          roleId: (u.role_id as number) ?? undefined,
          positionName: (u.position_name as string) ?? undefined,
        }));
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en searchUsersByName:`, error);
        return [];
      }
    },

    // ==================== SEARCH CLIENT ====================

    async searchClient(name: string): Promise<ExternalClient | null> {
      console.log(`[COR Provider] 🔍 Buscando cliente: "${name}"`);

      try {
        const encodedName = encodeURIComponent(name);
        const response = await corApiFetch(`/clients/search-by-name/${encodedName}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[COR Provider] ❌ Error buscando cliente: ${response.status} - ${errorText}`);
          return null;
        }

        const result = await response.json();
        
        // La API puede retornar un array directo o un objeto con propiedad "data"
        const clients = Array.isArray(result) ? result : (result.data || []);

        if (clients.length === 0) {
          console.log(`[COR Provider] ⚠️ No se encontró cliente con nombre "${name}"`);
          return null;
        }

        // Tomar el primer resultado (más relevante)
        const client = clients[0];
        console.log(`[COR Provider] ✅ Cliente encontrado: ${client.name} (ID: ${client.id})`);

        return {
          id: client.id,
          name: client.name,
          businessName: (client.business_name as string) ?? undefined,
          email: (client.email_contact as string) ?? undefined,
        };
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en searchClient:`, error);
        return null;
      }
    },

    // ==================== CREATE PROJECT ====================

    async createProject(data: CreateProjectInput): Promise<ExternalProject> {
      console.log(`[COR Provider] 🚀 Creando proyecto: "${data.name}" (client_id: ${data.clientId})`);

      // 1. Resolver fee_id — COR lo requiere para crear un proyecto
      let feeId = data.feeId;
      if (!feeId) {
        console.log(`[COR Provider] 🔍 Buscando fees para cliente ${data.clientId}...`);
        const resolvedFeeId = await getFirstActiveFeeForClient(data.clientId);
        if (!resolvedFeeId) {
          throw new Error(
            `No se encontró un fee activo para el cliente ${data.clientId}. ` +
            `Asegúrate de que el cliente tenga al menos un fee/tarifa activa en COR.`
          );
        }
        feeId = resolvedFeeId;
        console.log(`[COR Provider] ✅ Fee encontrado: ${feeId}`);
      }

      // 2. Construir body del request
      const body: Record<string, unknown> = {
        name: data.name,
        client_id: data.clientId,
        fee_id: feeId,
      };

      if (data.description) {
        body.brief = data.description;
      }

      if (data.estimatedTime) {
        body.estimated_time = data.estimatedTime;
      }

      if (data.deadline) {
        const deadlineDate = parseDateFlexible(data.deadline);
        if (deadlineDate) {
          // COR espera formato YYYY-MM-DD para start/end
          body.end = deadlineDate.toISOString().split("T")[0];
          console.log(`[COR Provider] 📅 Deadline proyecto: "${data.deadline}" → ${body.end}`);
        } else {
          console.warn(`[COR Provider] ⚠️ No se pudo parsear deadline proyecto: "${data.deadline}"`);
        }
      }

      // 3. Crear proyecto en COR
      const response = await corApiFetch("/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[COR Provider] ❌ Error creando proyecto: ${response.status} - ${errorText}`);
        throw new Error(`Error creando proyecto en COR: ${response.status} - ${errorText}`);
      }

      const project = await response.json();
      console.log(`[COR Provider] ✅ Proyecto creado: ID ${project.id}, nombre: "${project.name}"`);

      return {
        id: project.id,
        name: project.name,
        clientId: data.clientId,
      };
    },

    // ==================== CREATE TASK ====================

    async createTask(data: CreateTaskInput): Promise<ExternalTask> {
      console.log(`[COR Provider] 🚀 Creando task: "${data.title}" (project_id: ${data.projectId})`);

      const body: Record<string, unknown> = {
        title: data.title,
        project_id: data.projectId,
        priority: mapPriorityToCOR(data.priority),
      };

      if (data.description) {
        body.description = normalizeDescriptionForCOR(data.description);
      }

      if (data.status) {
        body.status = data.status;
      }

      if (data.deadline) {
        const deadlineDate = parseDateFlexible(data.deadline);
        if (deadlineDate) {
          body.deadline = deadlineDate.toISOString();
          console.log(`[COR Provider] 📅 Deadline parseado: "${data.deadline}" → ${deadlineDate.toISOString()}`);
        } else {
          console.warn(`[COR Provider] ⚠️ No se pudo parsear deadline: "${data.deadline}"`);
        }
      }

      const response = await corApiFetch("/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[COR Provider] ❌ Error creando task: ${response.status} - ${errorText}`);
        throw new Error(`Error creando task en COR: ${response.status} - ${errorText}`);
      }

      const task = await response.json();
      console.log(`[COR Provider] ✅ Task creada: ID ${task.id}`);

      return {
        id: task.id,
        title: task.title,
        projectId: task.project_id,
        description: task.description,
        deadline: task.deadline,
        status: task.status,
        priority: task.priority,
      };
    },

    // ==================== GET TASK ====================

    async getTask(taskId: number): Promise<ExternalTask | null> {
      console.log(`[COR Provider] 🔍 Obteniendo task: ${taskId}`);

      try {
        const response = await corApiFetch(`/tasks/${taskId}`);

        if (!response.ok) {
          console.error(`[COR Provider] ❌ Error obteniendo task: ${response.status}`);
          return null;
        }

        const task = await response.json();

        return {
          id: task.id,
          title: task.title,
          projectId: task.project_id,
          description: task.description,
          deadline: task.deadline,
          status: task.status,
          priority: task.priority,
        };
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en getTask:`, error);
        return null;
      }
    },

    // ==================== GET PROJECT ====================

    async getProject(projectId: number): Promise<ExternalProject | null> {
      console.log(`[COR Provider] 🔍 Obteniendo proyecto: ${projectId}`);

      try {
        const response = await corApiFetch(`/projects/${projectId}`);

        if (!response.ok) {
          console.error(`[COR Provider] ❌ Error obteniendo proyecto: ${response.status}`);
          return null;
        }

        const project = await response.json();

        return {
          id: project.id,
          name: project.name,
          clientId: project.client_id,
          brief: project.brief,
          startDate: project.start,
          endDate: project.end,
          deliverables: parseDeliverablesFromCOR(project.deliverables),
          status: project.status,
          estimatedTime: project.estimated_time,
        };
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en getProject:`, error);
        return null;
      }
    },

    // ==================== UPDATE TASK ====================

    async updateTask(
      taskId: number,
      data: UpdateTaskInput
    ): Promise<{ success: boolean; error?: string }> {
      console.log(`[COR Provider] 🔄 Actualizando task: ${taskId}`);

      try {
        // 1. GET actual para preservar campos no modificados
        const getResponse = await corApiFetch(`/tasks/${taskId}`);

        if (!getResponse.ok) {
          return {
            success: false,
            error: `No se pudo obtener la task actual: ${getResponse.status}`,
          };
        }

        const currentTask = await getResponse.json();

        // 2. Merge seguro: solo sobrescribir campos explícitamente proporcionados
        // IMPORTANTE: usar != null (cubre null y undefined) en vez de truthy checks
        // para evitar que valores legítimos como 0, "" sean ignorados
        const updateBody: Record<string, unknown> = {
          title: data.title ?? currentTask.title,
          description: data.description != null
            ? normalizeDescriptionForCOR(data.description)
            : currentTask.description,
          priority: data.priority != null
            ? mapPriorityToCOR(data.priority)
            : currentTask.priority,
          status: data.status ?? currentTask.status,
          deadline: currentTask.deadline,
        };

        if (data.deadline) {
          const d = parseDateFlexible(data.deadline);
          if (d) {
            updateBody.deadline = d.toISOString();
            console.log(`[COR Provider] 📅 Deadline update: "${data.deadline}" → ${d.toISOString()}`);
          } else {
            console.warn(`[COR Provider] ⚠️ No se pudo parsear deadline update: "${data.deadline}"`);
          }
        }

        // 3. PUT con objeto completo
        const putResponse = await corApiFetch(`/tasks/${taskId}`, {
          method: "PUT",
          body: JSON.stringify(updateBody),
        });

        if (!putResponse.ok) {
          const errorText = await putResponse.text();
          return {
            success: false,
            error: `COR API error: ${putResponse.status} - ${errorText}`,
          };
        }

        console.log(`[COR Provider] ✅ Task ${taskId} actualizada correctamente`);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // ==================== UPDATE PROJECT ====================

    async updateProject(
      projectId: number,
      data: UpdateProjectInput
    ): Promise<{ success: boolean; error?: string }> {
      console.log(`[COR Provider] 🔄 Actualizando proyecto: ${projectId}`);

      try {
        // 1. GET actual para preservar campos no modificados
        const getResponse = await corApiFetch(`/projects/${projectId}`);

        if (!getResponse.ok) {
          return {
            success: false,
            error: `No se pudo obtener el proyecto actual: ${getResponse.status}`,
          };
        }

        const currentProject = await getResponse.json();

        // 2. Merge seguro: solo sobrescribir campos explícitamente proporcionados
        const updateBody: Record<string, unknown> = {
          name: data.name ?? currentProject.name,
          brief: data.brief ?? currentProject.brief,
          estimated_time: data.estimatedTime ?? currentProject.estimated_time,
          status: data.status ?? currentProject.status,
          start: currentProject.start,
          end: currentProject.end,
        };

        const deliverablesCandidate = data.deliverables ?? currentProject.deliverables;
        const deliverables = mapDeliverablesToCOR(deliverablesCandidate);
        if (deliverables !== undefined) {
          updateBody.deliverables = deliverables;
        }

        if (data.startDate) {
          const d = parseDateFlexible(data.startDate);
          if (d) updateBody.start = d.toISOString().split("T")[0];
        }

        if (data.endDate) {
          const d = parseDateFlexible(data.endDate);
          if (d) updateBody.end = d.toISOString().split("T")[0];
        }

        // 3. PUT con objeto completo
        const putResponse = await corApiFetch(`/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify(updateBody),
        });

        if (!putResponse.ok) {
          const errorText = await putResponse.text();
          return {
            success: false,
            error: `COR API error: ${putResponse.status} - ${errorText}`,
          };
        }

        console.log(`[COR Provider] ✅ Proyecto ${projectId} actualizado correctamente`);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // ==================== UPLOAD TASK ATTACHMENT ====================

    async uploadTaskAttachment(
      data: UploadTaskAttachmentInput
    ): Promise<{ success: boolean; attachment?: ExternalAttachmentResult; error?: string }> {
      console.log(`[COR Provider] 📎 Subiendo attachment a task: ${data.taskId}`);
      console.log(`[COR Provider]   Archivo: ${data.filename} (${data.mimeType}, ${(data.fileBuffer.byteLength / 1024).toFixed(1)}KB)`);

      try {
        const accessToken = await getCORAccessToken();

        const formData = new FormData();
        const blob = new Blob([data.fileBuffer], { type: data.mimeType });
        formData.append("file", blob, data.filename);

        const response = await fetch(
          `${COR_API_BASE_URL}/tasks/${data.taskId}/attachments`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              // No Content-Type — FormData lo establece automáticamente con boundary
            },
            body: formData,
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[COR Provider] ❌ Error subiendo attachment: ${response.status} - ${errorText}`);
          return {
            success: false,
            error: `COR API error: ${response.status} - ${errorText}`,
          };
        }

        const result = await response.json();
        const uploadedFile = result.files?.[0];

        if (!uploadedFile) {
          return {
            success: false,
            error: "COR no retornó información del archivo subido",
          };
        }

        console.log(`[COR Provider] ✅ Attachment subido: ID ${uploadedFile.id}, nombre: ${uploadedFile.originalname || data.filename}`);

        return {
          success: true,
          attachment: {
            id: uploadedFile.id,
            url: uploadedFile.url,
            name: uploadedFile.originalname || data.filename,
            size: uploadedFile.size || data.fileBuffer.byteLength,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // ==================== LIST ALL USERS ====================

    async listAllUsers(): Promise<ExternalUser[]> {
      console.log(`[COR Provider] 📋 Obteniendo TODOS los usuarios de COR (page=false)...`);

      try {
        const response = await corApiFetch(`/users?page=false`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[COR Provider] ❌ Error listando usuarios: ${response.status} - ${errorText}`);
          return [];
        }

        const result = await response.json();
        // Cuando page=false, COR puede retornar { data: [...] } o un array directo
        const users = Array.isArray(result) ? result : (result.data || []);

        console.log(`[COR Provider] ✅ Obtenidos ${users.length} usuarios de COR`);

        return users.map((u: Record<string, unknown>) => ({
          id: u.id as number,
          firstName: (u.first_name as string) || "",
          lastName: (u.last_name as string) || "",
          email: (u.email as string) || "",
          roleId: (u.role_id as number) ?? undefined,
          positionName: (u.position_name as string) ?? undefined,
        }));
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en listAllUsers:`, error);
        return [];
      }
    },

    // ==================== LIST ALL CLIENTS ====================

    async listAllClients(): Promise<ExternalClient[]> {
      console.log(`[COR Provider] 📋 Obteniendo TODOS los clientes de COR (page=false)...`);

      try {
        const response = await corApiFetch(`/clients?page=false`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[COR Provider] ❌ Error listando clientes: ${response.status} - ${errorText}`);
          return [];
        }

        const result = await response.json();
        // Cuando page=false, COR puede retornar { data: [...] } o un array directo
        const clients = Array.isArray(result) ? result : (result.data || []);

        console.log(`[COR Provider] ✅ Obtenidos ${clients.length} clientes de COR`);

        return clients.map((c: Record<string, unknown>) => ({
          id: c.id as number,
          name: (c.name as string) || "",
          businessName: (c.business_name as string) ?? undefined,
          email: (c.email_contact as string) ?? undefined,
          nameContact: (c.name_contact as string) ?? undefined,
          lastNameContact: (c.last_name_contact as string) ?? undefined,
          phone: (c.phone as string) ?? undefined,
          website: (c.website as string) ?? undefined,
          description: (c.description as string) ?? undefined,
          condition: (c.condition as string) ?? undefined,
        }));
      } catch (error) {
        console.error(`[COR Provider] ❌ Error en listAllClients:`, error);
        return [];
      }
    },
  };
}
