// convex/files.ts
// Manejo de archivos e imágenes para el agente de Brief
import { v } from "convex/values";
import { action, mutation, query } from "../_generated/server";
import { storeFile, getFile } from "@convex-dev/agent";
import { components } from "../_generated/api";

// Tipos de archivo soportados
const SUPPORTED_FILE_TYPES = {
  // Imágenes
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Documentos
  'application/pdf': 'pdf',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  // Audio
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_FILE_TYPES;

// Verificar si un tipo MIME es soportado
function isSupportedFileType(mimeType: string): mimeType is SupportedMimeType {
  return mimeType in SUPPORTED_FILE_TYPES;
}

// Verificar si es una imagen
function isImageType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

// Verificar si es un documento (PDF)
function isDocumentType(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

// Verificar si es un documento Word
function isWordDocument(mimeType: string): boolean {
  return mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
         mimeType === 'application/msword';
}

// Verificar si es un archivo de audio
function isAudioFile(mimeType: string): boolean {
  return mimeType.startsWith('audio/');
}

// Subir imagen y guardar en storage (original y thumbnail)
export const uploadImage = action({
  args: {
    imageBase64: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(`[Files] 📤 Subiendo imagen...`);
    
    // Extraer datos de la imagen base64
    const matches = args.imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Formato de imagen inválido");
    }
    
    const mimeType = matches[1];
    const base64Data = matches[2];
    const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    
    const filename = args.filename || `image-${Date.now()}.${mimeType.split('/')[1]}`;
    
    // 1. Guardar imagen original
    const { file: originalFile } = await storeFile(
      ctx,
      components.agent,
      new Blob([imageBytes], { type: mimeType }),
      {
        filename: `original-${filename}`,
      }
    );
    
    console.log(`[Files] ✅ Imagen original guardada: ${originalFile.fileId}`);
    
    // 2. Crear thumbnail (imagen reducida)
    // Por ahora usamos la misma imagen original
    // TODO: Implementar redimensionamiento real con sharp o similar
    const { file: thumbnailFile } = await storeFile(
      ctx,
      components.agent,
      new Blob([imageBytes], { type: mimeType }),
      {
        filename: `thumb-${filename}`,
      }
    );
    
    console.log(`[Files] ✅ Thumbnail guardado: ${thumbnailFile.fileId}`);
    
    return {
      originalFileId: originalFile.fileId,
      thumbnailFileId: thumbnailFile.fileId,
      url: originalFile.url,
      thumbnailUrl: thumbnailFile.url,
      mimeType,
    };
  },
});

// Subir archivo genérico (imagen, PDF, Word)
// Para Word, el contenido se extrae en el frontend y se pasa aquí
export const uploadFile = action({
  args: {
    fileBase64: v.string(),
    filename: v.optional(v.string()),
    // Contenido extraído de Word (procesado en el frontend)
    extractedMarkdown: v.optional(v.string()),
    extractedImages: v.optional(v.array(v.object({
      data: v.string(), // base64
      mimeType: v.string(),
    }))),
  },
  handler: async (ctx, args) => {
    // LOG: Calcular tamaño del base64 recibido
    const base64SizeKB = (args.fileBase64.length / 1024).toFixed(2);
    console.log(`[Files] 📤 Subiendo archivo... Tamaño base64 recibido: ${base64SizeKB}KB`);
    
    // Extraer datos del archivo base64
    const matches = args.fileBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Formato de archivo inválido");
    }
    
    const mimeType = matches[1];
    const base64Data = matches[2];
    const fileBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    
    // LOG: Tamaño real del archivo en bytes
    const fileSizeKB = (fileBytes.length / 1024).toFixed(2);
    console.log(`[Files] 📊 Tamaño real del archivo: ${fileSizeKB}KB (${fileBytes.length} bytes)`);
    
    // Verificar que el tipo de archivo es soportado
    if (!isSupportedFileType(mimeType)) {
      throw new Error(`Tipo de archivo no soportado: ${mimeType}. Tipos soportados: imágenes, PDF, Word (.doc/.docx) y audio`);
    }
    
    // Determinar extensión y nombre
    const extension = SUPPORTED_FILE_TYPES[mimeType];
    const timestamp = Date.now();
    const filename = args.filename || `file-${timestamp}.${extension}`;
    
    console.log(`[Files] 📁 Tipo: ${mimeType}, Nombre: ${filename}, Tamaño: ${fileSizeKB}KB`);
    
    // Guardar imágenes extraídas de Word (si las hay)
    const extractedImageFileIds: string[] = [];
    
    if (args.extractedImages && args.extractedImages.length > 0) {
      console.log(`[Files] 📄 Guardando ${args.extractedImages.length} imágenes de documento Word...`);
      
      for (let i = 0; i < args.extractedImages.length; i++) {
        const img = args.extractedImages[i];
        const imgBytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
        const { file: imgFile } = await storeFile(
          ctx,
          components.agent,
          new Blob([imgBytes], { type: img.mimeType }),
          { filename: `${filename}-img-${i}.${img.mimeType.split('/')[1] || 'png'}` }
        );
        extractedImageFileIds.push(imgFile.fileId);
        console.log(`[Files] 🖼️ Imagen ${i + 1} guardada: ${imgFile.fileId}`);
      }
    }
    
    // Guardar archivo original
    const { file } = await storeFile(
      ctx,
      components.agent,
      new Blob([fileBytes], { type: mimeType }),
      { filename }
    );
    
    console.log(`[Files] ✅ Archivo guardado: ${file.fileId}`);
    
    // DEBUG: Verificar que el storageId realmente existe y obtener URL correcta
    const storageUrl = await ctx.storage.getUrl(file.storageId);
    console.log(`[Files] 🔍 DEBUG - storageId: ${file.storageId}`);
    console.log(`[Files] 🔍 DEBUG - URL de storeFile: ${file.url}`);
    console.log(`[Files] 🔍 DEBUG - URL real del storage: ${storageUrl}`);
    
    return {
      fileId: file.fileId,
      thumbnailFileId: file.fileId,
      url: file.url,
      mimeType,
      isImage: isImageType(mimeType),
      isDocument: isDocumentType(mimeType),
      isWordDocument: isWordDocument(mimeType),
      isAudio: isAudioFile(mimeType),
      filename,
      // Contenido extraído de Word (si aplica)
      extractedMarkdown: args.extractedMarkdown,
      extractedImageFileIds,
    };
  },
});

