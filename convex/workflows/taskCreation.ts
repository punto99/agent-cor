// convex/workflows/taskCreation.ts
// Creación de tasks con sincronización a COR
import { v } from "convex/values";
import { workflow } from "./index";
import { internal } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";

// Tipo de resultado del proceso de creación
export type CreateTaskWorkflowResult = {
  taskId: string;
  corTaskId?: number;
  status: "created" | "already_exists" | "created_without_cor";
  corSyncStatus: "synced" | "error" | "skipped";
  error?: string;
};

/**
 * Workflow de creación de task con sincronización a COR
 * 
 * Beneficios:
 * - IDEMPOTENCIA: Verifica si la task ya existe antes de crear
 * - DURABILIDAD: Si falla a mitad, continúa donde se quedó
 * - REINTENTOS: Configurables por step, especialmente para COR API
 * - TRAZABILIDAD: Puedes ver el estado del workflow en el dashboard
 * 
 * Flujo:
 * 1. Verificar si ya existe task para el thread (idempotencia)
 * 2. Crear task en la base de datos local
 * 3. Asociar archivos del thread a la task
 * 4. Crear task en COR (con reintentos)
 * 5. Actualizar task local con ID de COR
 */
export const createTaskWorkflow = workflow.define({
  args: {
    threadId: v.string(),
    taskData: v.object({
      title: v.string(),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priority: v.optional(v.number()),     // 0=Low, 1=Medium, 2=High, 3=Urgent
    }),
    userId: v.optional(v.string()),
    corProjectId: v.optional(v.number()), // ID del proyecto en COR (opcional)
  },
  handler: async (ctx, args): Promise<{
    taskId: string;
    corTaskId?: number;
    status: "created" | "already_exists" | "created_without_cor";
    corSyncStatus: "synced" | "error" | "skipped";
    error?: string;
  }> => {
    console.log("\n========================================");
    console.log("[Workflow] 🚀 INICIANDO WORKFLOW DE CREACIÓN DE TASK");
    console.log(`[Workflow] ThreadId: ${args.threadId}`);
    console.log(`[Workflow] Título: ${args.taskData.title}`);
    console.log("========================================\n");

    // ==================== STEP 1: VERIFICAR IDEMPOTENCIA ====================
    console.log("[Workflow] 📍 STEP 1: Verificando si ya existe task...");
    
    const existingTask = await ctx.runQuery(
      internal.data.tasks.getTaskByThreadInternal,
      { threadId: args.threadId }
    );

    if (existingTask) {
      console.log(`[Workflow] ⚠️ Task ya existe: ${existingTask._id}`);
      return {
        taskId: existingTask._id,
        corTaskId: existingTask.corTaskId ? parseInt(existingTask.corTaskId) : undefined,
        status: "already_exists",
        corSyncStatus: existingTask.corSyncStatus === "synced" ? "synced" : "skipped",
      };
    }

    console.log("[Workflow] ✅ No existe task previa, procediendo a crear...");

    // ==================== STEP 2: CREAR TASK LOCAL ====================
    console.log("[Workflow] 📍 STEP 2: Creando task en base de datos local...");
    
    const taskId = await ctx.runMutation(
      internal.data.tasks.createTaskInternal,
      {
        ...args.taskData,
        threadId: args.threadId,
        status: "nueva",
        fileIds: undefined,
        createdBy: args.userId,
        // Campos COR - inicialmente pendiente
        corSyncStatus: "pending",
        corProjectId: args.corProjectId,
      }
    );

    console.log(`[Workflow] ✅ Task creada localmente: ${taskId}`);

    // ==================== STEP 3: CREAR TASK EN COR ====================
    console.log("[Workflow] 📍 STEP 3: Sincronizando con COR...");
    
    let corTaskId: number | undefined;
    let corSyncStatus: "synced" | "error" = "error";
    let corError: string | undefined;

    try {
      // Crear task en el sistema externo via provider
      const provider = getProjectManagementProvider();
      const externalTask = await provider.createTask({
        projectId: args.corProjectId || 0,
        title: args.taskData.title,
        description: args.taskData.description,
        deadline: args.taskData.deadline,
        priority: args.taskData.priority,
      });

      corTaskId = externalTask.id;
      corSyncStatus = "synced";
      console.log(`[Workflow] ✅ Task sincronizada con COR: ${corTaskId}`);
    } catch (error) {
      // Si COR falla, registrar el error pero no fallar el workflow completo
      // La task ya existe localmente y puede sincronizarse después
      corError = error instanceof Error ? error.message : String(error);
      console.error("[Workflow] ❌ Error sincronizando con COR:", corError);
      console.log("[Workflow] ⚠️ La task fue creada localmente, se reintentará la sincronización");
    }

    // ==================== STEP 4: ACTUALIZAR TASK CON RESULTADO COR ====================
    console.log("[Workflow] 📍 STEP 4: Actualizando task con resultado de COR...");
    
    await ctx.runMutation(
      internal.data.tasks.updateCORSyncStatus,
      {
        taskId,
        corTaskId,
        syncStatus: corSyncStatus,
        syncError: corError,
      }
    );

    // Si se sincronizó exitosamente, guardar timestamp
    if (corSyncStatus === "synced") {
      await ctx.runMutation(
        internal.workflows.taskCreation.updateCORSyncTimestamp,
        { taskId }
      );
    }

    // ==================== STEP 5: ASOCIAR ARCHIVOS Y ENVIAR A COR ====================
    // Hacemos esto DESPUÉS de crear la task en COR para poder enviar los attachments
    console.log("[Workflow] 📍 STEP 5: Asociando archivos y enviándolos a COR...");
    
    try {
      await ctx.runAction(
        internal.data.tasks.associateFilesToTask,
        { 
          taskId, 
          threadId: args.threadId,
          corTaskId, // Pasamos el COR ID para enviar los archivos a COR
        }
      );
      console.log("[Workflow] ✅ Archivos asociados");
    } catch (error) {
      // No fallar el workflow si no hay archivos o falla la asociación
      console.log("[Workflow] ⚠️ No se pudieron asociar archivos (continuando):", error);
    }

    console.log("\n========================================");
    console.log("[Workflow] 🏁 WORKFLOW COMPLETADO");
    console.log(`[Workflow] Task ID: ${taskId}`);
    console.log(`[Workflow] COR Task ID: ${corTaskId || "N/A"}`);
    console.log(`[Workflow] COR Sync: ${corSyncStatus}`);
    console.log("========================================\n");

    return {
      taskId,
      corTaskId,
      status: corSyncStatus === "synced" ? "created" : "created_without_cor",
      corSyncStatus,
      error: corError,
    };
  },
});

