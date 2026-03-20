// convex/tasks.ts
// Funciones para manejar tasks/requerimientos
import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "../_generated/server";
import { createTool, createThread, saveMessage, listMessages } from "@convex-dev/agent";
import { z } from "zod";
import { internal, components } from "../_generated/api";
import { reviewerAgent } from "../agents/reviewerAgent";
import { getProjectManagementProvider, isProjectManagementEnabled } from "../integrations/registry";
import { getAuthUserId } from "@convex-dev/auth/server";

// ==================== TOOL PARA OBTENER FECHA ACTUAL ====================

// Tool que devuelve la fecha y hora actual
export const nowTool = createTool({
  description: `Obtener la fecha y hora actual. Usar esta herramienta cuando necesites saber que dia es hoy, 
  por ejemplo para calcular deadlines, verificar timings, o dar contexto temporal al usuario.`,
  args: z.object({}),
  handler: async (): Promise<string> => {
    const now = new Date();
    
    // Formato legible en español
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Guayaquil', // Ecuador timezone
    };
    
    const fechaLegible = now.toLocaleDateString('es-EC', options);
    const fechaISO = now.toISOString();
    
    console.log(`[NowTool] Fecha actual: ${fechaLegible}`);
    
    return `Fecha y hora actual: ${fechaLegible} (${fechaISO})`;
  },
});

// ==================== ACTION INTERNA PARA GENERAR RESPUESTA DEL REVIEWER ====================

// Esta action es llamada desde el tool para generar la respuesta del supervisor
export const generateReviewerResponse = reviewerAgent.asTextAction({});

// ==================== TOOL PARA REVISAR BRIEF (SUPERVISOR) ====================

