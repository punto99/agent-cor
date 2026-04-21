"use node";

// convex/messaging/chatGenerate.ts
// Generación de respuestas del agente — separado de chat.ts para usar Node.js runtime (512MB)
// IMPORTANTE: Este archivo usa "use node" porque el AI SDK necesita descargar archivos
// (imágenes, PDFs) en memoria para enviarlos al LLM. Con el Convex runtime (64MB)
// archivos de ~3MB+ causan "out of memory". Node.js runtime da 512MB.
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { briefAgent } from "../agents/agent";
import { orchestratorAgent } from "../agents/orchestratorAgent";
import { documentSearchAgent } from "../agents/documentSearchAgent";
import { components, internal } from "../_generated/api";
import { listMessages, saveMessage } from "@convex-dev/agent";
import { enabledAgents } from "../lib/serverConfig";
import { 
  classifyError, 
  extractErrorMessage,
  logLLMAttempt,
  geminiConfig,
  openaiConfig,
  LLM_CALL_TIMEOUT_MS,
} from "../lib/llmFallback";

const AUDIO_RESTRICTED_MESSAGE =
  "En este momento las capacidades de audio se encuentran restringidas. Por favor, continúa la conversación por escrito y con gusto te ayudo.";

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

    // =========================================================
    // TRY-CATCH GLOBAL: Si algo falla, guardar mensaje de error
    // para que el usuario vea feedback en vez de un loader eterno.
    // =========================================================
    try {

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

    // Detectar si el mensaje actual fue enviado con audio
    let hasAudioInput = false;
    try {
      const messagesResult = await listMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      });

      const promptMessage = messagesResult.page.find((m: any) => {
        const id = m?._id || m?.id || m?.messageId;
        return id === promptMessageId;
      }) as any;

      const contentParts = Array.isArray(promptMessage?.message?.content)
        ? promptMessage.message.content
        : [];

      const hasAudioInContent = contentParts.some((part: any) => {
        const partType = String(part?.type || "").toLowerCase();
        const mimeType = String(part?.mimeType || "").toLowerCase();
        return partType === "file" && mimeType.startsWith("audio/");
      });

      hasAudioInput =
        hasAudioInContent ||
        Boolean(promptMessage?.hasAudioInput ?? promptMessage?.metadata?.hasAudioInput);

      console.log(`[GenerateResponse] 🎤 Input con audio: ${hasAudioInput}`);
    } catch (error) {
      console.warn(
        `[GenerateResponse] ⚠️ No se pudo determinar si el input tiene audio: ${extractErrorMessage(error)}`
      );
    }

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
        if (!classificationResult && openaiEnabled && !hasAudioInput) {
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
        } else if (!classificationResult && openaiEnabled && hasAudioInput) {
          console.log(
            "[GenerateResponse] ⏭️ Fallback de clasificación a OpenAI omitido (input de audio)."
          );
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
    // PATH SYNC: Todos los agentes usan generateText
    // (streaming removido — causaba race conditions en el AI SDK
    // con tools multi-step: "enqueue" / "tp(...).map" errors)
    // =====================================================
    console.log(`[GenerateResponse] 📝 Usando path SYNC para ${selectedAgentName}`);

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

      // Abort timeout: si Gemini tarda >120s, abortar y caer al fallback OpenAI
      const syncGeminiController = new AbortController();
      const syncGeminiTimer = setTimeout(() => {
        console.warn(`[GenerateResponse] ⏱️ Gemini generateText excedió ${LLM_CALL_TIMEOUT_MS / 1000}s — abortando`);
        syncGeminiController.abort();
      }, LLM_CALL_TIMEOUT_MS);

      try {
        result = await generateText({
          ...preparedArgs,
          model: geminiConfig.model,
          providerOptions: geminiConfig.providerOptions as any,
          maxRetries: 0,
          abortSignal: syncGeminiController.signal,
        });
        clearTimeout(syncGeminiTimer);

        usedProvider = "gemini";
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, true, Date.now() - geminiStart);
        console.log(`[GenerateResponse] ✅ Gemini respondió en ${Date.now() - geminiStart}ms`);
        
      } catch (error) {
        clearTimeout(syncGeminiTimer);
        geminiError = error instanceof Error ? error : new Error(String(error));
        logLLMAttempt(geminiConfig.provider, geminiConfig.modelId, false, Date.now() - geminiStart);
        const isAbort = geminiError.name === "AbortError";
        console.error(`[GenerateResponse] ❌ Gemini falló${isAbort ? " (timeout)" : ""}: ${extractErrorMessage(error)}`);
        
        await ctx.runMutation(internal.data.llmConfig.logLLMError, {
          provider: geminiConfig.provider,
          model: geminiConfig.modelId,
          agentName: selectedAgentName,
          errorType: classifyError(error),
          errorMessage: isAbort ? `Timeout: Gemini no respondió en ${LLM_CALL_TIMEOUT_MS / 1000}s` : extractErrorMessage(error),
          threadId,
          resolved: false,
          fallbackUsed: undefined,
        });
      }
    } else {
      console.log("[GenerateResponse] ⏭️ Gemini deshabilitado, saltando...");
    }

    // Fallback con OpenAI (openaiConfig)
    if (!result && openaiEnabled && hasAudioInput) {
      console.log("[GenerateResponse] ⏭️ Fallback a OpenAI omitido (input de audio).");

      await saveMessage(ctx, components.agent, {
        threadId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `⚠️ ${AUDIO_RESTRICTED_MESSAGE}` }],
        },
      });

      return {
        text: AUDIO_RESTRICTED_MESSAGE,
        promptMessageId,
        provider: usedProvider,
        agent: selectedAgentName,
        intent: orchestratorIntent,
      };
    }

    if (!result && openaiEnabled) {
      const openaiStart = Date.now();
      console.log("[GenerateResponse] 📍 PASO 3B: Intentando con OpenAI (fallback)...");

      // Abort timeout para OpenAI también
      const syncOpenaiController = new AbortController();
      const syncOpenaiTimer = setTimeout(() => {
        console.warn(`[GenerateResponse] ⏱️ OpenAI generateText excedió ${LLM_CALL_TIMEOUT_MS / 1000}s — abortando`);
        syncOpenaiController.abort();
      }, LLM_CALL_TIMEOUT_MS);

      try {
        result = await generateText({
          ...preparedArgs,
          model: openaiConfig.model,
          maxRetries: 0,
          abortSignal: syncOpenaiController.signal,
        });
        clearTimeout(syncOpenaiTimer);
        
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
        clearTimeout(syncOpenaiTimer);
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

    } catch (globalError) {
      // =========================================================
      // CATCH GLOBAL: Guardar un mensaje de error para el usuario
      // para que el frontend muestre feedback en vez de un loader eterno.
      // =========================================================
      const totalTime = Date.now() - startTime;
      const errMsg = globalError instanceof Error ? globalError.message : String(globalError);
      console.error(`\n========================================`);
      console.error(`[GenerateResponse] 💥 ERROR GLOBAL después de ${totalTime}ms`);
      console.error(`[GenerateResponse] Error: ${errMsg}`);
      console.error(`========================================\n`);

      // Intentar guardar un mensaje de error visible para el usuario
      try {
        await saveMessage(ctx, components.agent, {
          threadId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `⚠️ Ocurrió un error procesando tu mensaje. Por favor, intenta de nuevo.` }],
          },
        });
      } catch (saveErr) {
        console.error("[GenerateResponse] ❌ No se pudo guardar mensaje de error:", saveErr);
      }

      // Re-throw para que Convex lo registre como action fallida
      throw globalError;
    }
  },
});
