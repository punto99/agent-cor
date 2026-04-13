"use client";

import { useRef, useState, useCallback, DragEvent } from "react";
import type { SelectedFile } from "./types";
import { getFileIcon, MAX_FILES, SUPPORTED_EVAL_FILE_TYPES } from "./types";
import { compressImage } from "@/app/lib/imageCompression";

const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

interface FilePreviewProps {
  file: SelectedFile;
  index: number;
  onRemove: (index: number) => void;
}

/**
 * Preview de un archivo individual
 */
function FilePreview({ file, index, onRemove }: FilePreviewProps) {
  const isImage = file.type.startsWith("image/");

  return (
    <div className="relative inline-block">
      {isImage ? (
        <img
          src={file.base64}
          alt={file.name}
          className="max-h-20 rounded-lg border border-border"
        />
      ) : (
        <div className="h-20 w-20 rounded-lg border border-border bg-muted flex flex-col items-center justify-center p-2">
          <span className="text-2xl">{getFileIcon(file.type)}</span>
          <span className="text-xs text-muted-foreground truncate max-w-full mt-1">
            {file.name.slice(0, 10)}...
          </span>
        </div>
      )}
      <button
        onClick={() => onRemove(index)}
        className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center hover:bg-destructive/90 text-xs"
        type="button"
      >
        ×
      </button>
    </div>
  );
}

interface EvaluationInputProps {
  selectedFiles: SelectedFile[];
  setSelectedFiles: React.Dispatch<React.SetStateAction<SelectedFile[]>>;
  onSubmit: () => void;
  isSubmitting: boolean;
}

/**
 * Área de input para evaluación con previews de archivos
 */
export function EvaluationInput({
  selectedFiles,
  setSelectedFiles,
  onSubmit,
  isSubmitting,
}: EvaluationInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Handler para seleccionar archivos (hasta 3)
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remainingSlots = MAX_FILES - selectedFiles.length;
    if (remainingSlots <= 0) {
      alert(`Solo puedes subir hasta ${MAX_FILES} archivos.`);
      return;
    }

    // ── 1. Synchronous validation (done before any async work) ─────────────
    const validFiles: File[] = [];
    for (const file of Array.from(files).slice(0, remainingSlots)) {
      if (!SUPPORTED_EVAL_FILE_TYPES.includes(file.type)) {
        alert(
          `Tipo de archivo no soportado: ${file.name}. Por favor sube imágenes, PDFs o documentos Word.`,
        );
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`"${file.name}" supera el límite de ${MAX_FILE_SIZE_MB}MB.`);
        continue;
      }
      validFiles.push(file);
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
    if (validFiles.length === 0) return;

    // ── 2. Async processing — only runs for files that passed validation ───
    for (const file of validFiles) {
      const isImage = file.type.startsWith("image/");
      let base64String: string;

      // Comprimir imágenes antes de subir
      if (isImage) {
        try {
          base64String = await compressImage(file);
        } catch (error) {
          console.error(`Error comprimiendo imagen:`, error);
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

      setSelectedFiles((prev) => [
        ...prev,
        {
          base64: base64String,
          name: file.name,
          type: file.type,
        },
      ]);
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Drag & Drop handlers ──────────────────────────────────────────────────
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length === 0) return;

      const remainingSlots = MAX_FILES - selectedFiles.length;
      if (remainingSlots <= 0) {
        alert(`Solo puedes subir hasta ${MAX_FILES} archivos.`);
        return;
      }

      const valid: File[] = [];
      for (const file of droppedFiles.slice(0, remainingSlots)) {
        if (!SUPPORTED_EVAL_FILE_TYPES.includes(file.type)) {
          alert(`Tipo no permitido: ${file.name}\nSolo imágenes, PDF y Word.`);
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
      handleFileSelect(syntheticEvent);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFiles.length],
  );

  return (
    <div
      className={`relative p-4 border-t border-border bg-card transition-colors ${
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
      {/* Preview de archivos seleccionados */}
      {selectedFiles.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {selectedFiles.map((file, index) => (
            <FilePreview
              key={index}
              file={file}
              index={index}
              onRemove={handleRemoveFile}
            />
          ))}
        </div>
      )}

      {/* Contador de archivos */}
      {selectedFiles.length > 0 && (
        <p className="text-xs text-muted-foreground mb-2">
          {selectedFiles.length} de {MAX_FILES} archivos seleccionados
        </p>
      )}

      <div className="flex gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="image/*,application/pdf,.docx,.doc"
          multiple
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSubmitting || selectedFiles.length >= MAX_FILES}
          className="px-3 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={
            selectedFiles.length >= MAX_FILES
              ? `Máximo ${MAX_FILES} archivos`
              : "Adjuntar archivo"
          }
        >
          📎
        </button>
        <button
          onClick={onSubmit}
          disabled={selectedFiles.length === 0 || isSubmitting}
          className="flex-1 py-2 px-4 bg-primary hover:bg-primary/90
                     text-primary-foreground rounded-lg transition-all font-medium 
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Enviando..." : "Evaluar Resultado"}
        </button>
      </div>
      {selectedFiles.length < MAX_FILES && (
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Imágenes, PDF o Word (botón o arrastrar) · máx. {MAX_FILE_SIZE_MB}MB
          por archivo
        </p>
      )}
    </div>
  );
}
