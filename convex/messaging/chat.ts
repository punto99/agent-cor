// convex/chat.ts
// Funciones para manejar conversaciones con el sistema multi-agente
import { v } from "convex/values";
import { mutation, query, internalAction } from "../_generated/server";
import { briefAgent } from "../agents/agent";
import { orchestratorAgent } from "../agents/orchestratorAgent";
import { documentSearchAgent } from "../agents/documentSearchAgent";
import { components, internal } from "../_generated/api";
import { saveMessage, listUIMessages, getFile } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { enabledAgents } from "../lib/serverConfig";
import { 
  classifyError, 
  extractErrorMessage, 
  isRecoverableError,
  logLLMAttempt,
  geminiConfig,
  openaiConfig,
} from "../lib/llmFallback";

// NOTA: La creación de threads ahora se hace a través de convex/threads.ts
// que usa autenticación y crea correctamente el thread del Agent + chatThreads

// Obtener el último thread de CHAT del usuario (no incluye threads de evaluación)
export const getLatestThread = query({
  args: {
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    // Buscar en nuestra tabla chatThreads (excluye evaluaciones automáticamente)
    let chatThread;
    
    if (args.userId) {
      chatThread = await ctx.db
        .query("chatThreads")
        .withIndex("by_user", (q) => q.eq("userId", args.userId!))
        .order("desc")
        .first();
    } else {
      chatThread = await ctx.db
        .query("chatThreads")
        .order("desc")
        .first();
    }
    
    if (chatThread) {
      return chatThread.threadId;
    }
    
    return null;
  },
});

// Enviar un mensaje y generar respuesta asíncrona
export const sendMessage = mutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
    fileId: v.optional(v.string()), // Mantener para compatibilidad
    fileIds: v.optional(v.array(v.string())), // Nuevo: múltiples archivos
  },
  handler: async (ctx, { threadId, prompt, fileId, fileIds }) => {
    console.log(`[Chat] 📤 Guardando mensaje en thread ${threadId}`);
    
    // Crear contenido del mensaje
    const content: any[] = [];
    
    // Combinar fileId y fileIds para compatibilidad
    const allFileIds: string[] = [];
    if (fileId) allFileIds.push(fileId);
    if (fileIds) allFileIds.push(...fileIds);
    
    // Procesar todos los archivos
    for (const fId of allFileIds) {
      try {
        const fileData = await getFile(ctx, components.agent, fId);
        
        const { imagePart, filePart, file } = fileData;
        // Verificar si es un archivo Word (Gemini no lo soporta)
        // Usamos la extensión del filename para detectar archivos Word
        const filename = file?.filename || '';
        const isWordDocument = filename.toLowerCase().endsWith('.docx') || 
          filename.toLowerCase().endsWith('.doc');
        
        // Preferir imagePart si es una imagen
        if (imagePart) {
          // LOG: Estimar tamaño de la imagen si tiene data inline
          if ((imagePart as any).image?.source?.data) {
            const dataLength = (imagePart as any).image.source.data.length;
            console.log(`[Chat] 🖼️ Agregando imagePart - tamaño data: ${(dataLength / 1024).toFixed(1)}KB`);
          } else {
            console.log(`[Chat] 🖼️ Agregando imagePart (referencia URL)`);
          }
          content.push(imagePart);
        } else if (filePart && !isWordDocument) {
          // Solo agregar filePart si NO es Word (Gemini no soporta Word)
          console.log(`[Chat] 📄 Agregando filePart`);
          content.push(filePart);
        } else if (isWordDocument) {
          // Para Word, el contenido ya fue extraído y las imágenes guardadas por separado
          // No enviamos el archivo original porque Gemini no lo soporta
          console.log(`[Chat] 📝 Archivo Word detectado - omitiendo (contenido extraído en frontend)`);
        }
      } catch (error) {
        console.error(`[Chat] Error obteniendo archivo ${fId}:`, error);
      }
    }
    
    // Agregar texto si existe
    if (prompt.trim()) {
      content.push({ type: "text", text: prompt });
    }
    
    // Si no hay contenido, lanzar error
    if (content.length === 0) {
      throw new Error("El mensaje debe contener texto o archivo");
    }
    
    // Guardar el mensaje del usuario
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      message: { 
        role: "user", 
        content
      },
      metadata: allFileIds.length > 0 ? { fileIds: allFileIds } : undefined,
    });
    
    console.log(`[Chat] ✅ Mensaje guardado: ${messageId}`);
    
    // Disparar generación de respuesta asíncrona
    await ctx.scheduler.runAfter(0, internal.messaging.chat.generateResponseAsync, {
      threadId,
      promptMessageId: messageId,
    });
    
    return { messageId };
  },
});

