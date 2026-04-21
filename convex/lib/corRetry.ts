// convex/lib/corRetry.ts
// =====================================================
// Helper centralizado para reintentos de sincronización con COR.
//
// Uso: importar desde cualquier action que llame a COR y necesite
// reintentar en caso de fallo (sync de ediciones, publicación, etc.).
// =====================================================

/**
 * Delays de backoff exponencial para cada intento (en ms).
 * Intento 0 = inmediato (ya se ejecutó),
 * Intento 1 = 5s, 2 = 30s.
 */
export const COR_RETRY_DELAYS = [0, 5_000, 30_000];

/** Máximo de intentos (incluyendo el primero). */
export const MAX_RETRY_ATTEMPTS = COR_RETRY_DELAYS.length;

/**
 * Retorna el delay en ms para el próximo intento, o `null` si se agotaron.
 *
 *   attempt 0 → ejecutado ahora, si falla → delay para intento 1 = 5_000
 *   attempt 4 → último intento, si falla → null (rendirse)
 */
export function getRetryDelay(attempt: number): number | null {
  const nextAttempt = attempt + 1;
  if (nextAttempt >= MAX_RETRY_ATTEMPTS) return null;
  return COR_RETRY_DELAYS[nextAttempt];
}

/**
 * ¿Quedan reintentos disponibles?
 */
export function shouldRetry(attempt: number): boolean {
  return getRetryDelay(attempt) !== null;
}

/**
 * Detecta si un error es un error de cliente (4xx) que nunca se va a resolver reintentando.
 * Busca patrones como "COR API error: 4xx" o "COR auth failed: 4xx" en el mensaje.
 */
export function isClientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Matchea "COR API error: 4xx" o "COR auth failed: 4xx" o "Error creando ... en COR: 4xx"
  const httpStatusMatch = msg.match(/:\s*(\d{3})\s*-/);
  if (httpStatusMatch) {
    const status = parseInt(httpStatusMatch[1]);
    return status >= 400 && status < 500;
  }
  return false;
}

/**
 * Extrae un mensaje limpio de un error para guardar en corSyncError.
 * Nunca expone stack traces ni info sensible.
 */
export function formatRetryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}
