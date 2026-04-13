"use client";

import { useRef, useState, useCallback, DragEvent } from "react";
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

interface ChatInputFormProps {
  input: string;
  onInputChange: (value: string) => void;
  selectedFiles: FileInfo[];
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
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

  const canSubmit =
    (input.trim() || selectedFiles.length > 0 || finalTranscript.trim()) &&
    currentThreadId &&
    !isCreatingThread &&
    !isUploadingFile &&
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

      const dt = new DataTransfer();
      valid.forEach((f) => dt.items.add(f));
      const syntheticEvent = {
        target: { files: dt.files, value: "" },
        preventDefault: () => {},
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onFileSelect(syntheticEvent);
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

      const dt = new DataTransfer();
      valid.forEach((f) => dt.items.add(f));
      const syntheticEvent = {
        target: { files: dt.files, value: "" },
        preventDefault: () => {},
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onFileSelect(syntheticEvent);
    },
    [onFileSelect],
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
              disabled={!currentThreadId || isCreatingThread}
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
            title={isUploadingFile ? "Subiendo..." : "Enviar mensaje"}
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