// Tool que el briefAgent usa para validar si la información recolectada es suficiente
// OPTIMIZADO: Validación rápida en línea sin llamar a otro agente
export const reviewBriefTool = createTool({
  description: `Validar rapidamente si la informacion recolectada es suficiente para crear el brief.
  Usar esta herramienta ANTES de mostrar el resumen final al usuario.
  Verifica que los campos obligatorios esten completos.`,
  args: z.object({
    requestType: z.string().describe("Tipo de requerimiento recolectado"),
    brand: z.string().describe("Marca o empresa recolectada"),
    objective: z.string().optional().describe("Objetivo del proyecto (si se proporciono)"),
    keyMessage: z.string().optional().describe("Mensaje clave (si se proporciono)"),
    kpis: z.string().optional().describe("KPIs (si se proporcionaron)"),
    deadline: z.string().optional().describe("Timing o fecha limite (si se proporciono)"),
    budget: z.string().optional().describe("Presupuesto (si se proporciono)"),
    approvers: z.string().optional().describe("Aprobadores (si se proporcionaron)"),
    hasFiles: z.boolean().optional().describe("Si el usuario adjunto archivos"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("[ReviewTool] Validando brief (modo rapido)...");
    
    // OPTIMIZACIÓN: Validación simple en línea sin llamar a otro agente
    const observaciones: string[] = [];
    const sugerencias: string[] = [];
    let confianza = 100;
    
    // Verificar campos obligatorios
    const camposObligatoriosCompletos = !!(args.requestType && args.brand);
    
    if (!camposObligatoriosCompletos) {
      observaciones.push("Faltan campos obligatorios");
      if (!args.requestType) sugerencias.push("Falta el tipo de requerimiento");
      if (!args.brand) sugerencias.push("Falta la marca");
      confianza = 0;
    } else {
      observaciones.push("Campos obligatorios completos");
    }
    
    // Evaluar calidad de la información
    let camposOpcionales = 0;
    if (args.objective) camposOpcionales++;
    if (args.keyMessage) camposOpcionales++;
    if (args.kpis) camposOpcionales++;
    if (args.deadline) camposOpcionales++;
    if (args.budget) camposOpcionales++;
    if (args.approvers) camposOpcionales++;
    if (args.hasFiles) camposOpcionales++;
    
    if (camposOpcionales >= 4) {
      observaciones.push("Informacion muy completa");
      confianza = Math.min(confianza, 95);
    } else if (camposOpcionales >= 2) {
      observaciones.push("Informacion adecuada");
      confianza = Math.min(confianza, 85);
    } else if (camposObligatoriosCompletos) {
      observaciones.push("Informacion basica, podria mejorarse");
      sugerencias.push("Considera solicitar mas detalles como objetivo, timing o presupuesto");
      confianza = Math.min(confianza, 70);
    }
    
    const resultado = {
      aprobado: camposObligatoriosCompletos,
      campos_obligatorios_completos: camposObligatoriosCompletos,
      observaciones,
      sugerencias,
      confianza,
    };
    
    console.log("[ReviewTool] ✅ Validacion completada:", JSON.stringify(resultado));
    
    return `EVALUACION DEL SUPERVISOR:\n\n${JSON.stringify(resultado, null, 2)}`;
  },
});

// ==================== TOOL PARA CONSULTAR TASK EN COR ====================

// Tool que el agente puede usar para consultar una task directamente desde COR
export const getTaskFromCORTool = createTool({
  description: `Consultar los detalles de una task directamente desde el sistema COR.
  Usar esta herramienta cuando:
  - El usuario quiere ver los detalles de una task usando su COR ID
  - El usuario quiere verificar el estado actual de una task en COR
  - Antes de editar una task, para ver su contenido actual
  
  Recibe el ID numerico de la task en COR (ej: 11301144).`,
  args: z.object({
    corTaskId: z.string().describe("ID de la task en COR (ej: 11301144)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log(`[GetTaskFromCOR] 🔍 Consultando task COR ID: ${args.corTaskId}`);
    
    try {
      const result = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
        corTaskId: parseInt(args.corTaskId),
      });
      
      if (!result.success || !result.task) {
        console.log(`[GetTaskFromCOR] ❌ Task no encontrada: ${result.error}`);
        return `No se encontró ninguna task con el COR ID: ${args.corTaskId}

Posibles causas:
- El ID no existe o fue eliminado
- No tienes permisos para ver esta task
- Error de conexión con COR

Por favor verifica el ID e intenta de nuevo.`;
      }
      
      const task = result.task;
      console.log(`[GetTaskFromCOR] ✅ Task encontrada:`, task.title);
      
      // Mapear prioridad a texto legible
      const prioridadTexto = ["Baja", "Media", "Alta", "Urgente"][task.priority] || "Media";
      
      // Formatear fecha si existe
      let deadlineTexto = "Sin fecha límite";
      if (task.deadline) {
        const fecha = new Date(task.deadline);
        deadlineTexto = fecha.toLocaleDateString('es-ES', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      }
      
      return `📋 **Task en COR (ID: ${task.id})**

**Título:** ${task.title}
**Descripción:** ${task.description || "Sin descripción"}
**Estado:** ${task.status}
**Prioridad:** ${prioridadTexto}
**Deadline:** ${deadlineTexto}
**Proyecto ID:** ${task.project_id}
**Archivada:** ${task.archived ? "Sí" : "No"}

¿Qué te gustaría hacer con esta task?`;
    } catch (error) {
      console.error(`[GetTaskFromCOR] ❌ Error:`, error);
      return `Error al consultar la task en COR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// ==================== TOOL PARA BUSCAR CLIENTE EN SISTEMA EXTERNO ====================

// Tool que el agente usa para buscar el cliente/marca en el sistema externo (COR, Trello, etc.)
// Solo se registra si la integración de project management está habilitada
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

// ==================== TOOL PARA CREAR TASK ====================

// Tool que el agente puede usar para crear una task
// SOLO crea en Convex — la publicación en COR/externo se hace desde el Panel de Control
export const createTaskTool = createTool({
  description: `Crear una nueva task/requerimiento en la base de datos. 
  SOLO usar esta herramienta cuando el usuario haya CONFIRMADO explicitamente que toda la informacion esta correcta.
  El usuario debe decir algo como "si", "correcto", "todo esta bien", "conforme", "ok, guardalo", etc.
  NO usar esta herramienta si el usuario quiere modificar algo.
  
  La task se guardará en el sistema. La publicación al sistema de gestión externo (COR) se hará desde el Panel de Control.
  
  Si previamente usaste searchClientInCOR y encontraste un cliente, incluye corClientId y corClientName.`,
  args: z.object({
    title: z.string().describe("Titulo breve del requerimiento"),
    description: z.string().optional().describe("Descripcion detallada del requerimiento"),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    brand: z.string().describe("Marca o empresa - OBLIGATORIO"),
    objective: z.string().optional().describe("Objetivo principal del proyecto"),
    keyMessage: z.string().optional().describe("Mensaje clave a comunicar"),
    kpis: z.string().optional().describe("KPIs o metricas de exito"),
    deadline: z.string().optional().describe("Fecha limite o timeline del proyecto"),
    budget: z.string().optional().describe("Presupuesto disponible"),
    approvers: z.string().optional().describe("Personas que deben aprobar el proyecto"),
    priority: z.string().optional().describe("Prioridad: baja, media, alta, urgente"),
    corClientId: z.number().optional().describe("ID del cliente en COR (obtenido con searchClientInCOR)"),
    corClientName: z.string().optional().describe("Nombre del cliente en COR (obtenido con searchClientInCOR)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[CreateTask] 🚀 CREANDO TASK (SOLO CONVEX)");
    console.log("========================================");
    
    const threadId = ctx.threadId;
    
    if (!threadId) {
      console.error("[CreateTask] ERROR: No se encontro threadId");
      return "Error: No se pudo identificar el thread de la conversacion.";
    }

    console.log(`[CreateTask] ThreadId: ${threadId}`);

    // Verificar que el cliente exista en COR si la integración está habilitada
    if (isProjectManagementEnabled() && !args.corClientId) {
      console.log("[CreateTask] ❌ BLOQUEADO: Integración habilitada pero no se proporcionó corClientId");
      return `❌ No se puede crear el requerimiento sin un cliente válido en el sistema de gestión de proyectos (COR).

Antes de crear el requerimiento, debes buscar y validar el cliente usando la herramienta searchClientInCOR.
Si el cliente no existe en COR, pide al usuario que proporcione un nombre de cliente que sí esté registrado.

NO crees el requerimiento hasta tener un corClientId válido.`;
    }

    // Verificar IDEMPOTENCIA: Si ya existe una task para este thread, no crear otra
    const existingTask = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
    
    if (existingTask) {
      console.log(`[CreateTask] ⚠️ Ya existe task para este thread: ${existingTask._id}`);
      
      return `Ya existe un requerimiento para esta conversación.

ID del requerimiento: ${existingTask._id}
Estado: ${existingTask.status}

Si necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.`;
    }

    // Obtener el userId del thread para el campo createdBy
    const userId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
    console.log(`[CreateTask] UserId: ${userId || "no encontrado"}`);

    // Crear task SOLO en Convex (sin sincronización con COR)
    console.log("[CreateTask] ⏳ Creando task en Convex...");
    
    const taskId = await ctx.runMutation(internal.data.tasks.createTaskInternal, {
      title: args.title,
      description: args.description,
      requestType: args.requestType,
      brand: args.brand,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      deadline: args.deadline,
      budget: args.budget,
      approvers: args.approvers,
      priority: args.priority,
      threadId,
      status: "nueva",
      createdBy: userId ? String(userId) : undefined,
      // Estado COR: pendiente (se publicará desde el Panel de Control)
      corSyncStatus: "pending",
      // Cliente externo (si se encontró con searchClientInCOR)
      corClientId: args.corClientId,
      corClientName: args.corClientName,
    });

    console.log(`[CreateTask] ✅ Task creada: ${taskId}`);

    // Asociar archivos del thread a la task (en background, sin bloquear)
    try {
      await ctx.runAction(internal.data.tasks.associateFilesToTask, {
        taskId,
        threadId,
        // Sin corTaskId — no hay task en COR todavía
      });
      console.log("[CreateTask] ✅ Archivos asociados");
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudieron asociar archivos (continuando):", error);
    }

    console.log("\n========================================");
    console.log("[CreateTask] 🏁 TASK CREADA EXITOSAMENTE");
    console.log(`[CreateTask] Task ID: ${taskId}`);
    console.log("========================================\n");

    return `Listo, requerimiento guardado correctamente.

**ID del requerimiento:** ${taskId}

Puedes revisarlo y publicarlo al sistema de gestión (COR) desde el Panel de Control: /workspace/control-panel

IMPORTANTE PARA EL AGENTE: En tu respuesta al usuario DEBES incluir este link exacto en formato markdown: [Panel de Control](/workspace/control-panel) — el usuario necesita poder hacer clic para ir directamente.`;
  },
});

// ==================== TOOL PARA VER TASK ====================

// Tool que el agente puede usar para ver los detalles de una task existente
export const getTaskTool = createTool({
  description: `Ver los detalles completos de una task/requerimiento existente en la base de datos.
  Usar esta herramienta cuando el usuario quiera ver, consultar o revisar la informacion de un requerimiento.
  El usuario puede proporcionar el ID de la task o, si acaba de crear una task en esta conversacion, 
  el agente puede encontrarla automaticamente por el threadId.
  
  IMPORTANTE: Usar esta herramienta ANTES de editar para conocer los valores actuales.`,
  args: z.object({
    taskId: z.string().optional().describe("ID de la task a consultar (opcional si se busca por thread)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[GetTask] CONSULTANDO TASK");
    console.log("========================================");
    
    try {
      const threadId = ctx.threadId;
      let task = null;
      
      // Obtener el userId del thread actual para verificar permisos
      let currentUserId = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[GetTask] Usuario actual: ${currentUserId}`);
      }
      
      // Si se proporciona taskId, buscar directamente por ID
      if (args.taskId) {
        console.log(`[GetTask] Buscando task por ID: ${args.taskId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: args.taskId });
        
        if (!task) {
          console.log(`[GetTask] Task no encontrada con ID: ${args.taskId}`);
          return `No se encontró ninguna task con el ID: ${args.taskId}. Verifica que el ID sea correcto.`;
        }
        
        // Verificar permisos: el usuario solo puede ver tasks creadas por él
        if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
          console.log(`[GetTask] Permiso denegado: usuario ${currentUserId} intentó acceder a task de ${task.createdBy}`);
          return "No tienes permiso para ver esta task. Solo puedes consultar requerimientos creados por ti.";
        }
      } else if (threadId) {
        // Si no hay taskId, buscar por threadId
        console.log(`[GetTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        
        if (!task) {
          console.log(`[GetTask] No hay task asociada al thread: ${threadId}`);
          return "No se encontró ninguna task asociada a esta conversación. ¿Deseas crear un nuevo requerimiento?";
        }
      } else {
        return "Error: No se pudo identificar la task a consultar. Por favor proporciona el ID de la task o asegúrate de estar en la conversación correcta.";
      }
      
      // Formatear la respuesta con todos los campos
      const corInfo = task.corTaskId 
        ? `**ID de tarea COR:** ${task.corTaskId} ✅`
        : "**Estado COR:** Pendiente de sincronización";
      
      const taskInfo = `
📋 **Detalles del Requerimiento**

${corInfo}

**Título:** ${task.title || "Sin título"}
**Estado:** ${task.status || "Sin estado"}
**Prioridad:** ${task.priority || "media"}

**Marca/Empresa:** ${task.brand || "No especificada"}
**Tipo de Requerimiento:** ${task.requestType || "No especificado"}

**Descripción:** ${task.description || "Sin descripción"}

**Objetivo:** ${task.objective || "No especificado"}
**Mensaje Clave:** ${task.keyMessage || "No especificado"}
**KPIs:** ${task.kpis || "No especificados"}

**Fecha Límite:** ${task.deadline || "No especificada"}
**Presupuesto:** ${task.budget || "No especificado"}
**Aprobadores:** ${task.approvers || "No especificados"}

**Archivos adjuntos:** ${task.fileIds?.length || 0}
`;
      console.log("[GetTask] Task encontrada y formateada exitosamente");
      console.log("========================================\n");
      return taskInfo;
      
    } catch (error) {
      console.error("[GetTask] Error al consultar task:", error);
      return `Error al consultar la task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// ==================== TOOL PARA EDITAR TASK ====================

// Tool que el agente puede usar para editar una task existente
export const editTaskTool = createTool({
  description: `Editar una task/requerimiento existente en COR y en la base de datos local.
  Usar esta herramienta cuando el usuario quiera modificar informacion de un requerimiento que ya fue creado.
  
  El usuario puede proporcionar:
  - El COR ID de la task (ej: 11301144) - RECOMENDADO, busca directamente en COR
  - El ID local de la task
  - O si acaba de crear una task en esta conversacion, se encuentra automaticamente por el threadId
  
  FLUJO:
  1. Si se proporciona corTaskId, primero consulta COR para ver el estado actual de la task
  2. Aplica los cambios solicitados
  3. Actualiza tanto en COR como en la base de datos local
  
  IMPORTANTE: Solo actualiza los campos que el usuario quiere cambiar, no modifiques los demas.`,
  args: z.object({
    corTaskId: z.string().optional().describe("ID de la task en COR (ej: 11301144) - PREFERIDO"),
    taskId: z.string().optional().describe("ID local de la task (opcional si se usa corTaskId o thread)"),
    title: z.string().optional().describe("Nuevo titulo del requerimiento"),
    description: z.string().optional().describe("Nueva descripcion detallada"),
    requestType: z.string().optional().describe("Nuevo tipo de requerimiento"),
    brand: z.string().optional().describe("Nueva marca o empresa"),
    objective: z.string().optional().describe("Nuevo objetivo principal"),
    keyMessage: z.string().optional().describe("Nuevo mensaje clave"),
    kpis: z.string().optional().describe("Nuevos KPIs"),
    deadline: z.string().optional().describe("Nueva fecha limite"),
    budget: z.string().optional().describe("Nuevo presupuesto"),
    approvers: z.string().optional().describe("Nuevos aprobadores"),
    priority: z.string().optional().describe("Nueva prioridad: baja, media, alta, urgente"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[EditTask] EDITANDO TASK");
    console.log("========================================");
    console.log("[EditTask] Datos recibidos:", JSON.stringify(args, null, 2));
    
    try {
      const threadId = ctx.threadId;
      let taskIdToEdit = args.taskId;
      let task = null;
      let corTaskData = null;
      
      // Obtener el userId del thread actual para verificar permisos
      let currentUserId = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[EditTask] Usuario actual: ${currentUserId}`);
      }
      
      // PRIORIDAD 1: Si se proporciona corTaskId, buscar por COR ID
      if (args.corTaskId) {
        console.log(`[EditTask] 🔍 Buscando task por COR ID: ${args.corTaskId}`);
        
        // Primero, obtener la task desde COR para ver su estado actual
        const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
          corTaskId: parseInt(args.corTaskId),
        });
        
        if (!corResult.success || !corResult.task) {
          console.log(`[EditTask] ❌ Task no encontrada en COR: ${corResult.error}`);
          return `No se encontró ninguna task con el COR ID: ${args.corTaskId} en el sistema COR.

Posibles causas:
- El ID no existe o fue eliminado
- No tienes permisos para ver esta task
- Error de conexión con COR

Por favor verifica el ID e intenta de nuevo.`;
        }
        
        corTaskData = corResult.task;
        console.log(`[EditTask] ✅ Task encontrada en COR:`, JSON.stringify(corTaskData, null, 2));
        
        // Buscar la task local por el COR ID
        task = await ctx.runQuery(internal.data.tasks.getTaskByCORIdInternal, { 
          corTaskId: args.corTaskId 
        });
        
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] 📋 Task local encontrada: ${taskIdToEdit}`);
        } else {
          console.log(`[EditTask] ⚠️ Task existe en COR pero no hay registro local`);
          // La task existe en COR pero no localmente - igual podemos editarla en COR
        }
      }
      // PRIORIDAD 2: Si se proporciona taskId local, buscar por ID
      else if (taskIdToEdit) {
        console.log(`[EditTask] Buscando task por ID local: ${taskIdToEdit}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToEdit });
        
        if (!task) {
          return `No se encontró ninguna task con el ID local: ${taskIdToEdit}. Verifica que el ID sea correcto.`;
        }
        
        // Verificar permisos
        if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
          console.log(`[EditTask] Permiso denegado: usuario ${currentUserId} intentó editar task de ${task.createdBy}`);
          return "No tienes permiso para editar esta task. Solo puedes modificar requerimientos creados por ti.";
        }
        
        // Si la task tiene COR ID, obtener datos de COR
        if (task.corTaskId) {
          const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
            corTaskId: parseInt(task.corTaskId),
          });
          if (corResult.success && corResult.task) {
            corTaskData = corResult.task;
          }
        }
      } 
      // PRIORIDAD 3: Buscar por threadId
      else if (threadId) {
        console.log(`[EditTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] Task encontrada: ${taskIdToEdit}`);
          
          // Si la task tiene COR ID, obtener datos de COR
          if (task.corTaskId) {
            const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
              corTaskId: parseInt(task.corTaskId),
            });
            if (corResult.success && corResult.task) {
              corTaskData = corResult.task;
            }
          }
        }
      }
      
      // Si no encontramos ninguna task
      if (!taskIdToEdit && !args.corTaskId) {
        return "Error: No se pudo identificar la task a editar. Por favor proporciona el COR ID de la task (ej: 11301144), el ID local, o asegurate de estar en la conversacion correcta.";
      }
      
      // Construir objeto con solo los campos a actualizar
      const updates: Record<string, string | undefined> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.requestType !== undefined) updates.requestType = args.requestType;
      if (args.brand !== undefined) updates.brand = args.brand;
      if (args.objective !== undefined) updates.objective = args.objective;
      if (args.keyMessage !== undefined) updates.keyMessage = args.keyMessage;
      if (args.kpis !== undefined) updates.kpis = args.kpis;
      if (args.deadline !== undefined) updates.deadline = args.deadline;
      if (args.budget !== undefined) updates.budget = args.budget;
      if (args.approvers !== undefined) updates.approvers = args.approvers;
      if (args.priority !== undefined) updates.priority = args.priority;
      
      if (Object.keys(updates).length === 0) {
        // Si no hay campos para actualizar pero tenemos datos de COR, mostrar la task actual
        if (corTaskData) {
          return `📋 **Task actual en COR (ID: ${corTaskData.id})**

**Título:** ${corTaskData.title}
**Descripción:** ${corTaskData.description || "Sin descripción"}
**Estado:** ${corTaskData.status}
**Prioridad:** ${corTaskData.priority}
**Deadline:** ${corTaskData.deadline || "Sin fecha límite"}

¿Qué cambios quieres hacer?`;
        }
        return "No se proporcionaron campos para actualizar.";
      }
      
      console.log(`[EditTask] Campos a actualizar:`, JSON.stringify(updates, null, 2));
      
      // ACTUALIZAR EN COR PRIMERO (si tenemos COR ID)
      let corUpdateResult = null;
      const corIdToUpdate = args.corTaskId || task?.corTaskId;
      
      if (corIdToUpdate) {
        console.log(`[EditTask] 🔄 Actualizando en COR (Task ID: ${corIdToUpdate})...`);
        
        try {
          corUpdateResult = await ctx.runAction(internal.integrations.cor.updateTaskInCOR, {
            corTaskId: parseInt(corIdToUpdate),
            title: args.title,
            description: args.description,
            deadline: args.deadline,
            priority: args.priority,
          });
          
          if (corUpdateResult.success) {
            console.log("[EditTask] ✅ Task actualizada en COR");
          } else {
            console.error("[EditTask] ⚠️ Error al actualizar en COR:", corUpdateResult.error);
          }
        } catch (corError) {
          console.error("[EditTask] ⚠️ Error al actualizar en COR:", corError);
        }
      }
      
      // ACTUALIZAR EN BASE DE DATOS LOCAL (si existe registro local)
      if (taskIdToEdit) {
        await ctx.runMutation(internal.data.tasks.updateTaskInternal, {
          taskId: taskIdToEdit,
          updates,
        });
        console.log(`[EditTask] ✅ Task ${taskIdToEdit} actualizada localmente`);
      }
      
      console.log("========================================\n");
      
      const updatedFields = Object.keys(updates).join(", ");
      
      // Construir respuesta según el resultado
      let corStatus = "";
      if (corIdToUpdate) {
        if (corUpdateResult?.success) {
          corStatus = `\n✅ Cambios aplicados en COR (ID: ${corIdToUpdate})`;
        } else if (corUpdateResult) {
          corStatus = `\n⚠️ No se pudieron aplicar los cambios en COR: ${corUpdateResult.error}`;
        }
      }
      
      return `✅ Task actualizada exitosamente!

**ID de tarea COR:** ${corIdToUpdate || "No sincronizada"}
**Campos actualizados:** ${updatedFields}${corStatus}

¿Hay algo más que quieras modificar?`;
    } catch (error) {
      console.error("[EditTask] Error actualizando task:", error);
      return `Error al actualizar la task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// ==================== MUTATIONS ====================

// Mutation interna para crear task (llamada desde el tool o workflow)
export const createTaskInternal = internalMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    requestType: v.string(),
    brand: v.string(),
    objective: v.optional(v.string()),
    keyMessage: v.optional(v.string()),
    kpis: v.optional(v.string()),
    deadline: v.optional(v.string()),
    budget: v.optional(v.string()),
    approvers: v.optional(v.string()),
    priority: v.optional(v.string()),
    threadId: v.string(),
    status: v.string(),
    fileIds: v.optional(v.array(v.string())),
    createdBy: v.optional(v.string()),
    // Campos para sincronización con COR
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.optional(v.string()),
    corSyncError: v.optional(v.string()),
    // Campos para identificar el cliente en el sistema externo
    corClientId: v.optional(v.number()),
    corClientName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Tasks.createTaskInternal] Insertando en base de datos...");
    
    const taskId = await ctx.db.insert("tasks", {
      title: args.title,
      description: args.description,
      requestType: args.requestType,
      brand: args.brand,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      deadline: args.deadline,
      budget: args.budget,
      approvers: args.approvers,
      priority: args.priority || "media",
      threadId: args.threadId,
      status: args.status,
      fileIds: args.fileIds,
      createdBy: args.createdBy,
      // Campos COR / sistema externo
      corTaskId: args.corTaskId,
      corProjectId: args.corProjectId,
      corSyncStatus: args.corSyncStatus,
      corSyncError: args.corSyncError,
      corClientId: args.corClientId,
      corClientName: args.corClientName,
    });
    
    console.log(`[Tasks.createTaskInternal] Task insertada con ID: ${taskId}`);
    console.log(`[Tasks.createTaskInternal] Detalles: Marca=${args.brand}, Tipo=${args.requestType}`);
    
    return taskId;
  },
});

// Mutation interna para actualizar task (llamada desde el editTaskTool)
export const updateTaskInternal = internalMutation({
  args: {
    taskId: v.string(),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      requestType: v.optional(v.string()),
      brand: v.optional(v.string()),
      objective: v.optional(v.string()),
      keyMessage: v.optional(v.string()),
      kpis: v.optional(v.string()),
      deadline: v.optional(v.string()),
      budget: v.optional(v.string()),
      approvers: v.optional(v.string()),
      priority: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    console.log(`[Tasks.updateTaskInternal] Actualizando task ${args.taskId}...`);
    
    // Filtrar campos undefined
    const updateData: any = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }
    
    await ctx.db.patch(args.taskId as any, updateData);
    
    console.log(`[Tasks.updateTaskInternal] Task actualizada`);
    return args.taskId;
  },
});

// Query interna para obtener task por threadId
export const getTaskByThreadInternal = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    return task;
  },
});

// Query interna para obtener task por ID
export const getTaskByIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Buscar la task usando query en lugar de get para asegurar el tipo correcto
      const tasks = await ctx.db
        .query("tasks")
        .filter((q) => q.eq(q.field("_id"), args.taskId))
        .collect();
      return tasks[0] || null;
    } catch {
      return null;
    }
  },
});

// Query interna para obtener task por COR ID
export const getTaskByCORIdInternal = internalQuery({
  args: {
    corTaskId: v.string(),
  },
  handler: async (ctx, args) => {
    // Buscar la task que tenga este COR ID
    const task = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("corTaskId"), args.corTaskId))
      .first();
    return task;
  },
});

// Query interna para obtener el userId del thread
export const getUserIdFromThread = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    return chatThread?.userId || null;
  },
});

// Mutation pública para actualizar campos de una task desde el frontend (Panel de Control)
export const updateTaskFields = mutation({
  args: {
    taskId: v.id("tasks"),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      requestType: v.optional(v.string()),
      brand: v.optional(v.string()),
      objective: v.optional(v.string()),
      keyMessage: v.optional(v.string()),
      kpis: v.optional(v.string()),
      deadline: v.optional(v.string()),
      budget: v.optional(v.string()),
      approvers: v.optional(v.string()),
      priority: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    // Verificar que el usuario esté autenticado
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // Filtrar campos undefined
    const updateData: Record<string, string> = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    if (Object.keys(updateData).length === 0) return args.taskId;

    console.log(`[Tasks.updateTaskFields] Actualizando task ${args.taskId}:`, Object.keys(updateData));
    await ctx.db.patch(args.taskId, updateData);
    return args.taskId;
  },
});

// Mutation para actualizar el estado de una task
export const updateTaskStatus = mutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      status: args.status,
    });
    return args.taskId;
  },
});

// Mutation para agregar fileIds a una task existente
export const addFilesToTask = mutation({
  args: {
    taskId: v.id("tasks"),
    fileIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");
    
    const currentFileIds = task.fileIds || [];
    const newFileIds = [...currentFileIds, ...args.fileIds];
    
    await ctx.db.patch(args.taskId, {
      fileIds: newFileIds,
    });
    return args.taskId;
  },
});

// ==================== BACKGROUND JOB: Asociar archivos a task ====================
// Esta acción se ejecuta en background después de crear una task
// para buscar y asociar los archivos del thread sin bloquear la respuesta
// TAMBIÉN envía los archivos a COR como attachments si la task está sincronizada
export const associateFilesToTask = internalAction({
  args: {
    taskId: v.string(),
    threadId: v.string(),
    corTaskId: v.optional(v.number()), // ID de la task en COR para enviar attachments
  },
  handler: async (ctx, args): Promise<void> => {
    console.log(`[AssociateFiles] Buscando archivos para task ${args.taskId}...`);
    
    try {
      // Obtener todos los mensajes del thread
      const messagesResult = await listMessages(ctx, components.agent, {
        threadId: args.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      });
      
      const allFileIds: string[] = [];
      
      // Buscar fileIds en cada mensaje
      for (const msg of messagesResult.page) {
        const msgAny = msg as any;
        
        // Verificar si el mensaje tiene fileIds (guardados como metadata)
        if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
          console.log(`[AssociateFiles] FileIds encontrados: ${msgAny.fileIds}`);
          allFileIds.push(...msgAny.fileIds);
        }
      }
      
      if (allFileIds.length > 0) {
        console.log(`[AssociateFiles] Asociando ${allFileIds.length} archivos a task ${args.taskId}`);
        
        // Actualizar la task con los fileIds encontrados
        await ctx.runMutation(internal.data.tasks.updateTaskFileIds, {
          taskId: args.taskId,
          fileIds: allFileIds,
        });
        
        console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente a task local`);
        
        // Si la task está sincronizada con COR, enviar los archivos como mensaje con attachments
        if (args.corTaskId) {
          console.log(`[AssociateFiles] 📎 Enviando archivos a COR (Task ID: ${args.corTaskId})...`);
          
          try {
            // Obtener información y URLs de cada archivo
            const attachments: { name: string; url: string; type: string; source: string }[] = [];
            
            for (const fileId of allFileIds) {
              try {
                // Obtener info del archivo desde el agente
                const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
                
                if (fileInfo && fileInfo.url) {
                  attachments.push({
                    name: fileInfo.filename || `archivo_${fileId}`,
                    url: fileInfo.url,
                    type: fileInfo.mimeType || "application/octet-stream",
                    source: "convex",
                  });
                  console.log(`[AssociateFiles] 📎 Archivo preparado: ${fileInfo.filename}`);
                }
              } catch (fileError) {
                console.error(`[AssociateFiles] ⚠️ Error obteniendo archivo ${fileId}:`, fileError);
              }
            }
            
            // Si hay attachments, enviar mensaje a COR
            if (attachments.length > 0) {
              await ctx.runAction(internal.integrations.cor.postTaskMessage, {
                corTaskId: args.corTaskId,
                message: `📎 Archivos adjuntos del brief (${attachments.length} archivo${attachments.length > 1 ? 's' : ''})`,
                attachments,
              });
              console.log(`[AssociateFiles] ✅ ${attachments.length} archivos enviados a COR`);
            }
          } catch (corError) {
            console.error(`[AssociateFiles] ⚠️ Error enviando archivos a COR:`, corError);
            // No fallar si COR tiene problemas, los archivos ya están asociados localmente
          }
        }
      } else {
        console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
      }
    } catch (error) {
      console.error(`[AssociateFiles] Error:`, error);
    }
  },
});

