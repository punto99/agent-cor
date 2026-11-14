import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { InternalUser } from "@/app/lib/internalUsers";
import { UserRolesEditor } from "../UserRolesEditor";
import { UserAvatar } from "./UserAvatar";
import { CorStatusPanel } from "./CorStatusPanel";
import { PermissionStatusPanel } from "./PermissionStatusPanel";

type InternalUserProfileProps = {
  user: InternalUser;
  isResolving: boolean;
  isVerifying: boolean;
  onResolve: () => void;
  onVerify: () => void;
};

export function InternalUserProfile({
  user,
  isResolving,
  isVerifying,
  onResolve,
  onVerify,
}: InternalUserProfileProps) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <UserAvatar user={user} size="lg" />
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {user.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              {user.email || "Sin email"}
            </p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-start gap-2">
          <ReadinessBadge user={user} />
          <UserRolesEditor
            key={user._id}
            kind="internal"
            userId={user._id}
            platformRole={user.roleProfile?.platformRole}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <CorStatusPanel
          user={user}
          isResolving={isResolving}
          isVerifying={isVerifying}
          onResolve={onResolve}
          onVerify={onVerify}
        />
        <PermissionStatusPanel user={user} />
      </div>
    </section>
  );
}

function ReadinessBadge({ user }: { user: InternalUser }) {
  if (user.isCompleteForBrief) {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <CheckCircle2 className="h-4 w-4" />
        Listo para crear briefs
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4" />
      Configuración incompleta
    </div>
  );
}
