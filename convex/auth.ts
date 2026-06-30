import Google from "@auth/core/providers/google";
import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

const EXTERNAL_EMAIL_OTP_PROVIDER_ID = "external-email-otp";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function generateSixDigitCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1_000_000).padStart(6, "0");
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Google,
    Email({
      id: EXTERNAL_EMAIL_OTP_PROVIDER_ID,
      name: "Email OTP",
      maxAge: 10 * 60,
      generateVerificationToken: generateSixDigitCode,
      sendVerificationRequest: (async (
        {
          identifier,
          token,
          expires,
        }: { identifier: string; token: string; expires: Date },
        ctx: any,
      ) => {
        const email = normalizeEmail(identifier);
        const isApproved = await ctx.runQuery(
          internal.data.approvedExternalUsers.isApprovedExternalEmail,
          { email },
        );

        if (!isApproved) {
          throw new Error("Usuario no autorizado");
        }

        await ctx.runMutation(
          internal.data.approvedExternalUsers.recordExternalOtpRequest,
          { email },
        );

        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
          throw new Error("RESEND_API_KEY no está configurada en Convex.");
        }

        const from = process.env.RESEND_FROM_EMAIL ?? "Punto99 <digital@pto99.com>";
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: email,
            subject: "Tu código de acceso",
            text: `Tu código de acceso es ${token}. Expira a las ${expires.toLocaleTimeString("es-MX", { timeZone: "America/Cancun" })}.`,
            html: `
              <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
                <p>Tu código de acceso es:</p>
                <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 16px 0;">${token}</p>
                <p>Este código expira en 10 minutos.</p>
                <p>Si no solicitaste este código, puedes ignorar este correo.</p>
              </div>
            `,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Resend no pudo enviar el código: ${response.status} ${body}`,
          );
        }
      }) as any,
    }),
  ],
  callbacks: {
    afterUserCreatedOrUpdated: async (
      ctx,
      { userId, existingUserId, type, provider, profile },
    ) => {
      if (
        provider.id === EXTERNAL_EMAIL_OTP_PROVIDER_ID &&
        type === "verification" &&
        typeof profile.email === "string"
      ) {
        if (!existingUserId) {
          await ctx.scheduler.runAfter(
            0,
            internal.data.preferences.ensureDefaultPreferences,
            {
              userId,
              userKind: "external",
            },
          );
        }
        await ctx.scheduler.runAfter(
          0,
          internal.data.approvedExternalUsers.linkApprovedExternalUser,
          {
            email: profile.email,
            userId,
          },
        );
        return;
      }

      if (provider.id !== "google") return;

      // Solo para usuarios nuevos de Google (no actualizaciones de perfil)
      if (existingUserId) return;

      await ctx.scheduler.runAfter(
        0,
        internal.data.preferences.ensureDefaultPreferences,
        {
          userId,
          userKind: "internal",
        },
      );

      // Resolver usuario en COR en background (no bloquea el login)
      await ctx.scheduler.runAfter(
        0,
        internal.data.corUsersActions.resolveUserInCOR,
        {
          userId,
        },
      );
    },
  },
});
