/**
 * Tipos y constantes para el Chat
 */

// Declaración de tipos para Web Speech API
export interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

export interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

export interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: Event & { error: string }) => void;
  onend: () => void;
  onstart: () => void;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// Tipos de archivo soportados
export const SUPPORTED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  // Audio (Gemini soporta estos formatos)
  "audio/mpeg", // mp3
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
];

export const FILE_ACCEPT =
  "image/*,application/pdf,.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac";

export { CHAT_MAX_FILES as MAX_FILES } from "@/config/chatUploads";

export type ExtractedImage = {
  data: string; // base64 sin prefijo
  mimeType: string;
};

export type FileInfo = {
  name: string;
  type: string;
  isImage: boolean;
  isDocument: boolean;
  isAudio: boolean;
  base64: string;
  // Contenido extraído de Word
  extractedMarkdown?: string;
  extractedImages?: ExtractedImage[];
};

export type MessagePart = {
  type: "text" | "file";
  text?: string;
  url?: string;
  mediaType?: string;
  state?: string;
};

export type ReasoningDetail = {
  type: "text";
  text: string;
};

export type Message = {
  key: string;
  role: "user" | "assistant";
  content: string | MessagePart[];
  _creationTime: number;
  agentName?: string;
  status?: string;
  reasoning?: string;
  reasoningDetails?: ReasoningDetail[];
};

export interface ChatInterfaceProps {
  threadId?: string | null;
  onThreadChange?: (threadId: string | null) => void;
  /** Ocultar el header con botón "Nueva conversación" (para uso en workspace) */
  hideHeader?: boolean;
}
