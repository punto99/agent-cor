// Agrega aquí los _id de users autorizados para administrar usuarios internos.
// Sigue el mismo estilo de allowlist usado por Analytics.
export const INTERNAL_USER_ADMIN_ALLOWED_USER_IDS = [
  "k972vsx708w0bdmryeaqsw9qfh842tav",
  "m17a6x8382hmpt3rxaczgc5p8n81tanb",
  "m170q4js3s9785dhsp3v678m3981yks8",
  "m17c6njw8pfrtt72ere92y945181yxdm"
] as const;

export function canUserAccessInternalUserAdmin(userId: string) {
  return (INTERNAL_USER_ADMIN_ALLOWED_USER_IDS as readonly string[]).includes(
    userId,
  );
}