// Query interna para obtener información de un archivo
export const getFileInfoInternal = internalQuery({
  args: {
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Obtener el documento file del componente agent
      const fileDoc = await ctx.runQuery(
        components.agent.files.get,
        { fileId: args.fileId }
      );
      
      if (!fileDoc) {
        console.error(`[Files] No se encontró el archivo con fileId: ${args.fileId}`);
        return null;
      }
      
      // Obtener la URL desde el storageId
      const url = await ctx.storage.getUrl(fileDoc.storageId);
      
      return {
        fileId: args.fileId,
        filename: fileDoc.filename || `archivo_${args.fileId}`,
        mimeType: fileDoc.mimeType,
        url,
      };
    } catch (error) {
      console.error(`[Files] Error obteniendo info para fileId ${args.fileId}:`, error);
      return null;
    }
  },
});

// Mutation interna para actualizar fileIds de una task
export const updateTaskFileIds = internalMutation({
  args: {
    taskId: v.string(),
    fileIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId as any, {
      fileIds: args.fileIds,
    });
    return args.taskId;
  },
});

// ==================== QUERIES ====================

// Obtener task por threadId
export const getTaskByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    
    return task;
  },
});

// Obtener una task por ID
export const getTask = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.taskId);
  },
});

// Listar todas las tasks
export const listTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    }
    return await ctx.db.query("tasks").collect();
  },
});

