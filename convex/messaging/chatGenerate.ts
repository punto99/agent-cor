"use node";

// convex/messaging/chatGenerate.ts
// Generación de respuestas del agente — separado de chat.ts para usar Node.js runtime (512MB)
// IMPORTANTE: Este archivo usa "use node" porque el AI SDK necesita descargar archivos
// (imágenes, PDFs) en memoria para enviarlos al LLM. Con el Convex runtime (64MB)
// archivos de ~3MB+ causan "out of memory". Node.js runtime da 512MB.
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { briefAgent } from "../agents/agent";
import { externalBriefAgent } from "../agents/externalBriefAgent";
import { orchestratorAgent } from "../agents/orchestratorAgent";
import { documentSearchAgent } from "../agents/documentSearchAgent";
import { components, internal } from "../_generated/api";
import { getFile, listMessages, saveMessage } from "@convex-dev/agent";
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
const GOOGLE_FILES_API_BASE_URL = "https://generativelanguage.googleapis.com";
const GOOGLE_FILES_CACHE_TTL_MS = 47 * 60 * 60 * 1000; // Google retiene archivos 48h; usamos margen.
const GOOGLE_FILES_FETCH_TIMEOUT_MS = 60_000;
const GOOGLE_FILES_ACTIVE_TIMEOUT_MS = 60_000;

type ChatFileInfo = {
  fileId: string;
  storageId: string;
  filename?: string;
  mimeType: string;
};

type GoogleFileUploadResult = {
  name: string;
  uri: string;
  mimeType: string;
  state: string;
  sizeBytes?: number;
};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown";
  return `${bytes}B (${(bytes / 1024 / 1024).toFixed(2)}MB)`;
}

