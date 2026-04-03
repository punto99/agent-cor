"use node";

// convex/evaluatorAgentAction.ts
// Agente evaluador para comparar producto final con requerimiento original
// IMPORTANTE: Este archivo usa Node.js runtime (512MB) en vez de Convex runtime (64MB)
import { Agent, createTool, listMessages } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { agentConfig, getEvaluatorAgentInstructions } from "../lib/serverConfig";
import { 
  classifyError, 
  extractErrorMessage,
  logLLMAttempt,
  geminiConfig,
  openaiConfig,
  withLLMFallback,
} from "../lib/llmFallback";

// Usar modelo flash que es más eficiente en memoria
const languageModel = google("gemini-3.1-pro-preview");

// Tool para obtener la información de la task del thread
const getTaskInfoTool = createTool({
  description: `Obtener la información del requerimiento original (task/brief) asociado a este thread.
  Usar esta herramienta para conocer qué solicitó el usuario originalmente.`,
  args: z.object({
    taskId: z.string().optional().describe("ID de la task (opcional, se busca en el contexto si no se proporciona)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    
    console.log(`[EvaluatorTool] Buscando task. ThreadId: ${threadId}, TaskId arg: ${args.taskId}`);
    
    // Primero intentar obtener el taskId de los mensajes recientes
    // OPTIMIZACIÓN: Solo cargar 10 mensajes en vez de 20 para reducir memoria
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId: threadId || "",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    
    let taskIdToUse = args.taskId;
    
    // Buscar el taskId en el texto de los mensajes (formato: "Task ID: xxx")
    if (!taskIdToUse) {
      for (const msg of messagesResult.page) {
        const msgAny = msg as any;
        // Buscar en el contenido del mensaje
        if (msgAny.message?.content && Array.isArray(msgAny.message.content)) {
          for (const part of msgAny.message.content) {
            if (part.type === "text" && part.text) {
              const match = part.text.match(/Task ID:\s*([a-z0-9]+)/i);
              if (match) {
                taskIdToUse = match[1];
                console.log(`[EvaluatorTool] TaskId encontrado en texto: ${taskIdToUse}`);
                break;
              }
            }
          }
        }
        if (taskIdToUse) break;
      }
    }
    
    if (!taskIdToUse) {
      return "Error: No se pudo identificar el taskId. Por favor verifica que el mensaje incluya la información de la task.";
    }
    
    // Buscar la task por ID
    const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
      taskId: taskIdToUse,
    });
    
    if (!task) {
      return "No se encontró ningún requerimiento/task con ese ID.";
    }
    
    console.log(`[EvaluatorTool] Task encontrada: ${task._id}`);
    
    return `INFORMACIÓN DEL REQUERIMIENTO ORIGINAL:

ID: ${task._id}
Título: ${task.title}
Estado actual: ${task.status}
Prioridad: ${task.priority ?? 1}
Fecha límite: ${task.deadline || "No especificado"}

Descripción del Brief:
${task.description || "Sin descripción"}

Archivos de referencia adjuntos: Se verificarán en el thread original
Thread ID original: ${task.threadId}`;
  },
});

