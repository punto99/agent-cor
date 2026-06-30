"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "@/convex/_generated/api";
import { useUser } from "../UserContextProvider";
import { BrandLogoIcon } from "../components/BrandLogo";

const EXTERNAL_EMAIL_OTP_PROVIDER_ID = "external-email-otp";
const CODE_LENGTH = 6;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useUser();
  const [email, setEmail] = useState("");
  const [otpEmail, setOtpEmail] = useState("");
  const [codeValues, setCodeValues] = useState<string[]>(
    Array(CODE_LENGTH).fill(""),
  );
  const [requestingCode, setRequestingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [resendingCode, setResendingCode] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const codeRefs = useRef<Array<HTMLInputElement | null>>([]);
  const lastSubmittedCodeRef = useRef("");

  const code = codeValues.join("");
  const canVerify = code.length === CODE_LENGTH && !verifyingCode;

  const getOtpRequestErrorMessage = (error: unknown, fallback: string) => {
    if (String(error).includes("OTP_RESEND_RATE_LIMITED")) {
      return "Se alcanzó el límite de reenvíos. Intenta nuevamente en unos minutos.";
    }
    return fallback;
  };

  const verifyCode = useCallback(
    async (codeToVerify: string) => {
      if (!otpEmail || codeToVerify.length !== CODE_LENGTH || verifyingCode) {
        return;
      }

      lastSubmittedCodeRef.current = codeToVerify;

      try {
        setError(null);
        setVerifyingCode(true);
        await signIn(EXTERNAL_EMAIL_OTP_PROVIDER_ID, {
          email: otpEmail,
          code: codeToVerify,
        });
      } catch (error) {
        console.error("Error verifying OTP:", error);
        setError("El código no es válido o ya expiró.");
        setVerifyingCode(false);
      }
    },
    [otpEmail, signIn, verifyingCode],
  );

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/workspace");
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(
      () => setResendSeconds((seconds) => seconds - 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (otpEmail) {
      codeRefs.current[0]?.focus();
    }
  }, [otpEmail]);

  useEffect(() => {
    if (code.length < CODE_LENGTH) {
      lastSubmittedCodeRef.current = "";
      return;
    }

    if (!otpEmail || verifyingCode || lastSubmittedCodeRef.current === code) {
      return;
    }

    void verifyCode(code);
  }, [code, otpEmail, verifyingCode, verifyCode]);

  const requestCode = async (targetEmail: string) => {
    const normalizedEmail = normalizeEmail(targetEmail);
    if (!normalizedEmail) {
      setError("Ingresa un correo válido.");
      return false;
    }

    const approval = await convex.query(
      api.data.approvedExternalUsers.checkExternalEmailApproved,
      { email: normalizedEmail },
    );

    if (!approval.approved) {
      setError("Este usuario no está autorizado para entrar.");
      return false;
    }

    await signIn(EXTERNAL_EMAIL_OTP_PROVIDER_ID, { email: normalizedEmail });
    setOtpEmail(normalizedEmail);
    setCodeValues(Array(CODE_LENGTH).fill(""));
    lastSubmittedCodeRef.current = "";
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
      setError(
        getOtpRequestErrorMessage(
          error,
          "No se pudo enviar el código. Intenta nuevamente.",
        ),
      );
    } finally {
      setRequestingCode(false);
    }
  };

  const handleVerifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canVerify) return;

    await verifyCode(code);
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
    event: KeyboardEvent<HTMLInputElement>,
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
      Array.from({ length: CODE_LENGTH }, (_, index) => digits[index] ?? ""),
    );
    codeRefs.current[Math.min(digits.length, CODE_LENGTH) - 1]?.focus();
  };

  const handleResendCode = async () => {
    if (!otpEmail) return;

    if (resendSeconds > 0) {
      setError("Espera un momento antes de reenviar otro código.");
      return;
    }

    try {
      setError(null);
      setResendingCode(true);
      await requestCode(otpEmail);
    } catch (error) {
      console.error("Error resending OTP:", error);
      setError(
        getOtpRequestErrorMessage(
          error,
          "No se pudo reenviar el código. Intenta nuevamente.",
        ),
      );
    } finally {
      setResendingCode(false);
    }
  };

  const handleBackToEmail = () => {
    setOtpEmail("");
    setCodeValues(Array(CODE_LENGTH).fill(""));
    lastSubmittedCodeRef.current = "";
    setResendSeconds(0);
    setError(null);
  };

  if (isLoading) {
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
        <div className="max-w-lg w-full space-y-7 p-8 sm:p-10 bg-slate-800/50 backdrop-blur-sm rounded-2xl shadow-2xl border border-slate-700">
          <div className="text-center">
            <h2 className="text-white font-bold text-[24px]">
              Acceso para clientes
            </h2>
            <p className="mt-2 text-slate-400 text-sm">
              Ingresa con el email autorizado. Te enviaremos un código de
              acceso.
            </p>
          </div>

          <div className="space-y-4">
            <section className="rounded-2xl border border-slate-700/80 bg-slate-900/35 p-4 sm:p-5">
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
                      className="w-full rounded-xl border border-slate-600 bg-slate-950/50 px-4 py-3 text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={requestingCode}
                    className="w-full rounded-xl bg-white px-6 py-3.5 font-medium text-slate-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  >
                    {requestingCode ? "Enviando..." : "Enviar código de acceso"}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleVerifyCode} className="space-y-5">
                  <div>
                    <button
                      type="button"
                      onClick={handleBackToEmail}
                      className="mb-3 text-sm font-medium text-slate-300 hover:text-white cursor-pointer"
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
                        className="aspect-square w-full rounded-lg border border-slate-600 bg-slate-950/50 text-center text-xl font-semibold text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                      />
                    ))}
                  </div>

                  <button
                    type="submit"
                    disabled={!canVerify}
                    className="w-full rounded-xl bg-white px-6 py-3.5 font-medium text-slate-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  >
                    {verifyingCode ? "Verificando..." : "Entrar"}
                  </button>

                  <p className="text-center text-sm text-slate-400">
                    ¿No recibiste el código?{" "}
                    <button
                      type="button"
                      onClick={handleResendCode}
                      disabled={resendingCode}
                      className="font-medium text-white underline underline-offset-4 transition hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                    >
                      {resendingCode ? "Reenviando..." : "Reenviar código"}
                    </button>
                  </p>
                </form>
              )}
            </section>

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <p className="text-center text-sm text-slate-400">
              Equipo interno inicia sesión{" "}
              <Link
                href="/login/internal"
                className="font-medium text-white underline underline-offset-4 transition hover:text-slate-200"
              >
                aquí
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
