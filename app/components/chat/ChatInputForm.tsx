"use client";

import { useRef, useState, useCallback, DragEvent, ClipboardEvent } from "react";
import { FilePreviewList, FileInfo } from "./FilePreviewList";
import { VoiceRecorderPanel } from "./VoiceRecorderPanel";

// Constantes
const FILE_ACCEPT =
  "image/*,application/pdf,.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac";
const MAX_FILES = 3;
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Tipos permitidos vía drag & drop
const DRAG_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

function getImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function createSyntheticFileSelectEvent(files: File[]) {
  const dt = new DataTransfer();
  files.forEach((file) => dt.items.add(file));
  return {
    target: { files: dt.files, value: "" },
    preventDefault: () => {},
  } as unknown as React.ChangeEvent<HTMLInputElement>;
}

function dataUrlToFile(dataUrl: string, filename: string): File | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1];
  const base64Data = match[2].replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(base64Data), (char) =>
    char.charCodeAt(0),
  );

  return new File([bytes], filename, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function extractDataImageFilesFromHtml(
  html: string,
  maxImages: number,
): { files: File[]; detectedCount: number } {
  if (!html) return { files: [], detectedCount: 0 };

  const document = new DOMParser().parseFromString(html, "text/html");
  const imageSources = Array.from(document.querySelectorAll("img"))
    .map((img) => img.getAttribute("src") || "")
    .filter((src) => src.startsWith("data:image/"));

  const files = imageSources
    .slice(0, Math.max(0, maxImages))
    .map((src, index) => {
      const mimeType = src.match(/^data:([^;]+);base64,/)?.[1] || "image/png";
      const extension = getImageExtension(mimeType);
      return dataUrlToFile(
        src,
        `imagen-pegada-${Date.now()}-${index + 1}.${extension}`,
      );
    })
    .filter((file): file is File => file !== null);

  return { files, detectedCount: imageSources.length };
}

interface ChatInputFormProps {
  input: string;
  onInputChange: (value: string) => void;
  selectedFiles: FileInfo[];
  onFileSelect: (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  onRemoveFile: (index: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  // Voice recording
  isRecording: boolean;
  recordingTime: number;
  finalTranscript: string;
  interimTranscript: string;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onClearTranscript: () => void;
  // State flags
  currentThreadId: string | null;
  isCreatingThread: boolean;
  isUploadingFile: boolean;
  isAgentThinking?: boolean;
}

/**
 * Formulario de entrada del chat con soporte para archivos y voz
 */
export function ChatInputForm({
  input,
  onInputChange,
  selectedFiles,
  onFileSelect,
  onRemoveFile,
  onSubmit,
  isRecording,
  recordingTime,
  finalTranscript,
  interimTranscript,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onClearTranscript,
  currentThreadId,
  isCreatingThread,
  isUploadingFile,
  isAgentThinking = false,
}: ChatInputFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessingPastedFiles, setIsProcessingPastedFiles] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);

  const showFileNotice = useCallback((message: string) => {
    setFileNotice(message);
    window.setTimeout(() => {
      setFileNotice((current) => (current === message ? null : current));
    }, 7000);
  }, []);

  const canSubmit =
    (input.trim() || selectedFiles.length > 0 || finalTranscript.trim()) &&
    currentThreadId &&
    !isCreatingThread &&
    !isUploadingFile &&
    !isProcessingPastedFiles &&
    !isRecording &&
    !isAgentThinking;

  // ── Drag & Drop handlers ──────────────────────────────────────────────────
  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentThreadId || isCreatingThread || isRecording) return;
      setIsDragging(true);
    },
    [currentThreadId, isCreatingThread, isRecording],
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear when leaving the outer container
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (!currentThreadId || isCreatingThread || isRecording) return;

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length === 0) return;

      const remainingSlots = MAX_FILES - selectedFiles.length;
      if (remainingSlots <= 0) {
        alert(`Solo puedes subir hasta ${MAX_FILES} archivos.`);
        return;
      }

      // Filter: only allowed types + size check
      const valid: File[] = [];
      for (const file of droppedFiles.slice(0, remainingSlots)) {
        if (!DRAG_ALLOWED_TYPES.includes(file.type)) {
          alert(
            `Tipo no permitido por arrastrar: ${file.name}\nSolo imágenes, PDF y Word.`,
          );
          continue;
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB}MB.`);
          continue;
        }
        valid.push(file);
      }

      if (valid.length === 0) return;

      onFileSelect(createSyntheticFileSelectEvent(valid));
    },
    [
      currentThreadId,
      isCreatingThread,
      isRecording,
      selectedFiles.length,
      onFileSelect,
    ],
  );

  // Same size check for button uploads — mirrors the drag handler above
  const handleButtonFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const valid: File[] = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB}MB.`);
          continue;
        }
        valid.push(file);
      }

      // Reset input so same file can be re-selected after rejection
      e.target.value = "";

      if (valid.length === 0) return;

      onFileSelect(createSyntheticFileSelectEvent(valid));
    },
    [onFileSelect],
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData.items);
      const filesFromClipboard = Array.from(e.clipboardData.files);
      const html = e.clipboardData.getData("text/html");

      if (!currentThreadId || isCreatingThread || isRecording) {
        return;
      }

      const filesFromItems = items
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      const imageFilesFromClipboard = [...filesFromClipboard, ...filesFromItems]
        .filter((file) => file.type.startsWith("image/"))
        .map((file, index) => {
          const extension = getImageExtension(file.type);
          const filename =
            file.name && file.name !== "image.png"
              ? file.name
              : `imagen-pegada-${Date.now()}-${index + 1}.${extension}`;

          return new File([file], filename, {
            type: file.type || "image/png",
            lastModified: Date.now(),
          });
        });

      const remainingSlots = MAX_FILES - selectedFiles.length;
      if (remainingSlots <= 0) {
        if (imageFilesFromClipboard.length > 0 || html.includes("<img")) {
          alert(`Solo puedes subir hasta ${MAX_FILES} archivos.`);
        }
        return;
      }

      const htmlImages =
        imageFilesFromClipboard.length > 0
          ? { files: [], detectedCount: 0 }
          : extractDataImageFilesFromHtml(html, remainingSlots);
      const imageFiles =
        imageFilesFromClipboard.length > 0
          ? imageFilesFromClipboard
          : htmlImages.files;
      const detectedCount =
        imageFilesFromClipboard.length > 0
          ? imageFilesFromClipboard.length
          : htmlImages.detectedCount;

      if (imageFiles.length === 0) return;

      const discardedCount = Math.max(0, detectedCount - remainingSlots);
      if (discardedCount > 0) {
        const acceptedCount = Math.min(detectedCount, remainingSlots);
        showFileNotice(
          `Se ${
            acceptedCount === 1 ? "agregó" : "agregaron"
          } ${acceptedCount} ${
            acceptedCount === 1 ? "imagen" : "imágenes"
          }. ${discardedCount} no ${
            discardedCount === 1 ? "se agregó" : "se agregaron"
          } porque el límite es ${MAX_FILES} archivos por mensaje.`,
        );
      }

      const valid: File[] = [];
      for (const file of imageFiles.slice(0, remainingSlots)) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB}MB.`);
          continue;
        }
        valid.push(file);
      }

      if (valid.length === 0) return;

      setIsProcessingPastedFiles(true);
      try {
        await onFileSelect(createSyntheticFileSelectEvent(valid));
      } catch (error) {
        console.error("Error procesando imágenes pegadas:", error);
      } finally {
        setIsProcessingPastedFiles(false);
      }
    },
    [
      currentThreadId,
      isCreatingThread,
      isRecording,
      selectedFiles.length,
      onFileSelect,
      showFileNotice,
    ],
  );

  return (
    <div
      className={`relative border-t border-border p-4 bg-background transition-colors ${
        isDragging ? "ring-2 ring-primary ring-inset bg-primary/5" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay hint */}
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-primary/10 border-2 border-dashed border-primary rounded-xl px-6 py-3 text-primary font-medium text-sm">
            Suelta los archivos aquí
          </div>
        </div>
      )}
      {/* Voice recorder panel */}
      <VoiceRecorderPanel
        isRecording={isRecording}
        recordingTime={recordingTime}
        finalTranscript={finalTranscript}
        interimTranscript={interimTranscript}
        onStopRecording={onStopRecording}
        onCancelRecording={onCancelRecording}
        onClearTranscript={onClearTranscript}
      />

      {/* Preview de archivos seleccionados */}
      <FilePreviewList files={selectedFiles} onRemoveFile={onRemoveFile} />

      {isProcessingPastedFiles && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
          <span className="size-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          Procesando imágenes pegadas...
        </div>
      )}

      {fileNotice && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {fileNotice}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col">
        {/* Input oculto para archivos */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleButtonFileSelect}
          accept={FILE_ACCEPT}
          multiple
          className="hidden"
        />

        {/* Textarea de texto */}
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Enter sin Shift envía el mensaje
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSubmit) {
                onSubmit(e as unknown as React.FormEvent);
              }
            }
            // Shift+Enter agrega nueva línea (comportamiento por defecto del textarea)
          }}
          placeholder={
            finalTranscript
              ? "Agrega texto adicional..."
              : "Escribe tu mensaje..."
          }
          className="w-full px-4 py-3 bg-muted/50 text-foreground rounded-t-xl border-0 focus:outline-none focus:ring-0 resize-none min-h-[48px] max-h-[200px] placeholder:text-muted-foreground"
          disabled={!currentThreadId || isCreatingThread || isRecording}
          rows={1}
          style={{
            height: "auto",
            minHeight: "48px",
          }}
          ref={(textarea) => {
            if (textarea) {
              textarea.style.height = "auto";
              textarea.style.height =
                Math.min(textarea.scrollHeight, 200) + "px";
            }
          }}
        />

        {/* Barra de botones */}
        <div className="flex items-center justify-between px-2 py-2 bg-muted/50 rounded-b-xl">
          {/* Botones de izquierda */}
          <div className="flex items-center gap-1">
            {/* Botón de adjuntar */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                !currentThreadId ||
                isCreatingThread ||
                selectedFiles.length >= MAX_FILES ||
                isProcessingPastedFiles ||
                isRecording
              }
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title={
                selectedFiles.length >= MAX_FILES
                  ? `Máximo ${MAX_FILES} archivos`
                  : "Adjuntar archivos"
              }
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {/* Botón de grabar voz */}
            <button
              type="button"
              onClick={isRecording ? onStopRecording : onStartRecording}
              disabled={
                !currentThreadId || isCreatingThread || isProcessingPastedFiles
              }
              className={`p-2 rounded-lg transition-colors ${
                isRecording
                  ? "text-destructive hover:bg-destructive/10 animate-pulse"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              title={
                isRecording ? "Detener grabación" : "Grabar mensaje de voz"
              }
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>
          </div>

          {/* Botón de enviar */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={`p-2 rounded-full transition-colors ${
              canSubmit
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            }`}
            title={
              isProcessingPastedFiles
                ? "Procesando imágenes pegadas..."
                : isUploadingFile
                  ? "Subiendo..."
                  : "Enviar mensaje"
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </form>
      {/* Drag hint */}
      {!isDragging && selectedFiles.length < MAX_FILES && (
        <p className="text-xs text-muted-foreground mt-1 text-center">
          Imágenes, PDF o Word (botón o arrastrar) · máx. {MAX_FILE_SIZE_MB}MB
          por archivo
        </p>
      )}
    </div>
  );
}

export { FILE_ACCEPT, MAX_FILES };
