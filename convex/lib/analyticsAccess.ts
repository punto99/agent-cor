// Agrega aquí los _id de users autorizados para ver /workspace/analytics.
// Ejemplo: "k17abc..."
export const ANALYTICS_ALLOWED_USER_IDS = [
  "k972vsx708w0bdmryeaqsw9qfh842tav",
  "m17a6x8382hmpt3rxaczgc5p8n81tanb",
  "m170q4js3s9785dhsp3v678m3981yks8",
  "m17c6njw8pfrtt72ere92y945181yxdm"
] as const;

export function canUserAccessAnalytics(userId: string) {
  return (ANALYTICS_ALLOWED_USER_IDS as readonly string[]).includes(userId);
}
