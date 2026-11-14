import { CheckCircle2, Circle } from "lucide-react";
import type { InternalUser } from "@/app/lib/internalUsers";

export function PermissionStatusPanel({ user }: { user: InternalUser }) {
  const hasPermissions = user.assignments.length > 0;

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-center gap-2">
        {hasPermissions ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <Circle className="h-4 w-4 text-amber-500" />
        )}
        <h3 className="text-sm font-semibold text-foreground">Permisos</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Necesita al menos un cliente o categoría para trabajar con briefs.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-lg font-semibold text-foreground">
            {user.fullClientCount}
          </div>
          <div className="text-xs text-muted-foreground">
            clientes completos
          </div>
        </div>
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-lg font-semibold text-foreground">
            {user.brandCount}
          </div>
          <div className="text-xs text-muted-foreground">categorías</div>
        </div>
      </div>
    </div>
  );
}