// Listar tasks por threadId
export const listByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
  },
});

// ==================== QUERY: LISTAR TASKS DEL USUARIO AUTENTICADO ====================

/**
 * Lista las tasks creadas por el usuario autenticado.
 * Se usa en el Panel de Control para mostrar las tasks del usuario.
 * Soporta filtro opcional por status.
 * Retorna ordenadas por fecha de creación descendente (más recientes primero).
 */
export const listMyTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Obtener el userId autenticado via @convex-dev/auth
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const userIdStr = String(userId);
    
    // Buscar tasks creadas por este usuario
    let tasks = await ctx.db
      .query("tasks")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", userIdStr))
      .order("desc")
      .collect();
    
    // Filtrar por status si se proporcionó
    if (args.status) {
      tasks = tasks.filter((t) => t.status === args.status);
    }
    
    return tasks;
  },
});

// ==================== PUBLICAR TASK EN SISTEMA EXTERNO (COR) ====================

/**
 * Mutation pública que inicia la publicación de una task en el sistema externo.
 * 
 * Patrón: mutation (feedback inmediato) → scheduler.runAfter(0, action) (trabajo async)
 * 
 * 1. Valida que la task existe y pertenece al usuario
 * 2. Pone corSyncStatus: "syncing" (feedback inmediato para la UI)
 * 3. Schedula la action que hace el trabajo pesado (crear proyecto + task en COR)
 * 4. Retorna inmediatamente — la UI se actualiza reactivamente via subscriptions
 */
