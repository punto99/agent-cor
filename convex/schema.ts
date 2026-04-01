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
  })
    .index("by_owner", ["ownerId"]),

  // Preferencias de usuario (theme, etc.)
  preferences: defineTable({
    userId: v.id("users"),
    theme: v.optional(v.union(v.literal("light"), v.literal("dark"), v.literal("system"))),
    updatedAt: v.number(),
  })
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
    description: v.optional(v.string()),     // Contiene todos los datos del brief formateados
    deadline: v.optional(v.string()),
    priority: v.optional(v.number()),         // 0=Low, 1=Medium, 2=High, 3=Urgent
    status: v.string(),
    // === Campos internos (no van a COR) ===
    threadId: v.string(),
    fileIds: v.optional(v.array(v.string())),
    createdBy: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),   // Referencia al proyecto LOCAL en Convex
    // === Campos de sincronización con herramienta externa (COR, Trello, etc.) ===
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.optional(v.string()),    // "pending" | "syncing" | "synced" | "error"
    corSyncError: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    // === Campos para identificar el cliente en el sistema externo ===
    corClientId: v.optional(v.number()),
    corClientName: v.optional(v.string()),
    // === Campos para tracking de sincronización bidireccional ===
    corDescriptionHash: v.optional(v.string()),
    lastLocalEditAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_status", ["status"])
    .index("by_createdBy", ["createdBy"])
    .index("by_corTaskId", ["corTaskId"])
    .index("by_corSyncStatus", ["corSyncStatus"]),

  evaluationThreads: defineTable({
    taskId: v.id("tasks"),
    originalThreadId: v.string(),
    evaluationThreadId: v.string(),
    status: v.string(), // "pending" | "in_progress" | "completed"
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_evaluation_thread", ["evaluationThreadId"]),

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
  })
    .index("by_provider", ["provider"]),

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
      v.literal("error")
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
    userId: v.id("users"),              // Referencia al user de Convex (authTables)
    corUserId: v.number(),              // ID del usuario en COR
    corFirstName: v.string(),
    corLastName: v.string(),
    corEmail: v.string(),
    corRoleId: v.optional(v.number()),  // 1=C-Level, 2=Director, 3=PM, 4=Collaborator, 5=Freelancer, 6=Client
    corPositionName: v.optional(v.string()),
    resolvedAt: v.number(),             // Timestamp de cuándo se resolvió por primera vez
    lastVerifiedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_corUserId", ["corUserId"]),

  // =====================================================
  // COR Clients — Clientes sincronizados desde COR
  // =====================================================
  corClients: defineTable({
    corClientId: v.number(),                // ID del cliente en COR
    name: v.string(),                       // Nombre del cliente
    businessName: v.optional(v.string()),
    nameContact: v.optional(v.string()),
    lastNameContact: v.optional(v.string()),
    emailContact: v.optional(v.string()),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    phone: v.optional(v.string()),
    syncedAt: v.number(),                   // Última sincronización con COR
  })
    .index("by_corClientId", ["corClientId"])
    .index("by_name", ["name"]),

  // =====================================================
  // Client-User Assignments — Qué usuarios pueden usar qué clientes
  // =====================================================
  clientUserAssignments: defineTable({
    clientId: v.id("corClients"),           // Referencia al cliente local
    userId: v.id("users"),                  // Referencia al usuario local
    assignedAt: v.number(),
    assignedBy: v.optional(v.id("users")),  // Quién lo asignó (admin/PM)
  })
    .index("by_client", ["clientId"])
    .index("by_user", ["userId"])
    .index("by_client_and_user", ["clientId", "userId"]),

  // =====================================================
  // Projects — Proyectos locales (Client → Project → Task)
  // =====================================================
  projects: defineTable({
    // === Campos 1:1 con COR ===
    name: v.string(),
    brief: v.optional(v.string()),
    startDate: v.optional(v.string()),         // YYYY-MM-DD
    endDate: v.optional(v.string()),           // YYYY-MM-DD (deadline)
    status: v.string(),                        // "active" | "finished" | "suspended"
    estimatedTime: v.optional(v.number()),     // Horas estimadas
    billable: v.optional(v.boolean()),
    incomeType: v.optional(v.string()),        // "fee" | "one_time" | "hourly_rate" | "contract"
    deliverables: v.optional(v.string()),
    pmId: v.optional(v.number()),              // PM en COR (opcional)
    brandId: v.optional(v.number()),           // Marca en COR (opcional)
    productId: v.optional(v.number()),         // Producto en COR (opcional)
    // === Campos internos (no van a COR) ===
    clientId: v.optional(v.id("corClients")),  // Referencia al cliente LOCAL
    createdBy: v.optional(v.string()),         // Id<"users"> como string
    threadId: v.optional(v.string()),          // Thread que originó este proyecto
    // === Campos de sincronización con COR ===
    corProjectId: v.optional(v.number()),
    corClientId: v.optional(v.number()),       // Denormalized para fast publish
    corSyncStatus: v.optional(v.string()),     // "pending" | "syncing" | "synced" | "error"
    corSyncError: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
  })
    .index("by_clientId", ["clientId"])
    .index("by_corProjectId", ["corProjectId"])
    .index("by_createdBy", ["createdBy"])
    .index("by_threadId", ["threadId"])
    .index("by_corSyncStatus", ["corSyncStatus"]),
});
