"use node";

import { getFile } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";

const GOOGLE_FILES_API_BASE_URL = "https://generativelanguage.googleapis.com";
const GOOGLE_FILES_CACHE_TTL_MS = 47 * 60 * 60 * 1000;
const GOOGLE_FILES_FETCH_TIMEOUT_MS = 60_000;
const GOOGLE_FILES_ACTIVE_TIMEOUT_MS = 60_000;

type EvaluationFileInfo = {
  fileId: string;
  storageId: string;
  filename?: string;
  mimeType: string;
  sourceUrl: string;
};

type GoogleFileUploadResult = {
  name: string;
  uri: string;
  mimeType: string;
  state: string;
  sizeBytes?: number;
};

function getGoogleApiKey(): string {
  const apiKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Google Gemini API key no configurada (GOOGLE_GENERATIVE_AI_API_KEY)",
    );
  }
  return apiKey;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
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

async function parseJsonResponse(
  response: Response,
  label: string,
): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} falló (${response.status}): ${text}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `${label} devolvió JSON inválido: ${text.slice(0, 200)}`,
    );
  }
}

function normalizeGoogleFile(raw: any): GoogleFileUploadResult {
  const file = raw?.file || raw;
  const name = String(file?.name || "");
  const uri =
    String(file?.uri || file?.fileUri || "") ||
    (name ? `${GOOGLE_FILES_API_BASE_URL}/v1beta/${name}` : "");

  if (!name || !uri) {
    throw new Error(
      `Respuesta inválida de Google Files API: ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }

  return {
    name,
    uri,
    mimeType: String(file?.mimeType || file?.mime_type || ""),
    state: String(file?.state || "ACTIVE"),
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
  googleFileName: string,
): Promise<GoogleFileUploadResult> {
  const response = await fetchWithTimeout(
    `${GOOGLE_FILES_API_BASE_URL}/v1beta/${googleFileName}`,
    { headers: { "x-goog-api-key": apiKey } },
    GOOGLE_FILES_FETCH_TIMEOUT_MS,
    "Google Files get",
  );
  return normalizeGoogleFile(
    await parseJsonResponse(response, "Google Files get"),
  );
}

async function waitForGoogleFileActive(
  apiKey: string,
  initialFile: GoogleFileUploadResult,
): Promise<GoogleFileUploadResult> {
  let file = initialFile;
  const startedAt = Date.now();

  while (file.state === "PROCESSING") {
    if (Date.now() - startedAt > GOOGLE_FILES_ACTIVE_TIMEOUT_MS) {
      throw new Error(
        `Google Files API no activó el archivo dentro de ${GOOGLE_FILES_ACTIVE_TIMEOUT_MS}ms`,
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
  fileInfo: EvaluationFileInfo,
): Promise<GoogleFileUploadResult> {
  const apiKey = getGoogleApiKey();
  const displayName = fileInfo.filename || fileInfo.fileId;

  console.log(
    `[EvaluatorFiles] Subiendo fileId=${fileInfo.fileId} filename=${displayName} mimeType=${fileInfo.mimeType} bytes=${blob.size}`,
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
    "Google Files upload start",
  );

  if (!startResponse.ok) {
    const text = await startResponse.text();
    throw new Error(
      `Google Files upload start falló (${startResponse.status}): ${text}`,
    );
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
    "Google Files upload finalize",
  );

  const uploaded = normalizeGoogleFile(
    await parseJsonResponse(uploadResponse, "Google Files upload finalize"),
  );
  const activeFile = await waitForGoogleFileActive(apiKey, uploaded);

  return {
    ...activeFile,
    mimeType: activeFile.mimeType || fileInfo.mimeType,
    sizeBytes: activeFile.sizeBytes || blob.size,
  };
}

async function ensureGoogleFileForEvaluation(
  ctx: any,
  fileInfo: EvaluationFileInfo,
): Promise<string> {
  const now = Date.now();
  const cached = await ctx.runQuery(
    (internal as any).data.files.getValidGoogleFileUpload,
    { fileId: fileInfo.fileId, now },
  );

  if (cached?.googleFileUri) {
    console.log(
      `[EvaluatorFiles] Reusando cache fileId=${fileInfo.fileId} googleFileName=${cached.googleFileName}`,
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

async function getEvaluationFileInfos(
  ctx: any,
  fileIds: string[],
): Promise<EvaluationFileInfo[]> {
  return await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = await getFile(ctx, components.agent, fileId);
      return {
        fileId,
        storageId: String(fileData.file.storageId),
        filename: fileData.file.filename,
        mimeType: String(fileData.filePart.mediaType),
        sourceUrl: String(fileData.file.url),
      };
    }),
  );
}

function getPartUrl(part: any): string | null {
  const value = part?.type === "image" ? part.image : part?.data;
  if (value instanceof URL) return value.toString();
  if (typeof value !== "string") return null;

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

/**
 * Reemplaza exclusivamente los archivos de esta evaluación por referencias
 * temporales de Google Files. Los argumentos originales se conservan para el
 * fallback de OpenAI.
 */
export async function prepareEvaluatorArgsForGemini(
  ctx: any,
  preparedArgs: any,
  fileIds: string[],
): Promise<any> {
  if (fileIds.length === 0 || !Array.isArray(preparedArgs?.messages)) {
    return preparedArgs;
  }

  const fileInfos = await getEvaluationFileInfos(ctx, fileIds);
  const bySourceUrl = new Map(fileInfos.map((file) => [file.sourceUrl, file]));
  const googleUris = new Map(
    await Promise.all(
      fileInfos.map(async (fileInfo) => [
        fileInfo.fileId,
        await ensureGoogleFileForEvaluation(ctx, fileInfo),
      ] as const),
    ),
  );

  let replacedCount = 0;
  const messages = preparedArgs.messages.map((message: any) => {
    if (!Array.isArray(message?.content)) return message;

    let changed = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== "file" && part?.type !== "image") return part;

      const sourceUrl = getPartUrl(part);
      const fileInfo = sourceUrl ? bySourceUrl.get(sourceUrl) : undefined;
      const googleUri = fileInfo ? googleUris.get(fileInfo.fileId) : undefined;
      if (!googleUri) return part;

      changed = true;
      replacedCount++;
      return {
        ...part,
        [part.type === "image" ? "image" : "data"]: new URL(googleUri),
      };
    });

    return changed ? { ...message, content } : message;
  });

  if (replacedCount !== fileIds.length) {
    throw new Error(
      `No se pudieron preparar todos los archivos para Gemini: ${replacedCount}/${fileIds.length}`,
    );
  }

  console.log(
    `[EvaluatorFiles] Prompt preparado con ${replacedCount} archivo(s) de Google Files`,
  );
  return { ...preparedArgs, messages };
}