export const startPublishTaskToExternal = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    // Verificar autenticación
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("No autenticado");
    }

    // Obtener la task
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      throw new Error("Task no encontrada");
    }

    // Verificar que la task no está ya sincronizada
    if (task.corSyncStatus === "synced") {
      throw new Error("La task ya está publicada en el sistema externo");
    }

    // Verificar que no está en proceso de sincronización
    if (task.corSyncStatus === "syncing") {
      throw new Error("La task ya está en proceso de publicación");
    }

    // Poner estado "syncing" — la UI lo verá inmediatamente
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncError: undefined,
    });

    // Schedular la action que hace el trabajo pesado
    // runAfter(0, ...) = ejecutar inmediatamente en background
    await ctx.scheduler.runAfter(0, internal.data.tasks.publishTaskToExternalAction, {
      taskId: args.taskId,
    });

    return { success: true, message: "Publicación iniciada" };
  },
});

/**
 * Action interna que ejecuta la publicación real en el sistema externo.
 * Se ejecuta en background via scheduler para no bloquear al usuario.
 * 
 * Flujo:
 * 1. Lee la task de Convex
 * 2. Crea un PROYECTO en COR (POST /projects) asociado al client_id
 * 3. Crea una TASK en COR (POST /tasks) dentro del proyecto
 * 4. Actualiza la task local con los IDs externos y estado "synced"
 * 5. Asocia los archivos del thread a la task en COR
 */