// Obtener información de un archivo
export const getFileInfo = mutation({
  args: {
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    const fileInfo = await getFile(ctx, components.agent, args.fileId);
    return fileInfo;
  },
});

// Obtener URL de un archivo desde su fileId
export const getFileUrl = query({
  args: {
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Obtener el documento file del componente agent
      const fileDoc = await ctx.runQuery(
        components.agent.files.get,
        { fileId: args.fileId }
      );
      
      if (!fileDoc) {
        console.error(`[Files] No se encontró el archivo con fileId: ${args.fileId}`);
        return null;
      }
      
      // Obtener la URL desde el storageId
      const url = await ctx.storage.getUrl(fileDoc.storageId);
      return url;
    } catch (error) {
      console.error(`[Files] Error obteniendo URL para fileId ${args.fileId}:`, error);
      return null;
    }
  },
});

// ============================================================
// UPLOAD DIRECTO A STORAGE
// ============================================================

/**
 * Genera una URL pre-firmada para subir archivos directamente al storage.
 * El frontend hace POST con el body binario a esta URL → obtiene storageId.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Registra un archivo ya subido al storage (via generateUploadUrl) en el
 * sistema de archivos del agente (@convex-dev/agent).
 *
 * Flujo: generateUploadUrl → fetch POST (binario) → storageId → registerUploadedFile
 *
 * Esto evita el límite de 16 MiB en argumentos de action que afectaba al
 * antiguo uploadFile (que recibía el archivo entero como base64 string).
 */
export const registerUploadedFile = action({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    // Contenido extraído de Word (procesado en el frontend)
    extractedMarkdown: v.optional(v.string()),
    extractedImages: v.optional(v.array(v.object({
      data: v.string(), // base64 sin prefijo
      mimeType: v.string(),
    }))),
  },
  handler: async (ctx, args) => {
    console.log(`[Files] 📤 registerUploadedFile: ${args.filename} (${args.mimeType})`);

    // 1. Obtener el blob desde storage (transferencia server-side, rápida)
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) throw new Error("Archivo no encontrado en storage");

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: args.mimeType });
    const fileSizeKB = (arrayBuffer.byteLength / 1024).toFixed(2);
    console.log(`[Files] 📊 Tamaño real: ${fileSizeKB}KB (${arrayBuffer.byteLength} bytes)`);

    // 2. Guardar imágenes extraídas de Word (si las hay)
    const extractedImageFileIds: string[] = [];
    if (args.extractedImages && args.extractedImages.length > 0) {
      console.log(`[Files] 📄 Guardando ${args.extractedImages.length} imágenes de documento Word...`);
      for (let i = 0; i < args.extractedImages.length; i++) {
        const img = args.extractedImages[i];
        const imgBytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
        const { file: imgFile } = await storeFile(
          ctx,
          components.agent,
          new Blob([imgBytes], { type: img.mimeType }),
          { filename: `${args.filename}-img-${i}.${img.mimeType.split('/')[1] || 'png'}` }
        );
        extractedImageFileIds.push(imgFile.fileId);
        console.log(`[Files] 🖼️ Imagen Word ${i + 1} guardada: ${imgFile.fileId}`);
      }
    }

    // 3. Registrar archivo principal en el sistema de archivos del agente
    const { file } = await storeFile(
      ctx,
      components.agent,
      blob,
      { filename: args.filename }
    );
    console.log(`[Files] ✅ Archivo registrado: ${file.fileId}`);

    // 4. Limpiar el upload temporal (storeFile creó su propia copia)
    await ctx.storage.delete(args.storageId);

    const mimeType = args.mimeType;
    return {
      fileId: file.fileId,
      url: file.url,
      mimeType,
      isImage: isImageType(mimeType),
      isDocument: isDocumentType(mimeType),
      isWordDocument: isWordDocument(mimeType),
      isAudio: isAudioFile(mimeType),
      filename: args.filename,
      extractedMarkdown: args.extractedMarkdown,
      extractedImageFileIds,
    };
  },
});
