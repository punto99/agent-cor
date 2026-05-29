// Agrega aquí los _id de users autorizados para administrar usuarios internos.
// Sigue el mismo estilo de allowlist usado por Analytics.
export const INTERNAL_USER_ADMIN_ALLOWED_USER_IDS = [
  "k972vsx708w0bdmryeaqsw9qfh842tav",
] as const;

export function canUserAccessInternalUserAdmin(userId: string) {
  return (INTERNAL_USER_ADMIN_ALLOWED_USER_IDS as readonly string[]).includes(
    userId,
  );
}
