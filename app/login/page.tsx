"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { useRouter } from "next/navigation";
import {
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "@/convex/_generated/api";
import { useUser } from "../UserContextProvider";
import { clientConfig } from "@/config/tenant.config";
import { BrandLogoIcon } from "../components/BrandLogo";

const EXTERNAL_EMAIL_OTP_PROVIDER_ID = "external-email-otp";
const CODE_LENGTH = 6;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

// Google Icon SVG
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useUser();
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState("");
  const [otpEmail, setOtpEmail] = useState("");
  const [codeValues, setCodeValues] = useState<string[]>(
    Array(CODE_LENGTH).fill("")
  );
  const [requestingCode, setRequestingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [resendingCode, setResendingCode] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const codeRefs = useRef<Array<HTMLInputElement | null>>([]);

  const code = codeValues.join("");
  const canVerify = code.length === CODE_LENGTH && !verifyingCode;

  useEffect(() => {
    if (!isLoading && !signingIn && isAuthenticated) {
      router.replace("/workspace");
    }
  }, [isAuthenticated, isLoading, signingIn, router]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(
      () => setResendSeconds((seconds) => seconds - 1),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (otpEmail) {
      codeRefs.current[0]?.focus();
    }
  }, [otpEmail]);

  const handleGoogleSignIn = async () => {
    try {
      setError(null);
      setSigningIn(true);
      await signIn("google");
    } catch (error) {
      console.error("Error during sign in:", error);
      setError("No se pudo iniciar sesión con Google.");
      setSigningIn(false);
    }
  };

  const requestCode = async (targetEmail: string) => {
    const normalizedEmail = normalizeEmail(targetEmail);
    if (!normalizedEmail) {
      setError("Ingresa un correo válido.");
      return false;
    }

    const approval = await convex.query(
      api.data.approvedExternalUsers.checkExternalEmailApproved,
      { email: normalizedEmail }
    );

    if (!approval.approved) {
      setError("Este usuario no está autorizado para entrar.");
      return false;
    }

    await signIn(EXTERNAL_EMAIL_OTP_PROVIDER_ID, { email: normalizedEmail });
    setOtpEmail(normalizedEmail);
    setCodeValues(Array(CODE_LENGTH).fill(""));
    setResendSeconds(30);
    return true;
  };

  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setError(null);
      setRequestingCode(true);
      await requestCode(email);
    } catch (error) {
      console.error("Error requesting OTP:", error);
      setError("No se pudo enviar el código. Intenta nuevamente.");
    } finally {
      setRequestingCode(false);
    }
  };

  const handleVerifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canVerify) return;

    try {
      setError(null);
      setVerifyingCode(true);
      await signIn(EXTERNAL_EMAIL_OTP_PROVIDER_ID, {
        email: otpEmail,
        code,
      });
    } catch (error) {
      console.error("Error verifying OTP:", error);
      setError("El código no es válido o ya expiró.");
      setVerifyingCode(false);
    }
  };

  const handleCodeChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    setCodeValues((current) => {
      const next = [...current];
      next[index] = digit;
      return next;
    });

    if (digit && index < CODE_LENGTH - 1) {
      codeRefs.current[index + 1]?.focus();
    }
  };

  const handleCodeKeyDown = (
    index: number,
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Backspace" && !codeValues[index] && index > 0) {
      codeRefs.current[index - 1]?.focus();
    }
  };

  const handleCodePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const digits = event.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, CODE_LENGTH)
      .split("");

    if (digits.length === 0) return;

    setCodeValues(
      Array.from({ length: CODE_LENGTH }, (_, index) => digits[index] ?? "")
    );
    codeRefs.current[Math.min(digits.length, CODE_LENGTH) - 1]?.focus();
  };

  const handleResendCode = async () => {
    if (!otpEmail || resendSeconds > 0) return;

    try {
      setError(null);
      setResendingCode(true);
      await requestCode(otpEmail);
    } catch (error) {
      console.error("Error resending OTP:", error);
      setError("No se pudo reenviar el código. Intenta nuevamente.");
    } finally {
      setResendingCode(false);
    }
  };

  const handleBackToEmail = () => {
    setOtpEmail("");
    setCodeValues(Array(CODE_LENGTH).fill(""));
    setError(null);
  };

  if (isLoading || signingIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <div className="animate-pulse">
          <BrandLogoIcon className="w-32" forceColor="white" />
        </div>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <div className="text-white text-xl">Redirigiendo...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="absolute top-8 left-8">
        <BrandLogoIcon className="w-24" forceColor="white" />
      </div>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-8 p-10 bg-slate-800/50 backdrop-blur-sm rounded-2xl shadow-2xl border border-slate-700">
          <div className="text-center">
            <h2 className="text-white font-bold text-[24px]">
              {clientConfig.brand.name}
            </h2>
            <p className="mt-2 text-slate-400 text-sm">
              Inicia sesión para acceder al sistema
            </p>
          </div>

          <div className="space-y-5">
            <button
              onClick={handleGoogleSignIn}
              disabled={signingIn}
              className="w-full flex items-center justify-center gap-3 px-6 py-3.5 border border-slate-600 rounded-xl shadow-sm bg-white hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-primary transition-all duration-200 font-medium text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <GoogleIcon />
              <span>Iniciar sesión con Google</span>
            </button>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-700" />
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                O continuar con email
              </span>
              <div className="h-px flex-1 bg-slate-700" />
            </div>

            {!otpEmail ? (
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <label className="block">
                  <span className="block text-sm font-medium text-slate-200 mb-2">
                    Email
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    className="w-full rounded-xl border border-slate-600 bg-slate-900/70 px-4 py-3 text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                  />
                </label>
                <button
                  type="submit"
                  disabled={requestingCode}
                  className="w-full rounded-xl bg-white px-6 py-3.5 font-medium text-slate-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {requestingCode ? "Enviando..." : "Enviar código"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyCode} className="space-y-5">
                <div>
                  <button
                    type="button"
                    onClick={handleBackToEmail}
                    className="mb-3 text-sm font-medium text-slate-300 hover:text-white"
                  >
                    Cambiar email
                  </button>
                  <p className="text-sm text-slate-400">
                    Enviamos un código a{" "}
                    <span className="font-medium text-slate-200">
                      {otpEmail}
                    </span>
                  </p>
                </div>

                <div className="grid grid-cols-6 gap-2">
                  {codeValues.map((value, index) => (
                    <input
                      key={index}
                      ref={(input) => {
                        codeRefs.current[index] = input;
                      }}
                      type="text"
                      inputMode="numeric"
                      autoComplete={index === 0 ? "one-time-code" : "off"}
                      value={value}
                      onChange={(event) =>
                        handleCodeChange(index, event.target.value)
                      }
                      onKeyDown={(event) => handleCodeKeyDown(index, event)}
                      onPaste={handleCodePaste}
                      className="aspect-square w-full rounded-lg border border-slate-600 bg-slate-900/70 text-center text-xl font-semibold text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                    />
                  ))}
                </div>

                <button
                  type="submit"
                  disabled={!canVerify}
                  className="w-full rounded-xl bg-white px-6 py-3.5 font-medium text-slate-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {verifyingCode ? "Verificando..." : "Entrar"}
                </button>

                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resendingCode || resendSeconds > 0}
                  className="w-full text-sm font-medium text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resendSeconds > 0
                    ? `Reenviar código en ${resendSeconds}s`
                    : resendingCode
                      ? "Reenviando..."
                      : "Reenviar código"}
                </button>
              </form>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