// Tool para obtener las imágenes de referencia del requerimiento original
const getOriginalReferenceImagesTool = createTool({
  description: `Obtener información sobre las imágenes de referencia del requerimiento original.
  Esta herramienta solo cuenta las imágenes, no las carga en memoria.`,
  args: z.object({
    briefThreadId: z.string().optional().describe("ID del thread del brief original (opcional)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    
    console.log(`[EvaluatorTool] Buscando imágenes de referencia`);
    
    // Primero obtener el briefThreadId de los mensajes del thread actual
    // OPTIMIZACIÓN: Solo cargar 5 mensajes para buscar el ID
    const currentMessages = await listMessages(ctx, components.agent, {
      threadId: threadId || "",
      paginationOpts: { cursor: null, numItems: 5 },
    });
    
    let briefThreadId = args.briefThreadId;
    
    // Buscar el briefThreadId en el texto de los mensajes
    if (!briefThreadId) {
      for (const msg of currentMessages.page) {
        const msgAny = msg as any;
        if (msgAny.message?.content && Array.isArray(msgAny.message.content)) {
          for (const part of msgAny.message.content) {
            if (part.type === "text" && part.text) {
              const match = part.text.match(/Brief Thread ID:\s*([a-z0-9]+)/i);
              if (match) {
                briefThreadId = match[1];
                console.log(`[EvaluatorTool] BriefThreadId encontrado: ${briefThreadId}`);
                break;
              }
            }
          }
        }
        if (briefThreadId) break;
      }
    }
    
    if (!briefThreadId) {
      return "Error: No se pudo identificar el thread del brief original.";
    }
    
    // OPTIMIZACIÓN: Obtener solo los primeros 10 mensajes del thread original
    // para contar imágenes sin cargar todo en memoria
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId: briefThreadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    
    let imageCount = 0;
    
    for (const msg of messagesResult.page) {
      const msgAny = msg as any;
      // Contar imágenes sin almacenar su contenido
      if (msgAny.message?.content && Array.isArray(msgAny.message.content)) {
        for (const part of msgAny.message.content) {
          if (part.type === "image" || part.type === "file") {
            imageCount++;
          }
        }
      }
    }
    
    if (imageCount === 0) {
      return "No se encontraron imágenes de referencia en el requerimiento original.";
    }
    
    return `Se encontraron ${imageCount} archivo(s) de referencia del requerimiento original.
Nota: Las imágenes del producto final a evaluar deben ser enviadas directamente en el mensaje.`;
  },
});

// ==================== AGENTE EVALUADOR ====================

export const evaluatorAgent = new Agent(components.agent, {
  name: agentConfig.evaluator.name,
  instructions: getEvaluatorAgentInstructions(),
  
  languageModel,
  
  tools: {
    getTaskInfo: getTaskInfoTool,
    getOriginalReferenceImages: getOriginalReferenceImagesTool,
  },
  
  maxSteps: 8,
});

// Action para generar evaluación - CON FALLBACK: Gemini -> OpenAI
export const generateEvaluationAsync = internalAction({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, { threadId, promptMessageId }): Promise<{
    text: string;
    promptMessageId: string;
    provider: "gemini" | "openai";
  }> => {
    const startTime = Date.now();
    console.log("\n========================================");
    console.log("[Evaluator] 🚀 INICIO DE EVALUACIÓN");
    console.log(`[Evaluator] ThreadId: ${threadId}`);
    console.log("========================================\n");

    const { generateText } = await import("ai");

    // Preparar contexto
    const { args: preparedArgs, save } = await evaluatorAgent.start(
      ctx,
      { promptMessageId },
      { threadId }
    );

    // Verificar configuración de proveedores
    const geminiEnabled: boolean = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "gemini" });
    const openaiEnabled: boolean = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "openai" });

    // Ejecutar con fallback automático Gemini → OpenAI
    const { result, provider: usedProvider } = await withLLMFallback({
      agentName: "evaluatorAgent",
      threadId,
      geminiEnabled,
      openaiEnabled,
      primaryFn: () => generateText({
        ...preparedArgs,
        model: geminiConfig.model,
        providerOptions: geminiConfig.providerOptions as any,
        maxRetries: 0,
      }),
      fallbackFn: () => generateText({
        ...preparedArgs,
        model: openaiConfig.model,
        maxRetries: 0,
      }),
      logError: async (log) => {
        await ctx.runMutation(internal.data.llmConfig.logLLMError, log);
      },
      onBothFailed: "Los servicios de evaluación están temporalmente no disponibles. Por favor, intenta de nuevo más tarde.",
    });

    // Guardar resultado
    for (const step of result.steps) {
      await save({ step });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[Evaluator] ✅ Evaluación completada con ${usedProvider} en ${totalTime}ms`);

    return {
      text: result.text,
      promptMessageId,
      provider: usedProvider,
    };
  },
});
