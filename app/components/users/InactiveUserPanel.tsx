import { UserRoundMinus } from "lucide-react";
import type { InternalUser } from "@/app/lib/internalUsers";
import { UserAvatar } from "./UserAvatar";

export function InactiveUserPanel({ user }: { user: InternalUser }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-5 sm:p-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="opacity-70 grayscale">
            <UserAvatar user={user} size="lg" />
          </div>
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold text-foreground">
              {user.name}
            </h2>
            <p className="break-all text-sm text-muted-foreground">
              {user.email || "Sin email"}
            </p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-500"
            aria-hidden="true"
          />
          Inactivo
        </span>
      </div>

      <div className="bg-linear-to-b from-muted/40 to-card px-6 py-14 text-center sm:py-20">
        <div className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-background shadow-sm">
          <UserRoundMinus
            className="h-9 w-9 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="absolute -bottom-1.5 -right-1.5 flex h-7 w-7 items-center justify-center rounded-full border-4 border-card bg-amber-100 dark:bg-amber-950">
            <span className="h-0.5 w-2.5 rounded-full bg-amber-600 dark:bg-amber-300" />
          </span>
        </div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          Usuario inactivo
        </h3>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          Este usuario ya no está activo en la plataforma. Los permisos de
          clientes y categorías no están disponibles mientras permanezca
          inactivo.
        </p>
        <div className="mx-auto mt-8 max-w-md rounded-lg border border-border bg-background/70 px-4 py-3 text-xs leading-5 text-muted-foreground">
          Su información se conserva como referencia.
        </div>
      </div>
    </section>
  );
}
