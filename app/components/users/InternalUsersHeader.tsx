import { UserCog } from "lucide-react";
import type { InternalUsersSummary } from "@/app/lib/internalUsers";

export function InternalUsersHeader({
  summary,
}: {
  summary: InternalUsersSummary;
}) {
  return (
    <div className="border-b border-border bg-card px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold text-foreground">
              Usuarios internos
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Administra COR y permisos de clientes para que puedan crear tasks
            con el agente de briefs.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <SummaryPill label="Completos" value={summary.completeUsers} />
          <SummaryPill label="Sin COR" value={summary.missingCor} />
          <SummaryPill
            label="Sin permisos"
            value={summary.missingPermissions}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
