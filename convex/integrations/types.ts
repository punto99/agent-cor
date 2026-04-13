// convex/integrations/types.ts
// =====================================================
// Tipos e interfaces compartidas para el sistema de integraciones externas.
// Cada provider de gestión de proyectos (COR, Trello, etc.) debe implementar
// la interface ProjectManagementProvider.
// =====================================================

// ==================== TIPOS DE DATOS EXTERNOS ====================

/** Usuario tal como existe en el sistema externo */
export interface ExternalUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  roleId?: number;
  positionName?: string;
}

/** Cliente/Marca tal como existe en el sistema externo */
export interface ExternalClient {
  id: number;
  name: string;
  businessName?: string;
  email?: string;
  // Campos adicionales (para sync completo)
  nameContact?: string;
  lastNameContact?: string;
  phone?: string;
  website?: string;
  description?: string;
  condition?: string;
}

/** Proyecto tal como existe en el sistema externo */
export interface ExternalProject {
  id: number;
  name: string;
  clientId: number;
  // Campos de lectura (opcionales — presentes al hacer GET, no necesarios al crear)
  brief?: string;
  startDate?: string;
  endDate?: string;
  deliverables?: string;
  status?: string;
  estimatedTime?: number;
}

/** Task tal como existe en el sistema externo */
export interface ExternalTask {
  id: number;
  title: string;
  projectId: number;
  description?: string;
  deadline?: string;
  status?: string;
  priority?: number;
}

// ==================== INPUTS ====================

export interface CreateProjectInput {
  /** Nombre del proyecto */
  name: string;
  /** ID del cliente en el sistema externo */
  clientId: number;
  /** Descripción o brief del proyecto */
  description?: string;
  /** Fecha límite del proyecto (ISO 8601) */
  deadline?: string;
  /** ID del fee/tarifa del cliente (requerido por COR, se auto-resuelve si no se pasa) */
  feeId?: number;
}

export interface CreateTaskInput {
  /** ID del proyecto en el sistema externo donde crear la task */
  projectId: number;
  /** Título de la task */
  title: string;
  /** Descripción de la task (puede incluir el brief completo) */
  description?: string;
  /** Fecha límite (ISO 8601) */
  deadline?: string;
  /** Prioridad: 0=Low, 1=Medium, 2=High, 3=Urgent (o texto: "baja"|"media"|"alta"|"urgente") */
  priority?: string | number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  deadline?: string;
  priority?: string | number;
  status?: string;
}

export interface UpdateProjectInput {
  name?: string;
  brief?: string;
  startDate?: string;
  endDate?: string;
  deliverables?: string;
  estimatedTime?: number;
}

export interface UploadTaskAttachmentInput {
  /** ID de la task en el sistema externo */
  taskId: number;
  /** Contenido binario del archivo */
  fileBuffer: ArrayBuffer;
  /** Nombre original del archivo */
  filename: string;
  /** Tipo MIME del archivo */
  mimeType: string;
}

/** Resultado de un attachment subido exitosamente al sistema externo */
export interface ExternalAttachmentResult {
  id: number;
  url: string;
  name: string;
  size: number;
}

// ==================== INTERFACE PRINCIPAL ====================

/**
 * Interface que todo provider de gestión de proyectos debe implementar.
 * 
 * Providers disponibles:
 * - COR (ProjectCOR): Para clientes que usan COR como herramienta de gestión
 * - Noop: Provider vacío para clientes sin integración externa
 * - Trello: (futuro) Para clientes que usan Trello
 * 
 * Los providers son funciones puras (no Convex primitives) que se invocan
 * desde dentro de Convex actions.
 */
export interface ProjectManagementProvider {
  /** Nombre identificador del provider (ej: "cor", "trello", "noop") */
  name: string;

  /**
   * Buscar usuarios por nombre en el sistema externo.
   * Retorna un array de usuarios que coinciden con el nombre.
   */
  searchUsersByName(name: string): Promise<ExternalUser[]>;

  /**
   * Buscar un cliente/marca por nombre en el sistema externo.
   * Retorna el primer resultado más relevante, o null si no se encuentra.
   */
  searchClient(name: string): Promise<ExternalClient | null>;

  /**
   * Crear un proyecto en el sistema externo.
   * En COR: POST /projects
   * El proyecto agrupa tasks y está asociado a un cliente.
   */
  createProject(data: CreateProjectInput): Promise<ExternalProject>;

  /**
   * Crear una task dentro de un proyecto en el sistema externo.
   * En COR: POST /tasks con project_id
   */
  createTask(data: CreateTaskInput): Promise<ExternalTask>;

  /**
   * Obtener los datos de una task desde el sistema externo.
   * Retorna null si no se encuentra.
   */
  getTask(taskId: number): Promise<ExternalTask | null>;

  /**
   * Obtener los datos de un proyecto desde el sistema externo.
   * Retorna null si no se encuentra.
   */
  getProject(projectId: number): Promise<ExternalProject | null>;

  /**
   * Actualizar una task existente en el sistema externo.
   * Hace merge seguro: primero obtiene el estado actual y solo
   * sobrescribe los campos proporcionados.
   */
  updateTask(
    taskId: number,
    data: UpdateTaskInput
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Actualizar un proyecto existente en el sistema externo.
   * Hace merge seguro: primero obtiene el estado actual y solo
   * sobrescribe los campos proporcionados.
   */
  updateProject(
    projectId: number,
    data: UpdateProjectInput
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Subir un archivo como attachment de una task.
   * En COR: POST /tasks/{task_id}/attachments (multipart/form-data)
   */
  uploadTaskAttachment(
    data: UploadTaskAttachmentInput
  ): Promise<{ success: boolean; attachment?: ExternalAttachmentResult; error?: string }>;

  /**
   * Listar TODOS los usuarios del sistema externo.
   * En COR: GET /users?page=false (desactiva paginación)
   * Usado para backfill masivo de corUsers.
   */
  listAllUsers(): Promise<ExternalUser[]>;

  /**
   * Listar TODOS los clientes del sistema externo.
   * En COR: GET /clients?page=false (desactiva paginación)
   * Usado para backfill masivo de corClients.
   */
  listAllClients(): Promise<ExternalClient[]>;
}

// ==================== TIPO DE CONFIGURACIÓN ====================

export interface IntegrationConfig {
  projectManagement: {
    /** Si la integración con herramientas externas está habilitada */
    enabled: boolean;
    /** Provider activo: "cor" | "trello" | "noop" */
    provider: "cor" | "trello" | "noop";
  };
}