function getGoogleApiKey(): string {
  const apiKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Google Gemini API key no configurada (GOOGLE_GENERATIVE_AI_API_KEY)"
    );
  }
  return apiKey;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} falló: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response: Response, label: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} falló (${response.status}): ${text}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} devolvió JSON inválido: ${text.slice(0, 200)}`);
  }
}

function normalizeGoogleFile(raw: any): GoogleFileUploadResult {
  const file = raw?.file || raw;
  const name = String(file?.name || "");
  const uri =
    String(file?.uri || file?.fileUri || "") ||
    (name ? `${GOOGLE_FILES_API_BASE_URL}/v1beta/${name}` : "");
  const mimeType = String(file?.mimeType || file?.mime_type || "");
  const state = String(file?.state || "ACTIVE");

  if (!name || !uri) {
    throw new Error(`Respuesta inválida de Google Files API: ${JSON.stringify(raw).slice(0, 500)}`);
  }

  return {
    name,
    uri,
    mimeType,
    state,
    sizeBytes:
      typeof file?.sizeBytes === "number"
        ? file.sizeBytes
        : typeof file?.size_bytes === "number"
        ? file.size_bytes
        : undefined,
  };
}

async function getGoogleFileMetadata(
  apiKey: string,
  googleFileName: string
): Promise<GoogleFileUploadResult> {
  const response = await fetchWithTimeout(
    `${GOOGLE_FILES_API_BASE_URL}/v1beta/${googleFileName}`,
    { headers: { "x-goog-api-key": apiKey } },
    GOOGLE_FILES_FETCH_TIMEOUT_MS,
    "Google Files get"
  );
  return normalizeGoogleFile(await parseJsonResponse(response, "Google Files get"));
}

async function waitForGoogleFileActive(
  apiKey: string,
  initialFile: GoogleFileUploadResult
): Promise<GoogleFileUploadResult> {
  let file = initialFile;
  const startedAt = Date.now();

  while (file.state === "PROCESSING") {
    if (Date.now() - startedAt > GOOGLE_FILES_ACTIVE_TIMEOUT_MS) {
      throw new Error(
        `Google Files API no activó el archivo dentro de ${GOOGLE_FILES_ACTIVE_TIMEOUT_MS}ms`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    file = await getGoogleFileMetadata(apiKey, file.name);
  }

  if (file.state === "FAILED") {
    throw new Error(`Google Files API marcó el archivo como FAILED: ${file.name}`);
  }

  return file;
}

async function uploadBlobToGoogleFiles(
  blob: Blob,
  fileInfo: ChatFileInfo
): Promise<GoogleFileUploadResult> {
  const apiKey = getGoogleApiKey();
  const startedAt = Date.now();
  const displayName = fileInfo.filename || fileInfo.fileId;

  console.log(
    `[GoogleFiles] Subiendo fileId=${fileInfo.fileId} filename=${displayName} mimeType=${fileInfo.mimeType} bytes=${formatBytes(blob.size)}`
  );

  const startResponse = await fetchWithTimeout(
    `${GOOGLE_FILES_API_BASE_URL}/upload/v1beta/files`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": fileInfo.mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
    GOOGLE_FILES_FETCH_TIMEOUT_MS,
    "Google Files upload start"
  );

  if (!startResponse.ok) {
    const text = await startResponse.text();
    throw new Error(`Google Files upload start falló (${startResponse.status}): ${text}`);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Google Files upload start no devolvió x-goog-upload-url");
  }

  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(blob.size),
        "Content-Type": fileInfo.mimeType,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: blob,
    },
    GOOGLE_FILES_FETCH_TIMEOUT_MS,
    "Google Files upload finalize"
  );

  const uploaded = normalizeGoogleFile(
    await parseJsonResponse(uploadResponse, "Google Files upload finalize")
  );
  const activeFile = await waitForGoogleFileActive(apiKey, uploaded);

  console.log(
    `[GoogleFiles] Archivo listo fileId=${fileInfo.fileId} googleFileName=${activeFile.name} state=${activeFile.state} durationMs=${Date.now() - startedAt}`
  );

  return {
    ...activeFile,
    mimeType: activeFile.mimeType || fileInfo.mimeType,
    sizeBytes: activeFile.sizeBytes || blob.size,
  };
}

async function ensureGoogleFileForGemini(
  ctx: any,
  fileInfo: ChatFileInfo
): Promise<string> {
  const now = Date.now();
  const cached = await ctx.runQuery(
    (internal as any).data.files.getValidGoogleFileUpload,
    { fileId: fileInfo.fileId, now }
  );

  if (cached?.googleFileUri) {
    console.log(
      `[GoogleFiles] Reusando cache fileId=${fileInfo.fileId} googleFileName=${cached.googleFileName} expiresAt=${new Date(cached.expiresAt).toISOString()}`
    );
    return cached.googleFileUri;
  }

  let blob: Blob | null = null;
  try {
    blob = await ctx.storage.get(fileInfo.storageId as any);
    if (!blob) {
      throw new Error(`Blob no encontrado para storageId=${fileInfo.storageId}`);
    }

    const uploadedAt = Date.now();
    const googleFile = await uploadBlobToGoogleFiles(blob, fileInfo);

    await ctx.runMutation((internal as any).data.files.saveGoogleFileUpload, {
      fileId: fileInfo.fileId,
      storageId: fileInfo.storageId,
      filename: fileInfo.filename,
      mimeType: fileInfo.mimeType,
      sizeBytes: blob.size,
      googleFileName: googleFile.name,
      googleFileUri: googleFile.uri,
      state: googleFile.state,
      uploadedAt,
      expiresAt: uploadedAt + GOOGLE_FILES_CACHE_TTL_MS,
    });

    return googleFile.uri;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation((internal as any).data.files.markGoogleFileUploadError, {
      fileId: fileInfo.fileId,
      storageId: fileInfo.storageId,
      filename: fileInfo.filename,
      mimeType: fileInfo.mimeType,
      sizeBytes: blob?.size,
      error: message,
    });
    throw error;
  }
}

function getPartUrl(part: any): string | null {
  const value = part?.type === "image" ? part.image : part?.data;
  if (value instanceof URL) return value.toString();
  if (typeof value === "string") {
    try {
      return new URL(value).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function getFileSignature(fileInfo: ChatFileInfo): string {
  return `${fileInfo.filename || ""}|${fileInfo.mimeType}`;
}

async function getChatUserFileMaps(ctx: any, threadId: string): Promise<{
  byUrl: Map<string, ChatFileInfo>;
  bySignature: Map<string, ChatFileInfo[]>;
}> {
  const messagesResult = await listMessages(ctx, components.agent, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

  const userFileIds = new Set<string>();
  for (const msg of messagesResult.page as any[]) {
    if (msg?.message?.role !== "user") continue;
    if (!Array.isArray(msg.fileIds)) continue;
    for (const fileId of msg.fileIds) userFileIds.add(String(fileId));
  }

  const byUrl = new Map<string, ChatFileInfo>();
  const bySignature = new Map<string, ChatFileInfo[]>();

  for (const fileId of userFileIds) {
    try {
      const fileData = await getFile(ctx, components.agent, fileId);
      const fileInfo: ChatFileInfo = {
        fileId,
        storageId: String(fileData.file.storageId),
        filename: fileData.file.filename,
        mimeType:
          String((fileData.filePart as any)?.mediaType || "") ||
          "application/octet-stream",
      };

      byUrl.set(String(fileData.file.url), fileInfo);
      const signature = getFileSignature(fileInfo);
      bySignature.set(signature, [...(bySignature.get(signature) || []), fileInfo]);
    } catch (error) {
      console.warn(
        `[GoogleFiles] No se pudo mapear fileId=${fileId}: ${extractErrorMessage(error)}`
      );
    }
  }

  return { byUrl, bySignature };
}

async function prepareArgsForGeminiFiles(
  ctx: any,
  threadId: string,
  preparedArgs: any
): Promise<any> {
  const messages = Array.isArray(preparedArgs?.messages)
    ? preparedArgs.messages
    : [];
  if (messages.length === 0) return preparedArgs;

  const fileMaps = await getChatUserFileMaps(ctx, threadId);
  let replacedCount = 0;

  const transformedMessages = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      transformedMessages.push(message);
      continue;
    }

    let messageChanged = false;
    const transformedContent = [];

    for (const part of message.content) {
      if (part?.type !== "file" && part?.type !== "image") {
        transformedContent.push(part);
        continue;
      }

      const partUrl = getPartUrl(part);
      let fileInfo = partUrl ? fileMaps.byUrl.get(partUrl) : undefined;

      if (!fileInfo) {
        const signature = `${part.filename || ""}|${part.mediaType || ""}`;
        const candidates = fileMaps.bySignature.get(signature);
        fileInfo = candidates?.shift();
      }

      if (!fileInfo) {
        transformedContent.push(part);
        console.warn(
          `[GoogleFiles] Parte de archivo sin fileId de usuario; se deja sin modificar filename=${part.filename || "none"} mediaType=${part.mediaType || "unknown"} url=${partUrl || "none"}`
        );
        continue;
      }

      const googleFileUri = await ensureGoogleFileForGemini(ctx, fileInfo);
      const dataField = part.type === "image" ? "image" : "data";
      transformedContent.push({
        ...part,
        [dataField]: new URL(googleFileUri),
      });
      messageChanged = true;
      replacedCount++;
    }

    transformedMessages.push(
      messageChanged ? { ...message, content: transformedContent } : message
    );
  }

  if (replacedCount > 0) {
    console.log(
      `[GoogleFiles] Prompt Gemini preparado con ${replacedCount} archivo(s) usando Google Files API`
    );
    return { ...preparedArgs, messages: transformedMessages };
  }

  return preparedArgs;
}

// Generar respuesta del agente (interna, llamada async)
// CON ORQUESTADOR: Clasifica intención → enruta al agente correcto
// CON SISTEMA DE FALLBACK: Gemini -> OpenAI GPT-5.5
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
    const accessProfile = await ctx.runQuery(internal.data.userAccess.getAccessProfileByThread, {
      threadId,
    });
    const isExternalUser = accessProfile?.kind === "external";

    const enabledSpecialized = {
      brief: enabledAgents.brief,
      documentSearch: enabledAgents.documentSearch,
    };
    const enabledCount = Object.values(enabledSpecialized).filter(Boolean).length;

    let selectedAgentKey: "brief" | "documentSearch" | "orchestrator" | "externalBrief" = "brief"; // default
    let orchestratorIntent: string | null = null;

    if (isExternalUser) {
      selectedAgentKey = "externalBrief";
      console.log("[GenerateResponse] Usuario externo detectado, usando externalBriefAgent");
    }
    // Short-circuit — si solo 1 agente habilitado, usarlo directamente
    else if (enabledCount <= 1) {
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
            const { args: orchArgs } = await orchestratorAgent.start(
              ctx,
              { promptMessageId, model: geminiConfig.model },
              { threadId, storageOptions: { saveMessages: "none" } }
            );
            const geminiOrchArgs = await prepareArgsForGeminiFiles(
              ctx,
              threadId,
              orchArgs
            );
            const classification = await generateObject({
              ...geminiOrchArgs,
              schema: intentSchema,
              providerOptions: geminiConfig.providerOptions as any,
              maxRetries: 0,
            });
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
      externalBrief: { agent: externalBriefAgent, name: "externalBriefAgent" },
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
        const geminiPreparedArgs = await prepareArgsForGeminiFiles(
          ctx,
          threadId,
          preparedArgs
        );
        result = await generateText({
          ...geminiPreparedArgs,
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
