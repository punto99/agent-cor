// Shared by chat selection, message validation and the model-input budget.
// Task comments and evaluation uploads keep their own count limits.
export const CHAT_MAX_FILES = 5;
export const CHAT_MAX_FILE_SIZE_MB = 20;
export const CHAT_MAX_FILE_SIZE_BYTES = CHAT_MAX_FILE_SIZE_MB * 1024 * 1024;
export const CHAT_MAX_TOTAL_SIZE_MB = 40;
export const CHAT_MAX_TOTAL_SIZE_BYTES = CHAT_MAX_TOTAL_SIZE_MB * 1_000_000;

export class ChatUploadLimitError extends Error {}

export function base64ByteLength(value: string): number {
  const data = value.slice(value.indexOf(",") + 1).replace(/\s/g, "");
  return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function assertChatFileSizes(files: Array<{ size: number }>) {
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > CHAT_MAX_FILE_SIZE_BYTES) {
      throw new ChatUploadLimitError(`Cada archivo debe tener contenido y pesar hasta ${CHAT_MAX_FILE_SIZE_MB} MiB.`);
    }
  }
  if (files.reduce((total, file) => total + file.size, 0) > CHAT_MAX_TOTAL_SIZE_BYTES) {
    throw new ChatUploadLimitError(`Los archivos del mensaje no pueden superar ${CHAT_MAX_TOTAL_SIZE_MB} MB en total.`);
  }
}

export function assertChatOriginalCount(count: number) {
  if (count > CHAT_MAX_FILES) {
    throw new ChatUploadLimitError(`Podés adjuntar hasta ${CHAT_MAX_FILES} archivos por mensaje.`);
  }
}

export function selectedChatFileSizes(files: Array<{ base64: string; extractedImages?: Array<{ data: string }> }>) {
  return files.flatMap(file => [
    { size: base64ByteLength(file.base64) },
    ...(file.extractedImages ?? []).map(image => ({ size: base64ByteLength(image.data) })),
  ]);
}