// ==================== HELPER MUTATIONS ====================

import { internalMutation } from "../_generated/server";

/**
 * Actualiza el timestamp de sincronización con COR
 */
export const updateCORSyncTimestamp = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId as any, {
      corSyncedAt: Date.now(),
    });
  },
});

/**
 * Crea una task y la sincroniza con COR de forma síncrona.
 * 
 * IMPORTANTE: Esta función es una internalAction que:
 * 1. Verifica idempotencia
 * 2. Crea la task local
 * 3. Sincroniza con COR (con reintentos manejados por el workpool del workflow)
 * 4. Devuelve el resultado INMEDIATAMENTE al usuario
 * 
 * Usamos internalAction en lugar del workflow completo porque:
 * - El usuario necesita el COR ID de inmediato
 * - La operación es relativamente corta (no necesita durabilidad de días)
 * - El workflow es más útil para procesos largos o que pueden pausarse
 */
import { internalAction } from "../_generated/server";

export const createTaskAndSyncWithCOR = internalAction({
  args: {
    threadId: v.string(),
    taskData: v.object({
      title: v.string(),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priority: v.optional(v.number()),     // 0=Low, 1=Medium, 2=High, 3=Urgent
    }),
    userId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CreateTaskWorkflowResult> => {
    console.log("\n========================================");
    console.log("[CreateTask] 🚀 CREANDO TASK CON SINCRONIZACIÓN COR");
    console.log(`[CreateTask] ThreadId: ${args.threadId}`);
    console.log(`[CreateTask] Título: ${args.taskData.title}`);
    console.log("========================================\n");

    // STEP 1: VERIFICAR IDEMPOTENCIA
    console.log("[CreateTask] 📍 STEP 1: Verificando si ya existe task...");
    
    const existingTask = await ctx.runQuery(
      internal.data.tasks.getTaskByThreadInternal,
      { threadId: args.threadId }
    );

    if (existingTask) {
      console.log(`[CreateTask] ⚠️ Task ya existe: ${existingTask._id}`);
      return {
        taskId: existingTask._id,
        corTaskId: existingTask.corTaskId ? parseInt(existingTask.corTaskId) : undefined,
        status: "already_exists",
        corSyncStatus: existingTask.corSyncStatus === "synced" ? "synced" : "skipped",
      };
    }

    console.log("[CreateTask] ✅ No existe task previa, procediendo a crear...");

    // STEP 2: CREAR TASK LOCAL
    console.log("[CreateTask] 📍 STEP 2: Creando task en base de datos local...");
    
    const taskId = await ctx.runMutation(
      internal.data.tasks.createTaskInternal,
      {
        ...args.taskData,
        threadId: args.threadId,
        status: "nueva",
        fileIds: undefined,
        createdBy: args.userId,
        corSyncStatus: "pending",
        corProjectId: args.corProjectId,
      }
    );

    console.log(`[CreateTask] ✅ Task creada localmente: ${taskId}`);

    // STEP 3: CREAR TASK EN COR (primero, antes de asociar archivos)
    console.log("[CreateTask] 📍 STEP 3: Sincronizando con COR...");
    
    let corTaskId: number | undefined;
    let corSyncStatus: "synced" | "error" = "error";
    let corError: string | undefined;

    try {
      const provider = getProjectManagementProvider();
      const externalTask = await provider.createTask({
        projectId: args.corProjectId || 0,
        title: args.taskData.title,
        description: args.taskData.description,
        deadline: args.taskData.deadline,
        priority: args.taskData.priority,
      });

      corTaskId = externalTask.id;
      corSyncStatus = "synced";
      console.log(`[CreateTask] ✅ Task sincronizada con COR: ${corTaskId}`);
    } catch (error) {
      corError = error instanceof Error ? error.message : String(error);
      console.error("[CreateTask] ❌ Error sincronizando con COR:", corError);
    }

    // STEP 4: ACTUALIZAR TASK CON RESULTADO COR
    console.log("[CreateTask] 📍 STEP 4: Actualizando task con resultado de COR...");
    
    await ctx.runMutation(
      internal.data.tasks.updateCORSyncStatus,
      {
        taskId,
        corTaskId,
        syncStatus: corSyncStatus,
        syncError: corError,
      }
    );

    if (corSyncStatus === "synced") {
      await ctx.runMutation(
        internal.workflows.taskCreation.updateCORSyncTimestamp,
        { taskId }
      );
    }

    // STEP 5: ASOCIAR ARCHIVOS Y ENVIARLOS A COR
    // Hacemos esto DESPUÉS de crear la task en COR para poder enviar los attachments
    console.log("[CreateTask] 📍 STEP 5: Asociando archivos y enviándolos a COR...");
    
    try {
      await ctx.runAction(
        internal.data.tasks.associateFilesToTask,
        { 
          taskId, 
          threadId: args.threadId,
          corTaskId, // Pasamos el COR ID para enviar los archivos a COR
        }
      );
      console.log("[CreateTask] ✅ Archivos asociados");
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudieron asociar archivos (continuando):", error);
    }

    console.log("\n========================================");
    console.log("[CreateTask] 🏁 PROCESO COMPLETADO");
    console.log(`[CreateTask] Task ID: ${taskId}`);
    console.log(`[CreateTask] COR Task ID: ${corTaskId || "N/A"}`);
    console.log(`[CreateTask] COR Sync: ${corSyncStatus}`);
    console.log("========================================\n");

    return {
      taskId,
      corTaskId,
      status: corSyncStatus === "synced" ? "created" : "created_without_cor",
      corSyncStatus,
      error: corError,
    };
  },
});
