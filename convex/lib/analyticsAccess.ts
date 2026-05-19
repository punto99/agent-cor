// Agrega aquí los _id de users autorizados para ver /workspace/analytics.
// Ejemplo: "k17abc..."
export const ANALYTICS_ALLOWED_USER_IDS = [
  "k972vsx708w0bdmryeaqsw9qfh842tav",
] as const;

export function canUserAccessAnalytics(userId: string) {
  return (ANALYTICS_ALLOWED_USER_IDS as readonly string[]).includes(userId);
}