// Generar respuesta del agente (interna, llamada async)
// CON ORQUESTADOR: Clasifica intención → enruta al agente correcto
// CON SISTEMA DE FALLBACK: Gemini -> OpenAI GPT-5.2
export const generateResponseAsync = internalAction({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, { threadId, promptMessageId }) => {
    const startTime = Date.now();
    console.log("\n========================================");
    console.log("[GenerateResponse] 🚀 INICIO DE GENERACIÓN");
    console.log(`[GenerateResponse] ThreadId: ${threadId}`);
    console.log(`[GenerateResponse] Timestamp: ${new Date().toISOString()}`);
    console.log("========================================\n");

    // Importación dinámica del AI SDK
    const { generateText, generateObject } = await import("ai");
    const { z } = await import("zod/v3");

    // =====================================================
    // PASO 0: Consultar estado de proveedores (UNA sola vez)
    // Usa llmConfig table via isProviderEnabled (convex/data/llmConfig.ts)
    // =====================================================
    let geminiEnabled = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "gemini" });
    const openaiEnabled = await ctx.runQuery(internal.data.llmConfig.isProviderEnabled, { provider: "openai" });
    console.log(`[GenerateResponse] 🔧 Proveedores: Gemini=${geminiEnabled}, OpenAI=${openaiEnabled}`);

    // =====================================================
    // PASO 1: Determinar agentes habilitados y seleccionar
    // =====================================================
    const enabledSpecialized = {
      brief: enabledAgents.brief,
      documentSearch: enabledAgents.documentSearch,
    };
    const enabledCount = Object.values(enabledSpecialized).filter(Boolean).length;

    let selectedAgentKey: "brief" | "documentSearch" | "orchestrator" = "brief"; // default
    let orchestratorIntent: string | null = null;

    // Short-circuit — si solo 1 agente habilitado, usarlo directamente
    if (enabledCount <= 1) {
      if (enabledSpecialized.documentSearch && !enabledSpecialized.brief) {
        selectedAgentKey = "documentSearch";
      } else {
        selectedAgentKey = "brief";
      }
      console.log(`[GenerateResponse] ⚡ Short-circuit: solo ${selectedAgentKey} habilitado, saltando orquestador`);
    }
    // Si hay ≥2 agentes habilitados y orquestador activo → clasificar
    else if (enabledAgents.orchestrator && enabledCount >= 2) {
      const classifyStart = Date.now();
      console.log("[GenerateResponse] 🧠 PASO 1: Clasificando intención con orquestador...");
      
      try {
        // Schema dinámico — solo incluir intenciones de agentes habilitados
        const intentValues: string[] = [];
        if (enabledSpecialized.brief) intentValues.push("brief");
        if (enabledSpecialized.documentSearch) intentValues.push("document_search");
        intentValues.push("needs_clarification"); // siempre disponible

        const intentSchema = z.object({
          intent: z.enum(intentValues as [string, ...string[]]).describe(
            "La intención del usuario según los servicios habilitados para este cliente"
          ),
        });

        // Clasificación con fallback Gemini → OpenAI
        // Usa misma infraestructura que generateText: geminiConfig/openaiConfig + logLLMAttempt + llmErrors
        let classificationResult: { intent: string } | null = null;
        let orchGeminiError: Error | null = null;

        // Intentar con Gemini (modelo primario de geminiConfig)
        if (geminiEnabled) {
          const geminiStart = Date.now();
          try {
            const classification = await orchestratorAgent.generateObject(
              ctx,
              { threadId },
              { promptMessageId, schema: intentSchema, maxRetries: 0 },
              { storageOptions: { saveMessages: "none" } }
            );
            classificationResult = classification.object as { intent: string };
            logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, true, Date.now() - geminiStart);
          } catch (err) {
            orchGeminiError = err instanceof Error ? err : new Error(String(err));
            logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, false, Date.now() - geminiStart);
            console.error(`[GenerateResponse] ⚠️ Orquestador Gemini falló: ${extractErrorMessage(err)}`);
            
            await ctx.runMutation(internal.data.llmConfig.logLLMError, {
              provider: geminiConfig.provider,
              model: geminiConfig.modelId,
              agentName: "orchestratorAgent",
              errorType: classifyError(err),
              errorMessage: extractErrorMessage(err),
              threadId,
              resolved: false,
              fallbackUsed: undefined,
            });

            // Compartir estado de fallo: si Gemini falló aquí, no reintentar en fase de agente
            geminiEnabled = false;
            console.log("[GenerateResponse] 🔄 Gemini marcado como caído para esta request");
          }
        }

        // Fallback con OpenAI (modelo de openaiConfig)
        if (!classificationResult && openaiEnabled) {
          const openaiStart = Date.now();
          console.log("[GenerateResponse] 🔄 Intentando clasificación con OpenAI (fallback)...");
          try {
            const { args: orchArgs } = await orchestratorAgent.start(
              ctx,
              { promptMessageId, model: openaiConfig.model },
              { threadId, storageOptions: { saveMessages: "none" } }
            );
            const fallbackResult = await generateObject({
              ...orchArgs,
              schema: intentSchema,
              maxRetries: 0,
            });
            classificationResult = fallbackResult.object as { intent: string };
            logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, true, Date.now() - openaiStart);

            // Marcar error de Gemini como resuelto con fallback
            if (orchGeminiError) {
              await ctx.runMutation(internal.data.llmConfig.logLLMError, {
                provider: geminiConfig.provider,
                model: geminiConfig.modelId,
                agentName: "orchestratorAgent",
                errorType: classifyError(orchGeminiError),
                errorMessage: extractErrorMessage(orchGeminiError),
                threadId,
                resolved: true,
                fallbackUsed: openaiConfig.modelId,
              });
            }
          } catch (err) {
            logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, false, Date.now() - openaiStart);
            console.error(`[GenerateResponse] ❌ Orquestador OpenAI también falló: ${extractErrorMessage(err)}`);
            
            await ctx.runMutation(internal.data.llmConfig.logLLMError, {
              provider: openaiConfig.provider,
              model: openaiConfig.modelId,
              agentName: "orchestratorAgent",
              errorType: classifyError(err),
              errorMessage: extractErrorMessage(err),
              threadId,
              resolved: false,
              fallbackUsed: undefined,
            });
          }
        }

        if (!classificationResult) {
          throw new Error("Ambos proveedores fallaron para la clasificación del orquestador");
        }

        orchestratorIntent = classificationResult.intent;
        const classifyTime = Date.now() - classifyStart;
        console.log(`[GenerateResponse] 🧠 Clasificación: "${orchestratorIntent}" (${classifyTime}ms)`);

        // Seleccionar agente según clasificación
        if (orchestratorIntent === "document_search" && enabledSpecialized.documentSearch) {
          selectedAgentKey = "documentSearch";
        } else if (orchestratorIntent === "needs_clarification") {
          selectedAgentKey = "orchestrator";
        } else {
          selectedAgentKey = "brief";
        }
      } catch (error) {
        console.error(`[GenerateResponse] ⚠️ Orquestador falló, usando briefAgent por defecto: ${extractErrorMessage(error)}`);
        selectedAgentKey = "brief";
      }
    }
    // Cuando orquestador está deshabilitado explícitamente
    else if (!enabledAgents.orchestrator) {
      console.log("[GenerateResponse] ⚡ Orquestador deshabilitado, usando briefAgent por defecto");
      selectedAgentKey = "brief";
    }

    // Seleccionar el agente concreto
    const agentMap = {
      brief: { agent: briefAgent, name: "briefAgent" },
      documentSearch: { agent: documentSearchAgent, name: "documentSearchAgent" },
      orchestrator: { agent: orchestratorAgent, name: "orchestratorAgent" },
    };
    const selectedAgent = agentMap[selectedAgentKey].agent;
    const selectedAgentName = agentMap[selectedAgentKey].name;
    
    console.log(`[GenerateResponse] 🎯 Agente seleccionado: ${selectedAgentName}`);
    if (orchestratorIntent) {
      console.log(`[GenerateResponse] 📊 Intent del orquestador: ${orchestratorIntent}`);
    }

    // =====================================================
    // PASO 2: Preparar el contexto con el agente seleccionado
    // =====================================================
    const prepareStart = Date.now();
    console.log("[GenerateResponse] 📍 PASO 2: Preparando contexto...");
    
    const { args: preparedArgs, save } = await selectedAgent.start(
      ctx,
      { promptMessageId },
      { threadId }
    );
    
    const prepareTime = Date.now() - prepareStart;
    console.log(`[GenerateResponse] ✅ Contexto preparado en ${prepareTime}ms`);
    console.log(`[GenerateResponse] 📊 Mensajes: ${preparedArgs.messages?.length || 0}`);

    // =====================================================
    // PASO 3: generateText con fallback Gemini → OpenAI
    // Usa geminiConfig/openaiConfig de llmFallback.ts
    // Registra errores en llmErrors via llmConfig.logLLMError
    // =====================================================
    let result: Awaited<ReturnType<typeof generateText>> | null = null;
    let usedProvider: "gemini" | "openai" | null = null;
    let geminiError: Error | null = null;
    let openaiError: Error | null = null;

    // Intentar con Gemini (geminiConfig)
    if (geminiEnabled) {
      const geminiStart = Date.now();
      console.log("[GenerateResponse] 📍 PASO 3A: Intentando con Gemini...");
      
      try {
        result = await generateText({
          ...preparedArgs,
          model: geminiConfig.model,
          providerOptions: geminiConfig.providerOptions as any,
          maxRetries: 0,
        });
        
        usedProvider = "gemini";
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, true, Date.now() - geminiStart);
        console.log(`[GenerateResponse] ✅ Gemini respondió en ${Date.now() - geminiStart}ms`);
        
      } catch (error) {
        geminiError = error instanceof Error ? error : new Error(String(error));
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, false, Date.now() - geminiStart);
        console.error(`[GenerateResponse] ❌ Gemini falló: ${extractErrorMessage(error)}`);
        
        await ctx.runMutation(internal.data.llmConfig.logLLMError, {
          provider: geminiConfig.provider,
          model: geminiConfig.modelId,
          agentName: selectedAgentName,
          errorType: classifyError(error),
          errorMessage: extractErrorMessage(error),
          threadId,
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    } else {
      console.log("[GenerateResponse] ⏭️ Gemini deshabilitado, saltando...");
    }

    // Fallback con OpenAI (openaiConfig)
    if (!result && openaiEnabled) {
      const openaiStart = Date.now();
      console.log("[GenerateResponse] 📍 PASO 3B: Intentando con OpenAI (fallback)...");
      
      try {
        result = await generateText({
          ...preparedArgs,
          model: openaiConfig.model,
          maxRetries: 0,
        });
        
        usedProvider = "openai";
        logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, true, Date.now() - openaiStart);
        console.log(`[GenerateResponse] ✅ OpenAI respondió en ${Date.now() - openaiStart}ms`);
        
        // Marcar error de Gemini como resuelto con fallback
        if (geminiError) {
          await ctx.runMutation(internal.data.llmConfig.logLLMError, {
            provider: geminiConfig.provider,
            model: geminiConfig.modelId,
            agentName: selectedAgentName,
            errorType: classifyError(geminiError),
            errorMessage: extractErrorMessage(geminiError),
            threadId,
            resolved: true,
            fallbackUsed: openaiConfig.modelId,
          });
        }
        
      } catch (error) {
        openaiError = error instanceof Error ? error : new Error(String(error));
        logLLMAttempt(openaiConfig.provider, openaiConfig.modelId, false, Date.now() - openaiStart);
        console.error(`[GenerateResponse] ❌ OpenAI también falló: ${extractErrorMessage(error)}`);
        
        await ctx.runMutation(internal.data.llmConfig.logLLMError, {
          provider: openaiConfig.provider,
          model: openaiConfig.modelId,
          agentName: selectedAgentName,
          errorType: classifyError(error),
          errorMessage: extractErrorMessage(error),
          threadId,
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    } else if (!result && !openaiEnabled) {
      console.log("[GenerateResponse] ⏭️ OpenAI deshabilitado, saltando...");
    }

    // PASO 4: Si ambos fallaron, lanzar error amigable
    if (!result) {
      const totalTime = Date.now() - startTime;
      const errorMessage = geminiError && openaiError
        ? "Ambos proveedores de IA están temporalmente no disponibles. Por favor, intenta de nuevo en unos minutos."
        : !geminiEnabled && !openaiEnabled
        ? "Los servicios de IA están deshabilitados para mantenimiento. Por favor, intenta de nuevo más tarde."
        : "Error al generar respuesta. Por favor, intenta de nuevo.";
      
      console.error("\n========================================");
      console.error(`[GenerateResponse] ❌ TODOS LOS PROVEEDORES FALLARON después de ${totalTime}ms`);
      console.error(`[GenerateResponse] Gemini error: ${geminiError?.message || "deshabilitado"}`);
      console.error(`[GenerateResponse] OpenAI error: ${openaiError?.message || "deshabilitado"}`);
      console.error("========================================\n");
      
      await saveMessage(ctx, components.agent, {
        threadId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `⚠️ ${errorMessage}` }],
        },
      });
      
      throw new Error(errorMessage);
    }

    // PASO 5: Guardar el resultado exitoso
    const saveStart = Date.now();
    console.log("[GenerateResponse] 📍 PASO 4: Guardando resultado...");
    
    for (const step of result.steps) {
      await save({ step });
    }
    
    const saveTime = Date.now() - saveStart;
    const totalTime = Date.now() - startTime;
    
    console.log("\n========================================");
    console.log(`[GenerateResponse] 🏁 RESUMEN:`);
    console.log(`[GenerateResponse]    - Agente: ${selectedAgentName}`);
    console.log(`[GenerateResponse]    - Intent: ${orchestratorIntent || "short-circuit"}`);
    console.log(`[GenerateResponse]    - Proveedor LLM: ${usedProvider}`);
    console.log(`[GenerateResponse]    - Preparación: ${prepareTime}ms`);
    console.log(`[GenerateResponse]    - Guardado: ${saveTime}ms`);
    console.log(`[GenerateResponse]    - TOTAL: ${totalTime}ms (${(totalTime/1000).toFixed(1)}s)`);
    console.log(`[GenerateResponse] 📝 Respuesta: ${result.text?.substring(0, 100)}...`);
    console.log("========================================\n");

    return {
      text: result.text,
      promptMessageId,
      provider: usedProvider,
      agent: selectedAgentName,
      intent: orchestratorIntent,
    };
  },
});

// Listar mensajes de un thread
export const listThreadMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { threadId, paginationOpts }) => {
    const messages = await listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts,
    });
    
    return messages;
  },
});

// Listar todos los threads de chat del usuario (para historial)
export const listChatThreads = query({
  args: {
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let threads;
    
    if (args.userId) {
      threads = await ctx.db
        .query("chatThreads")
        .withIndex("by_user", (q) => q.eq("userId", args.userId!))
        .order("desc")
        .collect();
    } else {
      threads = await ctx.db
        .query("chatThreads")
        .order("desc")
        .collect();
    }
    
    return threads;
  },
});

// Obtener el thread de chat asociado a un threadId específico
export const getChatThreadInfo = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    
    return chatThread;
  },
});
