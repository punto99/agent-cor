"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { useUIMessages } from "@convex-dev/agent/react";
import { api } from "@/convex/_generated/api";
import mammoth from "mammoth";
import TurndownService from "turndown";

// Importar componentes extraídos
import { ChatMessageList } from "./components/chat/ChatMessageList";
import { ChatInputForm } from "./components/chat/ChatInputForm";
import { FileInfo, ExtractedImage } from "./components/chat/FilePreviewList";
import { Message } from "./components/chat/MessageContent";

// =============================================================================
// Tipos para Web Speech API
// =============================================================================
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
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

// =============================================================================
// Constantes
// =============================================================================
const SUPPORTED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "audio/mpeg",
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

const MAX_FILES = 3;
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// =============================================================================
// Utilidades
// =============================================================================
import { compressImage, base64ToBlob } from "./lib/imageCompression";

// =============================================================================
// Props
// =============================================================================
interface ChatInterfaceProps {
  threadId?: string | null;
  onThreadChange?: (threadId: string | null) => void;
  hideHeader?: boolean;
}

// =============================================================================
// Componente Principal
// =============================================================================
export default function ChatInterface({
  threadId: initialThreadId,
  onThreadChange,
  hideHeader = false,
}: ChatInterfaceProps) {
  // Estado del thread
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(
    initialThreadId || null,
  );
  const [input, setInput] = useState("");
  const [isCreatingThread, setIsCreatingThread] = useState(false);

  // Estado de archivos
  const [selectedFiles, setSelectedFiles] = useState<FileInfo[]>([]);
  const [isUploadingFile, setIsUploadingFile] = useState(false);

  // Estado de grabación de voz
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");

  // Refs
  const speechRecognitionRef = useRef<SpeechRecognition | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Mutations y queries
  const createThread = useMutation(api.messaging.threads.createThread);
  const sendMessage = useMutation(api.messaging.chat.sendMessage);
  const generateUploadUrl = useMutation(api.data.files.generateUploadUrl);
  const registerUploadedFile = useAction(api.data.files.registerUploadedFile);
  const latestThreadId = useQuery(api.messaging.chat.getLatestThread, {
    userId: undefined,
  });

  const { results: uiMessages, status: streamStatus } = useUIMessages(
    api.messaging.chat.listThreadMessages,
    currentThreadId ? { threadId: currentThreadId as any } : "skip",
    { initialNumItems: 50, stream: true },
  );

  // Auto-scroll al final cuando hay mensajes nuevos
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages]);

  // Sincronizar con threadId inicial
  useEffect(() => {
    if (initialThreadId && initialThreadId !== currentThreadId) {
      setCurrentThreadId(initialThreadId);
    }
  }, [initialThreadId]);

  // Cargar el último thread (solo si no hay threadId inicial)
  useEffect(() => {
    if (!initialThreadId && latestThreadId && !currentThreadId) {
      setCurrentThreadId(latestThreadId);
      onThreadChange?.(latestThreadId);
    }
  }, [latestThreadId, currentThreadId, onThreadChange, initialThreadId]);

  // Notificar cambios de thread
  useEffect(() => {
    onThreadChange?.(currentThreadId);
  }, [currentThreadId, onThreadChange]);

  // ===========================================================================
  // Handlers de envío de mensaje
  // ===========================================================================
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const voiceText = finalTranscript.trim();
    const textInput = input.trim();
    const combinedInput = voiceText
      ? textInput
        ? `${textInput}\n\n[Mensaje de voz]: ${voiceText}`
        : voiceText
      : textInput;

    if ((!combinedInput && selectedFiles.length === 0) || !currentThreadId)
      return;

    const currentInput = combinedInput;
    const currentFiles = [...selectedFiles];
    setInput("");
    setFinalTranscript("");
    setInterimTranscript("");
    setSelectedFiles([]);

    try {
      const fileIds: string[] = [];
      const extractedTexts: string[] = [];

      if (currentFiles.length > 0) {
        setIsUploadingFile(true);
        for (const file of currentFiles) {
          // 1. Convertir base64 (preview) a Blob binario
          const blob = base64ToBlob(file.base64);
          // Para imágenes, blob.type refleja el formato real tras compresión (JPEG)
          const actualMimeType = blob.type || file.type;

          // 2. Subir binario directo a Convex Storage (sin límite de args)
          const uploadUrl = await generateUploadUrl();
          const uploadResp = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": actualMimeType },
            body: blob,
          });
          if (!uploadResp.ok)
            throw new Error("Error subiendo archivo a storage");
          const { storageId } = await uploadResp.json();

          // 3. Registrar en el sistema de archivos del agente
          const result = await registerUploadedFile({
            storageId,
            filename: file.name,
            mimeType: actualMimeType,
            extractedMarkdown: file.extractedMarkdown,
            extractedImages: file.extractedImages,
          });

          // Siempre incluir el archivo original (para adjuntar a la tarea)
          // chat.ts ya se encarga de omitir Word/PDF al construir el contenido para el LLM
          fileIds.push(result.fileId);

          if (result.extractedImageFileIds?.length > 0) {
            fileIds.push(...result.extractedImageFileIds);
          }

          if (file.extractedMarkdown) {
            extractedTexts.push(
              `--- Contenido extraído del documento "${file.name}" ---\n${file.extractedMarkdown}\n--- Fin del documento ---`,
            );
          }
        }
        setIsUploadingFile(false);
      }

      let finalPrompt = currentInput;
      if (extractedTexts.length > 0) {
        const docsText = extractedTexts.join("\n\n");
        finalPrompt = currentInput
          ? `${currentInput}\n\n${docsText}`
          : docsText;
      }

      await sendMessage({
        threadId: currentThreadId as any,
        prompt: finalPrompt,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
      });
    } catch (error) {
      console.error("Error enviando mensaje:", error);
      setInput(currentInput);
      setSelectedFiles(currentFiles);
      setIsUploadingFile(false);
    }
  };

  const handleNewChat = async () => {
    try {
      const threadId = await createThread({ title: "Nuevo Brief" });
      setCurrentThreadId(threadId as string);
    } catch (error) {
      console.error("Error creando nuevo chat:", error);
    }
  };

  // ===========================================================================
  // Handlers de archivos
  // ===========================================================================
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remainingSlots = MAX_FILES - selectedFiles.length;
    if (remainingSlots <= 0) {
      alert(`Solo puedes subir hasta ${MAX_FILES} archivos.`);
      return;
    }

    const filesToProcess = Array.from(files).slice(0, remainingSlots);
    for (const file of filesToProcess) {
      if (!SUPPORTED_FILE_TYPES.includes(file.type)) {
        alert(`Tipo de archivo no soportado: ${file.name}`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB}MB.`);
        continue;
      }

      const isImage = file.type.startsWith("image/");
      const isAudio = file.type.startsWith("audio/");
      const isWordDoc =
        file.type.includes("word") ||
        file.type === "application/msword" ||
        file.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const isDocument = file.type === "application/pdf" || isWordDoc;

      let base64String: string;

      if (isImage) {
        try {
          base64String = await compressImage(file);
        } catch {
          base64String = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
        }
      } else {
        base64String = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
      }

      let extractedMarkdown: string | undefined;
      let extractedImages: ExtractedImage[] | undefined;

      if (isWordDoc) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const images: ExtractedImage[] = [];

          const options = {
            convertImage: mammoth.images.imgElement(async (image: any) => {
              const imageBuffer = await image.read();
              const uint8Array = new Uint8Array(imageBuffer);
              let binary = "";
              uint8Array.forEach((byte) => {
                binary += String.fromCharCode(byte);
              });
              const base64 = btoa(binary);
              const mimeType = image.contentType || "image/png";
              images.push({ data: base64, mimeType });
              return { src: `__IMAGE_PLACEHOLDER_${images.length - 1}__` };
            }),
          };

          const result = await mammoth.convertToHtml({ arrayBuffer }, options);
          const turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
          });

          let markdown = turndown.turndown(result.value);
          markdown = markdown.replace(
            /__IMAGE_PLACEHOLDER_\d+__/g,
            "[Imagen adjunta]",
          );

          extractedMarkdown = markdown;
          extractedImages = images;
        } catch (error) {
          console.error("Error procesando Word:", error);
        }
      }

      setSelectedFiles((prev) => [
        ...prev,
        {
          name: file.name,
          type: file.type,
          isImage,
          isDocument,
          isAudio,
          base64: base64String,
          extractedMarkdown,
          extractedImages,
        },
      ]);
    }

    // Reset input
    e.target.value = "";
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ===========================================================================
  // Handlers de grabación de voz
  // ===========================================================================
  const startRecording = () => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      alert("Tu navegador no soporta reconocimiento de voz.");
      return;
    }

    try {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "es-ES";

      recognition.onstart = () => {
        setIsRecording(true);
        setRecordingTime(0);
        setInterimTranscript("");
        setFinalTranscript("");
        recordingTimerRef.current = setInterval(() => {
          setRecordingTime((prev) => prev + 1);
        }, 1000);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            final += transcript + " ";
          } else {
            interim += transcript;
          }
        }
        if (final) setFinalTranscript((prev) => prev + final);
        setInterimTranscript(interim);
      };

      recognition.onerror = (event: Event & { error: string }) => {
        console.error("Speech recognition error:", event.error);
        if (event.error === "not-allowed") {
          alert("Permiso de micrófono denegado.");
        }
        stopRecording();
      };

      recognition.onend = () => {
        if (isRecording && speechRecognitionRef.current) {
          try {
            speechRecognitionRef.current.start();
          } catch {}
        }
      };

      speechRecognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      console.error("Error iniciando reconocimiento:", error);
    }
  };

  const stopRecording = () => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      speechRecognitionRef.current = null;
    }
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setInterimTranscript("");
  };

  const cancelRecording = () => {
    stopRecording();
    setFinalTranscript("");
    setInterimTranscript("");
  };

  // ===========================================================================
  // Procesar mensajes (adaptado para useUIMessages + streaming)
  // ===========================================================================
  const messageList: Message[] = (uiMessages || [])
    .map((msg: any) => ({
      key: msg.key,
      role: msg.role,
      content: msg.parts || msg.text || "",
      _creationTime: msg._creationTime,
      agentName: msg.agentName,
      status: msg.status,
      reasoning: msg.reasoning,
      reasoningDetails: msg.reasoningDetails,
    }))
    .filter((msg: Message) => {
      if (msg.role === "assistant") {
        if (msg.status === "pending" && !msg.content) return false;
        const hasContent = Array.isArray(msg.content)
          ? msg.content.some((p) => p.text || p.url)
          : typeof msg.content === "string" && msg.content.trim() !== "";
        return hasContent || msg.status === "streaming";
      }
      return true;
    });

  // Detectar si el último mensaje es un error (contiene ⚠️)
  const lastAssistantMessage = (uiMessages || [])
    .filter((msg: any) => msg.role === "assistant")
    .pop();
  const isErrorMessage =
    lastAssistantMessage?.text?.includes("⚠️") ||
    (Array.isArray(lastAssistantMessage?.parts) &&
      lastAssistantMessage.parts.some((p: any) => p.text?.includes("⚠️")));

  // isAgentThinking: mostrar indicador solo cuando el agente está procesando
  // pero NO hay ningún mensaje streaming ya visible (evita doble loader)
  const hasAnyStreamingMessage = (uiMessages || []).some(
    (msg: any) => msg.role === "assistant" && msg.status === "streaming",
  );

  const isAgentThinking =
    !isErrorMessage &&
    !hasAnyStreamingMessage &&
    ((uiMessages || []).some(
      (msg: any) =>
        msg.role === "assistant" &&
        msg.status === "pending" &&
        !msg.text &&
        (!msg.parts || msg.parts.length === 0),
    ) ||
      (messageList.length > 0 &&
        messageList[messageList.length - 1]?.role === "user" &&
        !isErrorMessage));

  // ===========================================================================
  // Render
  // ===========================================================================
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">
            Recolección de Brief
          </h2>
          {/* <button
            onClick={handleNewChat}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Nueva Conversación
          </button> */}
        </div>
      )}

      {/* Área de mensajes */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <ChatMessageList
          messages={messageList}
          isAgentThinking={isAgentThinking}
          currentThreadId={currentThreadId}
          isCreatingThread={isCreatingThread}
        />
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <ChatInputForm
        input={input}
        onInputChange={setInput}
        selectedFiles={selectedFiles}
        onFileSelect={handleFileSelect}
        onRemoveFile={handleRemoveFile}
        onSubmit={handleSubmit}
        isRecording={isRecording}
        recordingTime={recordingTime}
        finalTranscript={finalTranscript}
        interimTranscript={interimTranscript}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
        onCancelRecording={cancelRecording}
        onClearTranscript={() => setFinalTranscript("")}
        currentThreadId={currentThreadId}
        isCreatingThread={isCreatingThread}
        isUploadingFile={isUploadingFile}
        isAgentThinking={isAgentThinking}
      />
    </div>
  );
}
