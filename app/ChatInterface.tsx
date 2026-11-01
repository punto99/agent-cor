"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { useUIMessages } from "@convex-dev/agent/react";
import { api } from "@/convex/_generated/api";
import mammoth from "mammoth";
import TurndownService from "turndown";
import {
  CHAT_MAX_FILES as MAX_FILES,
  CHAT_MAX_FILE_SIZE_MB as MAX_FILE_SIZE_MB,
  CHAT_MAX_FILE_SIZE_BYTES as MAX_FILE_SIZE_BYTES,
  assertChatFileSizes,
  assertChatOriginalCount,
  selectedChatFileSizes,
} from "@/config/chatUploads";

// Importar componentes extraídos
import { ChatMessageList } from "./components/chat/ChatMessageList";
import { ChatInputForm } from "./components/chat/ChatInputForm";
import { FileInfo, ExtractedImage } from "./components/chat/FilePreviewList";
import { Message } from "./components/chat/MessageContent";
import { showChatWaitingIndicator } from "./lib/chatWaitingIndicator";
import {
  pendingChatMessages,
  belongsToChat,
  visiblePendingMessages,
  localChatMessage,
  type PendingChatMessage,
} from "./lib/pendingChatMessages";

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
  const selectingFilesRef = useRef<FileInfo[] | null>(null);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);

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
  const accessProfile = useQuery(api.data.userAccess.viewerAccessProfile);
  const viewerUserId =
    accessProfile && "userId" in accessProfile
      ? accessProfile.userId
      : undefined;
  const sendScope =
    viewerUserId && currentThreadId
      ? { userId: viewerUserId, threadId: currentThreadId }
      : null;
  const allPendingMessages = useSyncExternalStore(
    pendingChatMessages.subscribe,
    pendingChatMessages.getSnapshot,
    pendingChatMessages.getServerSnapshot,
  );

  const { results: uiMessages, status: streamStatus } = useUIMessages(
    api.messaging.chat.listThreadMessages,
    currentThreadId ? { threadId: currentThreadId as any } : "skip",
    { initialNumItems: 50, stream: true },
  );
  const pendingMessages = sendScope
    ? visiblePendingMessages(allPendingMessages, sendScope, uiMessages)
    : [];
  const hasPendingMessage = sendScope
    ? allPendingMessages.some((message) => belongsToChat(message, sendScope))
    : false;
  const pendingScrollKey = pendingMessages
    .map((message) => `${message.id}:${message.status}`)
    .join(",");

  useEffect(() => {
    if (viewerUserId && currentThreadId) {
      pendingChatMessages.acknowledge(
        { userId: viewerUserId, threadId: currentThreadId },
        uiMessages,
      );
    }
  }, [uiMessages, viewerUserId, currentThreadId]);

  // Auto-scroll al final cuando hay mensajes nuevos
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages, pendingScrollKey]);

  // Sincronizar con threadId inicial
  useEffect(() => {
    if (initialThreadId && initialThreadId !== currentThreadId) {
      setCurrentThreadId(initialThreadId);
    }
  }, [initialThreadId]);

  // Notificar cambios de thread
  useEffect(() => {
    onThreadChange?.(currentThreadId);
  }, [currentThreadId, onThreadChange]);

  // ===========================================================================
  // Handlers de envío de mensaje
  // ===========================================================================
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectingFilesRef.current || isUploadingFile || !sendScope) return;

    const voiceText = finalTranscript.trim();
    const textInput = input.trim();
    const combinedInput = voiceText
      ? textInput
        ? `${textInput}\n\n[Mensaje de voz]: ${voiceText}`
        : voiceText
      : textInput;

    if ((!combinedInput && selectedFiles.length === 0) || !currentThreadId)
      return;

    try {
      assertChatOriginalCount(selectedFiles.length);
      assertChatFileSizes(selectedChatFileSizes(selectedFiles));
    } catch (error) {
      alert(
        error instanceof Error
          ? error.message
          : "Revisá los archivos seleccionados.",
      );
      return;
    }

    const currentInput = combinedInput;
    const currentFiles = [...selectedFiles];
    // Insert before any upload starts. The store also guards rapid double submits.
    const pending = pendingChatMessages.start(
      sendScope,
      currentInput,
      currentFiles,
    );
    if (!pending) return;
    setInput("");
    setFinalTranscript("");
    setInterimTranscript("");
    setSelectedFiles([]);
    await deliverPendingMessage(pending);
  };

  const deliverPendingMessage = async (pending: PendingChatMessage) => {
    const currentInput = pending.text;
    const currentFiles = pending.files;
    try {
      // Give React a chance to display the message before converting file bytes.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const fileIds: string[] = [];
      const attachmentFileIds: string[] = [];
      const extractedTexts: string[] = [];

      if (currentFiles.length > 0) {
        setIsUploadingFile(true);
        for (const [fileIndex, file] of currentFiles.entries()) {
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
          });

          // Siempre incluir el archivo original (para adjuntar a la tarea)
          // chat.ts omite el Word original: el modelo recibe su texto e imágenes.
          fileIds.push(result.fileId);
          attachmentFileIds.push(result.fileId);

          // Auxiliary Word images are uploaded individually as binary, keeping
          // large base64 arrays out of action arguments. They are not task attachments.
          for (const [index, image] of (file.extractedImages ?? []).entries()) {
            const imageBlob = base64ToBlob(
              `data:${image.mimeType};base64,${image.data}`,
            );
            const imageUploadUrl = await generateUploadUrl();
            const imageResponse = await fetch(imageUploadUrl, {
              method: "POST",
              headers: { "Content-Type": image.mimeType },
              body: imageBlob,
            });
            if (!imageResponse.ok)
              throw new Error("Error subiendo imagen del documento");
            const { storageId: imageStorageId } = await imageResponse.json();
            const imageResult = await registerUploadedFile({
              storageId: imageStorageId,
              filename: `${file.name}-img-${index}.${image.mimeType.split("/")[1] || "png"}`,
              mimeType: image.mimeType,
            });
            fileIds.push(imageResult.fileId);
          }

          if (file.extractedMarkdown) {
            extractedTexts.push(
              `--- Contenido extraído del documento "${file.name}" ---\n${file.extractedMarkdown}\n--- Fin del documento ---`,
            );
          }
          // Visual progress only: Word is ready after its auxiliary images too.
          pendingChatMessages.markFileUploaded(pending.id, fileIndex);
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

      const { messageId } = await sendMessage({
        threadId: pending.threadId,
        clientMessageId: pending.id,
        prompt: finalPrompt,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
        attachmentFileIds:
          attachmentFileIds.length > 0 ? attachmentFileIds : undefined,
      });
      pendingChatMessages.confirm(pending.id, messageId);
    } catch (error) {
      console.error("Error enviando mensaje:", error);
      pendingChatMessages.fail(pending.id);
    } finally {
      setIsUploadingFile(false);
    }
  };

  const handleRetryMessage = (id: string) => {
    if (!sendScope) return;
    const pending = pendingChatMessages.retry(id, sendScope);
    if (pending) void deliverPendingMessage(pending);
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

    if (selectingFilesRef.current || isUploadingFile) return;
    const selection = [...selectedFiles];
    selectingFilesRef.current = selection;
    setIsProcessingFiles(true);
    try {
      const remainingSlots = MAX_FILES - selection.length;
      if (remainingSlots <= 0) {
        alert(`Solo puedes subir hasta ${MAX_FILES} archivos por mensaje.`);
        return;
      }

      const filesToProcess = Array.from(files).slice(0, remainingSlots);
      if (files.length > remainingSlots)
        alert(
          `Se agregarán hasta ${remainingSlots} archivos. El máximo es ${MAX_FILES} por mensaje.`,
        );
      for (const file of filesToProcess) {
        if (!SUPPORTED_FILE_TYPES.includes(file.type)) {
          alert(`Tipo de archivo no soportado: ${file.name}`);
          continue;
        }

        if (file.size > MAX_FILE_SIZE_BYTES) {
          alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB} MiB.`);
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

            const result = await mammoth.convertToHtml(
              { arrayBuffer },
              options,
            );
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

        const candidate: FileInfo = {
          name: file.name,
          type: file.type,
          isImage,
          isDocument,
          isAudio,
          base64: base64String,
          extractedMarkdown,
          extractedImages,
        };
        // Validate the whole selection, including extracted Word images, before upload.
        try {
          assertChatFileSizes(selectedChatFileSizes([...selection, candidate]));
        } catch (error) {
          alert(
            error instanceof Error
              ? error.message
              : "Revisá el peso de los archivos.",
          );
          continue;
        }
        selection.push(candidate);
        setSelectedFiles([...selection]);
      }
    } finally {
      e.target.value = "";
      selectingFilesRef.current = null;
      setIsProcessingFiles(false);
    }
  };

  const handleRemoveFile = (index: number) => {
    selectingFilesRef.current?.splice(index, 1);
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
  const savedMessageList: Message[] = (uiMessages || [])
    .map((msg: any) => ({
      key:
        msg.role === "user" && msg.clientMessageId
          ? msg.clientMessageId
          : msg.key,
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
        // Empty streaming placeholders keep using the same waiting indicator.
        return hasContent;
      }
      return true;
    });
  const messageList = [
    ...savedMessageList,
    ...pendingMessages.map(localChatMessage),
  ];

  const isAgentThinking = showChatWaitingIndicator(uiMessages, pendingMessages);

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
      <div className="flex-1 space-y-4 overflow-y-auto p-3 md:p-4">
        <ChatMessageList
          messages={messageList}
          isAgentThinking={isAgentThinking}
          currentThreadId={currentThreadId}
          isCreatingThread={isCreatingThread}
          showUserLinkPreviews={Boolean(accessProfile)}
          onRetryMessage={handleRetryMessage}
          onDismissMessage={(id) => {
            if (sendScope) pendingChatMessages.dismiss(id, sendScope);
          }}
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
        isCreatingThread={isCreatingThread || !viewerUserId}
        isUploadingFile={isUploadingFile || isProcessingFiles}
        isSendingMessage={hasPendingMessage}
        isAgentThinking={isAgentThinking}
      />
    </div>
  );
}
