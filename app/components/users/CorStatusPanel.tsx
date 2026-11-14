import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react";
import { formatDateTime, type InternalUser } from "@/app/lib/internalUsers";
import { Button } from "../ui/Button";

export function CorStatusPanel({
  user,
  isResolving,
  isVerifying,
  onResolve,
  onVerify,
}: {
  user: InternalUser;
  isResolving: boolean;
  isVerifying: boolean;
  onResolve: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {user.corUser ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-red-500" />
            )}
            <h3 className="text-sm font-semibold text-foreground">
              Usuario COR
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Obligatorio para crear tasks con el agente interno.
          </p>
        </div>
        <Button
          type="button"
          variant={user.corUser ? "outline" : "default"}
          className="cursor-pointer"
          onClick={user.corUser ? onVerify : onResolve}
          disabled={isResolving || isVerifying}
        >
          <RefreshCcw className="h-4 w-4" />
          {user.corUser
            ? isVerifying
              ? "Verificando..."
              : "Verificar"
            : isResolving
              ? "Validando..."
              : "Validar en COR"}
        </Button>
      </div>

      {user.corUser ? (
        <div className="mt-4 space-y-1 text-sm">
          <div className="text-foreground">
            {user.corUser.corFirstName} {user.corUser.corLastName}
          </div>
          <div className="text-muted-foreground">
            COR ID {user.corUser.corUserId} · {user.corUser.corEmail}
          </div>
          <div className="text-xs text-muted-foreground">
            {user.corUser.lastVerifiedAt
              ? `Verificado ${formatDateTime(user.corUser.lastVerifiedAt)}`
              : `Resuelto ${formatDateTime(user.corUser.resolvedAt)}`}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          Falta validar este usuario en COR. Sin esta verificación, el agente no
          podrá crear tasks para este usuario aunque tenga clientes asignados.
        </div>
      )}
    </div>
  );
}
