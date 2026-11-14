import {
  AlertTriangle,
  CheckCircle2,
  Search,
  UserRoundMinus,
} from "lucide-react";
import type { InternalUser, InternalUserStatus } from "@/app/lib/internalUsers";
import { UserAvatar } from "./UserAvatar";

type InternalUsersSidebarProps = {
  search: string;
  onSearchChange: (search: string) => void;
  userStatus: InternalUserStatus;
  onStatusChange: (status: InternalUserStatus) => void;
  activeCount: number;
  inactiveCount: number;
  users: InternalUser[];
  selectedUserId: InternalUser["_id"] | null;
  onSelectUser: (userId: InternalUser["_id"]) => void;
};

export function InternalUsersSidebar({
  search,
  onSearchChange,
  userStatus,
  onStatusChange,
  activeCount,
  inactiveCount,
  users,
  selectedUserId,
  onSelectUser,
}: InternalUsersSidebarProps) {
  return (
    <aside className="border-r border-border bg-card min-h-0 flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="relative">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Buscar usuario"
            aria-label="Buscar usuario"
            className="w-full h-9 rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div
          className="mt-3 flex gap-2"
          role="group"
          aria-label="Estado de los usuarios"
        >
          {(
            [
              { value: "active", label: "Activos", count: activeCount },
              { value: "inactive", label: "Inactivos", count: inactiveCount },
            ] as const
          ).map((status) => (
            <button
              key={status.value}
              type="button"
              aria-pressed={userStatus === status.value}
              onClick={() => onStatusChange(status.value)}
              className={`inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card ${
                userStatus === status.value
                  ? "border-primary/30 bg-primary/10 text-primary dark:text-indigo-300"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {status.label}
              <span className="tabular-nums">({status.count})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {users.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {search.trim()
              ? `No hay usuarios ${userStatus === "active" ? "activos" : "inactivos"} que coincidan con la búsqueda.`
              : `No hay usuarios ${userStatus === "active" ? "activos" : "inactivos"}.`}
          </div>
        ) : (
          <div className="space-y-1">
            {users.map((user) => {
              const isSelected = user._id === selectedUserId;
              return (
                <button
                  key={user._id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectUser(user._id)}
                  className={`w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-primary/10 text-primary dark:text-indigo-300"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <UserAvatar user={user} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {user.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {user.email || "Sin email"}
                      </div>
                    </div>
                    {user.corUser?.isActive === false ? (
                      <span
                        className="shrink-0 text-muted-foreground"
                        title="Usuario inactivo"
                      >
                        <UserRoundMinus
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                        <span className="sr-only">Usuario inactivo</span>
                      </span>
                    ) : user.isCompleteForBrief ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
