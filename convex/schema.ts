// convex/schema.ts
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,

  // Workspaces - uno por usuario
  workspaces: defineTable({
    ownerId: v.id("users"),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  // Preferencias de usuario (theme, etc.)
  preferences: defineTable({
    userId: v.id("users"),
    theme: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    controlPanelView: v.optional(
      v.union(v.literal("cards"), v.literal("list")),
    ),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // Usuarios externos preaprobados para login por email + OTP.
  // Si el email existe en esta tabla, el usuario puede solicitar un código.
  approvedExternalUsers: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    createdAt: v.number(),
    addedBy: v.optional(v.id("users")),
  })
    .index("by_email", ["email"])
    .index("by_user", ["userId"]),

  // Registro de threads de chat del usuario (para diferenciar de threads de evaluación)
  // Esta tabla complementa la tabla threads del agent component para lógica de negocio
  chatThreads: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    title: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user_and_updated", ["userId", "updatedAt"]),

  // === Tasks: Estructura idéntica a COR para sincronización 1:1 ===
  // Campos principales = mismos campos que una task de COR:
  //   title       → título de la task
  //   description → toda la info del brief (tipo, marca, objetivo, kpis, etc.)
  //   deadline    → fecha límite
  //   priority    → numérico: 0=Low, 1=Medium, 2=High, 3=Urgent
  //   status      → estado de la task
  tasks: defineTable({
    // === Campos 1:1 con COR ===
    title: v.string(),
    description: v.optional(v.string()), // Contiene todos los datos del brief formateados
    deadline: v.optional(v.string()),
    priority: v.optional(v.number()), // 0=Low, 1=Medium, 2=High, 3=Urgent
    strategicPriority: v.optional(
      v.union(
        // Prioridad estratégica (label en COR)
        v.literal("I_U"),
        v.literal("I_NU"),
        v.literal("NI_U"),
        v.literal("NI_NU"),
      ),
    ),
    status: v.string(),
    convexStatus: v.optional(
      v.union(v.literal("active"), v.literal("deleted")),
    ),
    // === Campos internos (no van a COR) ===
    threadId: v.string(),
    createdBy: v.optional(v.string()),
    projectId: v.optional(v.id("projects")), // Referencia al proyecto LOCAL en Convex
    source: v.optional(v.union(v.literal("internal"), v.literal("external"))),
    clientId: v.optional(v.id("corClients")), // Referencia al cliente LOCAL
    clientBrandId: v.optional(v.id("clientBrands")),
    brandId: v.optional(v.number()), // Marca en COR (brand_id)
    brandName: v.optional(v.string()),
    // === Campos de sincronización con herramienta externa (COR, Trello, etc.) ===
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.optional(v.string()), // "pending" | "syncing" | "synced" | "retrying" | "error"
    corSyncError: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    corSyncAttempt: v.optional(v.number()), // Intento actual de sync (0-based)
    corTaskMissingInCOR: v.optional(v.boolean()),
    corProjectMissingInCOR: v.optional(v.boolean()),
    // === Campos para identificar el cliente en el sistema externo ===
    corClientId: v.optional(v.number()),
    corClientName: v.optional(v.string()),
    // === Campos para tracking de sincronización bidireccional ===
    corDescriptionHash: v.optional(v.string()),
    lastLocalEditAt: v.optional(v.number()),
    // === Sincronización con Trello (solo Convex; no se expone como custom fields) ===
    trelloCardId: v.optional(v.string()),
    trelloCardUrl: v.optional(v.string()),
    trelloSyncStatus: v.optional(v.string()), // "pending" | "syncing" | "synced" | "error"
    trelloSyncError: v.optional(v.string()),
    trelloSyncedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_status", ["status"])
    .index("by_createdBy", ["createdBy"])
    .index("by_projectId", ["projectId"])
    .index("by_source", ["source"])
    .index("by_clientId", ["clientId"])
    .index("by_clientId_source_status", ["clientId", "source", "status"])
    .index("by_createdBy_clientId_status", ["createdBy", "clientId", "status"])
    .index("by_strategicPriority", ["strategicPriority"])
    .index("by_clientBrandId", ["clientBrandId"])
    .index("by_createdBy_clientBrandId_status", [
      "createdBy",
      "clientBrandId",
      "status",
    ])
    .index("by_clientBrandId_source_status", [
      "clientBrandId",
      "source",
      "status",
    ])
    .index("by_corClientId", ["corClientId"])
    .index("by_corTaskId", ["corTaskId"])
    .index("by_corSyncStatus", ["corSyncStatus"])
    .index("by_trelloCardId", ["trelloCardId"])
    .index("by_trelloSyncStatus", ["trelloSyncStatus"]),

  // === Task Attachments: Archivos adjuntos de tasks ===
  // Estructura espejada con COR para sincronización directa.
  // Reemplaza el campo fileIds[] de tasks con una tabla dedicada.
  taskAttachments: defineTable({
    taskId: v.id("tasks"),
    // === Datos del archivo ===
    storageId: v.string(), // ID del blob en Convex storage (del agent component)
    fileId: v.string(), // ID del archivo en el agent component (para queries)
    filename: v.string(), // Nombre original del archivo
    mimeType: v.string(), // Tipo MIME (image/png, application/pdf, etc.)
    size: v.optional(v.number()), // Tamaño en bytes
    // === Sincronización con COR ===
    corAttachmentId: v.optional(v.number()), // ID del attachment en COR (null = no sincronizado)
    corUrl: v.optional(v.string()), // URL del archivo en COR
    // === Metadata ===
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_cor", ["taskId", "corAttachmentId"]),

  evaluationThreads: defineTable({
    taskId: v.id("tasks"),
    originalThreadId: v.string(),
    evaluationThreadId: v.string(),
    status: v.string(), // "pending" | "in_progress" | "completed"
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_evaluation_thread", ["evaluationThreadId"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

  taskEvaluations: defineTable({
    taskId: v.id("tasks"),
    evaluationThreadId: v.string(),
    agentEvaluationThreadId: v.optional(v.string()),
    originalThreadId: v.string(),
    requestedBy: v.optional(v.id("users")),
    requestedBySource: v.optional(v.string()), // "auth" | "message" | "taskCreatedBy" | "unknown"
    requestedAt: v.number(),
    completedAt: v.optional(v.number()),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    prompt: v.optional(v.string()),
    inputFileIds: v.array(v.string()),
    userMessageId: v.optional(v.string()),
    agentUserMessageId: v.optional(v.string()),
    resultMessageId: v.optional(v.string()),
    agentResultMessageId: v.optional(v.string()),
    resultText: v.optional(v.string()),
    resultProvider: v.optional(v.string()),
    error: v.optional(v.string()),
    clientId: v.optional(v.id("corClients")),
    clientBrandId: v.optional(v.id("clientBrands")),
    taskSource: v.optional(v.union(v.literal("internal"), v.literal("external"))),
    backfilled: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_thread", ["evaluationThreadId"])
    .index("by_agent_thread", ["agentEvaluationThreadId"])
    .index("by_requestedBy", ["requestedBy"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"])
    .index("by_task_and_createdAt", ["taskId", "createdAt"])
    .index("by_requestedBy_and_createdAt", ["requestedBy", "createdAt"])
    .index("by_clientId_and_createdAt", ["clientId", "createdAt"])
    .index("by_userMessageId", ["userMessageId"])
    .index("by_resultMessageId", ["resultMessageId"]),

  // Registro de errores de LLM para monitoreo y debugging
  llmErrors: defineTable({
    provider: v.string(), // "gemini" | "openai"
    model: v.string(), // "gemini-3.1-pro-preview" | "gpt-5.2"
    agentName: v.string(), // "briefAgent" | "reviewerAgent" | "evaluatorAgent"
    errorType: v.string(), // "rate_limit" | "high_demand" | "timeout" | "unknown"
    errorMessage: v.string(),
    threadId: v.optional(v.string()),
    timestamp: v.number(),
    resolved: v.boolean(), // Si se resolvió con fallback
    fallbackUsed: v.optional(v.string()), // El modelo fallback que se usó
  })
    .index("by_provider", ["provider"])
    .index("by_timestamp", ["timestamp"])
    .index("by_agent", ["agentName"]),

  // Configuración de LLM para testing de fallback
  // Permite desactivar proveedores manualmente para testing
  llmConfig: defineTable({
    provider: v.string(), // "gemini" | "openai"
    enabled: v.boolean(), // true = activo, false = simular caída
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  }).index("by_provider", ["provider"]),

  // =====================================================
  // RAG - Tablas para búsqueda en documentos
  // =====================================================

  // RAG Documents - Revistas y documentos indexados
  ragDocuments: defineTable({
    filename: v.string(),
    pageCount: v.number(),
    processedAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("error"),
    ),
    errorMessage: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_filename", ["filename"]),

  // RAG Pages - Páginas de documentos con embeddings
  ragPages: defineTable({
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
    text: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    imageEmbedding: v.optional(v.array(v.float64())),
    ragEntryId: v.optional(v.string()), // Referencia al RAG component
  })
    .index("by_document", ["documentId"])
    .index("by_document_page", ["documentId", "pageNumber"])
    .index("by_rag_entry", ["ragEntryId"])
    .vectorIndex("by_image_embedding", {
      vectorField: "imageEmbedding",
      dimensions: 1536,
      filterFields: ["documentId"],
    }),

  // RAG Entity Images - Imágenes de entidades (productos, personas, etc.) extraídas
  // Para búsqueda visual multimodal con Cohere embed-v-4-0
  entityImages: defineTable({
    documentId: v.id("ragDocuments"),
    pageNumber: v.number(),
    imageStorageId: v.id("_storage"),
    imageEmbedding: v.optional(v.array(v.float64())),
    // Información de la entidad (extraída o manual)
    entityName: v.optional(v.string()),
    entityCode: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.number()),
    // Metadatos
    createdAt: v.number(),
    ragEntryId: v.optional(v.string()),
  })
    .index("by_document", ["documentId"])
    .index("by_page", ["documentId", "pageNumber"])
    .index("by_entity_code", ["entityCode"])
    .vectorIndex("by_image_embedding", {
      vectorField: "imageEmbedding",
      dimensions: 1536,
      filterFields: ["documentId", "pageNumber"],
    }),

  // =====================================================
  // COR Users — Cache de usuarios resueltos en COR
  // =====================================================
  corUsers: defineTable({
    userId: v.id("users"), // Referencia al user de Convex (authTables)
    corUserId: v.number(), // ID del usuario en COR
    corFirstName: v.string(),
    corLastName: v.string(),
    corEmail: v.string(),
    corRoleId: v.optional(v.number()), // 1=C-Level, 2=Director, 3=PM, 4=Collaborator, 5=Freelancer, 6=Client
    corPositionName: v.optional(v.string()),
    resolvedAt: v.number(), // Timestamp de cuándo se resolvió por primera vez
    lastVerifiedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_corUserId", ["corUserId"]),

  // =====================================================
  // COR Clients — Clientes sincronizados desde COR
  // =====================================================
  corClients: defineTable({
    corClientId: v.number(),
    name: v.string(),
    nomenclature: v.optional(v.string()), // Abreviatura/iniciales del cliente (ej: "AD" para American Deli). Se usa como prefijo en nombres de proyectos.
    businessName: v.optional(v.string()),
    nameContact: v.optional(v.string()),
    lastNameContact: v.optional(v.string()),
    emailContact: v.optional(v.string()),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    phone: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_corClientId", ["corClientId"])
    .index("by_name", ["name"]),

  // =====================================================
  // Client Brands — Marcas de COR asociadas a un cliente
  // =====================================================
  clientBrands: defineTable({
    clientId: v.optional(v.id("corClients")), // Referencia al cliente local, si existe
    corClientId: v.number(), // ID del cliente en COR
    corBrandId: v.number(), // ID de la marca en COR
    name: v.string(),
    syncedAt: v.number(),
    trelloBoardId: v.optional(v.string()), // Se llenará en la integración Trello
    trelloBoardUrl: v.optional(v.string()),
  })
    .index("by_client", ["clientId"])
    .index("by_corClientId", ["corClientId"])
    .index("by_corBrandId", ["corBrandId"])
    .index("by_corClientId_and_corBrandId", ["corClientId", "corBrandId"]),

  // =====================================================
  // Sub Brands — Productos de COR asociados a una marca
  // =====================================================
  subBrands: defineTable({
    clientBrandId: v.id("clientBrands"), // Marca local que hereda permisos
    clientId: v.optional(v.id("corClients")), // Cliente local, si existe
    corClientId: v.number(), // ID del cliente en COR
    corBrandId: v.number(), // ID de la marca en COR
    corProductId: v.number(), // ID del producto en COR
    name: v.string(),
    syncedAt: v.number(),
  })
    .index("by_brand", ["clientBrandId"])
    .index("by_corProductId", ["corProductId"])
    .index("by_corBrandId", ["corBrandId"])
    .index("by_corBrandId_and_corProductId", ["corBrandId", "corProductId"]),

  // =====================================================
  // Client-User Assignments — Qué usuarios pueden usar qué clientes
  // =====================================================
  clientUserAssignments: defineTable({
    clientId: v.id("corClients"), // Referencia al cliente local
    userId: v.id("users"), // Referencia al usuario local
    brandId: v.optional(v.id("clientBrands")), // undefined = acceso a todo el cliente
    assignedAt: v.number(),
    assignedBy: v.optional(v.id("users")), // Quién lo asignó (admin/PM)
  })
    .index("by_client", ["clientId"])
    .index("by_user", ["userId"])
    .index("by_brand", ["brandId"])
    .index("by_client_and_user", ["clientId", "userId"])
    .index("by_client_user_brand", ["clientId", "userId", "brandId"])
    .index("by_user_and_brand", ["userId", "brandId"]),

  // =====================================================
  // Projects — Proyectos locales (Client → Project → Task)
  // =====================================================
  projects: defineTable({
    // === Campos 1:1 con COR ===
    name: v.string(),
    brief: v.optional(v.string()),
    startDate: v.optional(v.string()), // YYYY-MM-DD
    endDate: v.optional(v.string()), // YYYY-MM-DD (deadline)
    status: v.string(), // "active" | "in_process" | "suspended" | "finished"
    convexStatus: v.optional(
      v.union(v.literal("active"), v.literal("deleted")),
    ),
    estimatedTime: v.optional(v.number()), // Horas estimadas
    billable: v.optional(v.boolean()),
    incomeType: v.optional(v.string()), // "fee" | "one_time" | "hourly_rate" | "contract"
    deliverables: v.optional(v.number()), // Cantidad de entregables
    pmId: v.optional(v.number()), // PM en COR (opcional)
    brandId: v.optional(v.number()), // Marca en COR (opcional)
    productId: v.optional(v.number()), // Producto en COR (opcional)
    // === Campos internos (no van a COR) ===
    clientId: v.optional(v.id("corClients")), // Referencia al cliente LOCAL
    createdBy: v.optional(v.string()), // Id<"users"> como string
    threadId: v.optional(v.string()), // Thread que originó este proyecto
    source: v.optional(v.union(v.literal("internal"), v.literal("external"))),
    clientBrandId: v.optional(v.id("clientBrands")),
    brandName: v.optional(v.string()),
    // === Campos de sincronización con COR ===
    corProjectId: v.optional(v.number()),
    corClientId: v.optional(v.number()), // Denormalized para fast publish
    corSyncStatus: v.optional(v.string()), // "pending" | "syncing" | "synced" | "retrying" | "error"
    corSyncError: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    corSyncAttempt: v.optional(v.number()), // Intento actual de sync (0-based)
    corMissingInCOR: v.optional(v.boolean()),
    // === Sincronización con Trello (misma card que la task) ===
    trelloCardId: v.optional(v.string()),
    trelloCardUrl: v.optional(v.string()),
    trelloSyncStatus: v.optional(v.string()),
    trelloSyncError: v.optional(v.string()),
    trelloSyncedAt: v.optional(v.number()),
  })
    .index("by_clientId", ["clientId"])
    .index("by_status", ["status"])
    .index("by_source", ["source"])
    .index("by_clientBrandId", ["clientBrandId"])
    .index("by_corClientId", ["corClientId"])
    .index("by_corProjectId", ["corProjectId"])
    .index("by_createdBy", ["createdBy"])
    .index("by_threadId", ["threadId"])
    .index("by_corSyncStatus", ["corSyncStatus"])
    .index("by_trelloCardId", ["trelloCardId"])
    .index("by_trelloSyncStatus", ["trelloSyncStatus"]),

  // =====================================================
  // Trello Board Lists — Mapeo estable status Convex/COR → List ID de Trello
  // =====================================================
  trelloBoardLists: defineTable({
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    status: v.string(), // value interno: nueva, en_proceso, etc.
    name: v.string(), // label visible esperado en Trello
    trelloListId: v.string(),
    syncedAt: v.number(),
  })
    .index("by_brand", ["clientBrandId"])
    .index("by_board", ["trelloBoardId"])
    .index("by_brand_and_status", ["clientBrandId", "status"])
    .index("by_list", ["trelloListId"]),

  // =====================================================
  // Trello Custom Fields — IDs cacheados por board
  // =====================================================
  trelloBoardCustomFields: defineTable({
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    fieldKey: v.string(), // requestType, brand, priority, deliverablesCount
    name: v.string(),
    type: v.string(), // text, number, list, date, checkbox
    trelloCustomFieldId: v.string(),
    syncedAt: v.number(),
  })
    .index("by_brand", ["clientBrandId"])
    .index("by_board", ["trelloBoardId"])
    .index("by_brand_and_key", ["clientBrandId", "fieldKey"])
    .index("by_customField", ["trelloCustomFieldId"]),

  // =====================================================
  // Trello Cards — Mapping idempotente Convex task/project → Trello card
  // =====================================================
  trelloCards: defineTable({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    clientBrandId: v.id("clientBrands"),
    trelloBoardId: v.string(),
    trelloListId: v.optional(v.string()),
    trelloCardId: v.optional(v.string()),
    trelloCardUrl: v.optional(v.string()),
    syncStatus: v.string(), // "pending" | "syncing" | "synced" | "error"
    syncError: v.optional(v.string()),
    createdAt: v.number(),
    syncedAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_project", ["projectId"])
    .index("by_brand", ["clientBrandId"])
    .index("by_card", ["trelloCardId"])
    .index("by_syncStatus", ["syncStatus"]),
});
