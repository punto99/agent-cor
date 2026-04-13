/**
 * Utilidades para compresión de imágenes
 * Usado por ChatInterface y TaskPanel
 */

// Configuración de compresión de imágenes
export const IMAGE_MAX_WIDTH = 800;
export const IMAGE_MAX_HEIGHT = 800;
export const IMAGE_QUALITY = 0.6; // Calidad JPEG (60%)

/**
 * Comprime una imagen usando Canvas
 * SIEMPRE comprime convirtiendo a JPEG para máxima compresión
 */
export const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const originalSize = (e.target?.result as string).length;
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const originalWidth = width;
        const originalHeight = height;

        // Redimensionar si es mayor a los límites
        if (width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT) {
          const ratio = Math.min(
            IMAGE_MAX_WIDTH / width,
            IMAGE_MAX_HEIGHT / height
          );
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        // Crear canvas y dibujar imagen redimensionada
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          reject(new Error("No se pudo crear contexto de canvas"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Convertir a JPEG para máxima compresión
        const base64 = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);

        const compressedSize = base64.length;
        const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);

        console.log(`[Compress] ${file.name}:`);
        console.log(
          `  Original: ${originalWidth}x${originalHeight}, ${(originalSize / 1024).toFixed(1)}KB`
        );
        console.log(
          `  Comprimido: ${width}x${height}, ${(compressedSize / 1024).toFixed(1)}KB`
        );
        console.log(`  Reducción: ${reduction}%`);

        resolve(base64);
      };
      img.onerror = () => reject(new Error("Error cargando imagen"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsDataURL(file);
  });
};

/**
 * Obtener icono según tipo de archivo
 */
export const getFileIcon = (type: string): string => {
  if (type.startsWith("image/")) return "🖼️";
  if (type === "application/pdf") return "📄";
  if (type.includes("word") || type === "application/msword") return "📝";
  if (type.startsWith("audio/")) return "🎵";
  return "📎";
};

/**
 * Convierte un data URL (base64) a Blob binario.
 * Usado para el upload directo a Convex Storage via generateUploadUrl.
 */
export function base64ToBlob(dataUrl: string): Blob {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error("Formato de data URL inválido");
  const mimeType = matches[1];
  const base64Data = matches[2];
  const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}