export const publishTaskToExternalAction = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    console.log("\n========================================");
    console.log("[PublishTask] 🚀 PUBLICANDO TASK EN SISTEMA EXTERNO");
    console.log(`[PublishTask] Task ID: ${args.taskId}`);
    console.log("========================================\n");

    try {
      // 1. Leer la task de Convex
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[PublishTask] ❌ Task no encontrada");
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: "Task no encontrada en la base de datos",
        });
        return;
      }

      // 2. Obtener el provider de integraciones
      const provider = getProjectManagementProvider();
      console.log(`[PublishTask] Provider: ${provider.name}`);

      // 3. Crear PROYECTO en el sistema externo
      const clientId = task.corClientId;
      if (!clientId) {
        console.error("[PublishTask] ❌ No hay corClientId — no se puede crear proyecto");
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: "No se encontró un cliente asociado. Busca el cliente antes de publicar.",
        });
        return;
      }

      console.log(`[PublishTask] 📁 Creando proyecto para cliente ID: ${clientId}...`);
      const projectName = `${task.brand} - ${task.title}`;
      
      const project = await provider.createProject({
        name: projectName,
        clientId,
        description: task.description,
        deadline: task.deadline,
      });

      console.log(`[PublishTask] ✅ Proyecto creado: ID ${project.id}`);

      // 4. Crear TASK dentro del proyecto
      console.log(`[PublishTask] 📋 Creando task en proyecto ${project.id}...`);
      
      // Construir descripción completa del brief
      const briefDescription = [
        `Marca: ${task.brand}`,
        `Tipo: ${task.requestType}`,
        task.objective ? `Objetivo: ${task.objective}` : null,
        task.keyMessage ? `Mensaje clave: ${task.keyMessage}` : null,
        task.kpis ? `KPIs: ${task.kpis}` : null,
        task.budget ? `Presupuesto: ${task.budget}` : null,
        task.approvers ? `Aprobadores: ${task.approvers}` : null,
        task.description ? `\nDescripción:\n${task.description}` : null,
      ].filter(Boolean).join("\n");

      const externalTask = await provider.createTask({
        projectId: project.id,
        title: task.title,
        description: briefDescription,
        deadline: task.deadline,
        priority: task.priority,
      });

      console.log(`[PublishTask] ✅ Task creada: ID ${externalTask.id}`);

      // 5. Actualizar task local con IDs externos y estado "synced"
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "synced",
        corTaskId: String(externalTask.id),
        corProjectId: project.id,
        corSyncedAt: Date.now(),
      });

      // 6. Asociar archivos si existen
      if (task.fileIds && task.fileIds.length > 0) {
        console.log(`[PublishTask] 📎 Enviando ${task.fileIds.length} archivos a COR...`);
        try {
          // Preparar attachments
          const attachments: { name: string; url: string; type: string; source: string }[] = [];
          
          for (const fileId of task.fileIds) {
            try {
              const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
              if (fileInfo && fileInfo.url) {
                attachments.push({
                  name: fileInfo.filename || `archivo_${fileId}`,
                  url: fileInfo.url,
                  type: fileInfo.mimeType || "application/octet-stream",
                  source: "convex",
                });
              }
            } catch (fileError) {
              console.error(`[PublishTask] ⚠️ Error obteniendo archivo ${fileId}:`, fileError);
            }
          }
          
          if (attachments.length > 0) {
            await ctx.runAction(internal.integrations.cor.postTaskMessage, {
              corTaskId: externalTask.id,
              message: `📎 Archivos adjuntos del brief (${attachments.length} archivo${attachments.length > 1 ? 's' : ''})`,
              attachments,
            });
            console.log(`[PublishTask] ✅ ${attachments.length} archivos enviados`);
          }
        } catch (fileError) {
          console.error("[PublishTask] ⚠️ Error enviando archivos (task ya publicada):", fileError);
        }
      }

      console.log("\n========================================");
      console.log("[PublishTask] 🏁 PUBLICACIÓN COMPLETADA");
      console.log(`[PublishTask] Proyecto: ${project.id}`);
      console.log(`[PublishTask] Task COR: ${externalTask.id}`);
      console.log("========================================\n");

    } catch (error) {
      console.error("[PublishTask] ❌ Error publicando:", error);
      
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "error",
        corSyncError: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/**
 * Mutation interna para actualizar el estado de publicación.
 * Llamada desde publishTaskToExternalAction para actualizar
 * la task con el resultado (éxito o error).
 */
export const updatePublishStatus = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corSyncStatus: v.string(),
    corSyncError: v.optional(v.string()),
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {
      corSyncStatus: args.corSyncStatus,
    };
    
    if (args.corSyncError !== undefined) updateData.corSyncError = args.corSyncError;
    if (args.corTaskId !== undefined) updateData.corTaskId = args.corTaskId;
    if (args.corProjectId !== undefined) updateData.corProjectId = args.corProjectId;
    if (args.corSyncedAt !== undefined) updateData.corSyncedAt = args.corSyncedAt;
    
    await ctx.db.patch(args.taskId, updateData as any);
    console.log(`[UpdatePublishStatus] Task ${args.taskId} → ${args.corSyncStatus}`);
  },
});
