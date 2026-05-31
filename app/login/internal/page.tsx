"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogoIcon } from "../../components/BrandLogo";
import { useUser } from "../../UserContextProvider";

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

export default function InternalLoginPage() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useUser();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !signingIn && isAuthenticated) {
      router.replace("/workspace");
    }
  }, [isAuthenticated, isLoading, signingIn, router]);

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
        <div className="max-w-md w-full space-y-7 p-8 sm:p-10 bg-slate-800/50 backdrop-blur-sm rounded-2xl shadow-2xl border border-slate-700">
          <div className="text-center">
            <h2 className="text-white font-bold text-[24px]">
              Acceso interno
            </h2>
            <p className="mt-2 text-slate-400 text-sm">
              Usa tu cuenta corporativa de Google.
            </p>
          </div>

          <div className="space-y-4">
            <section className="rounded-2xl border border-slate-700/80 bg-slate-900/35 p-4 sm:p-5">
              <button
                onClick={handleGoogleSignIn}
                disabled={signingIn}
                className="w-full flex items-center justify-center gap-3 px-6 py-3.5 border border-slate-600 rounded-xl shadow-sm bg-white hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-primary transition-all duration-200 font-medium text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <GoogleIcon />
                <span>Iniciar sesión con Google</span>
              </button>
            </section>

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <p className="text-center text-sm text-slate-400">
              Clientes externos ingresan con email{" "}
              <Link
                href="/login"
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
