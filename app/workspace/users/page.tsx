"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserCog,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";
import { Button } from "../../components/ui/Button";

type AdminUser = {
  _id: Id<"users">;
  name: string;
  email: string;
  image?: string;
  corUser: {
    corUserId: number;
    corFirstName: string;
    corLastName: string;
    corEmail: string;
    corRoleId?: number;
    corPositionName?: string;
    resolvedAt: number;
    lastVerifiedAt?: number;
  } | null;
  assignments: Array<{
    _id: Id<"clientUserAssignments">;
    clientId: Id<"corClients">;
    brandId?: Id<"clientBrands">;
    assignedAt: number;
    assignedBy?: Id<"users">;
  }>;
  fullClientCount: number;
  brandCount: number;
  isCompleteForBrief: boolean;
};

type AdminClient = {
  _id: Id<"corClients">;
  name: string;
  corClientId: number;
  nomenclature?: string;
  brands: Array<{
    _id: Id<"clientBrands">;
    name: string;
    corBrandId: number;
    trelloBoardId?: string;
  }>;
};

type Dashboard = {
  canAccess: true;
  users: AdminUser[];
  clients: AdminClient[];
  generatedAt: number;
};

type Toast = {
  type: "success" | "error";
  message: string;
};

export default function InternalUsersAdminPage() {
  const router = useRouter();
  const access = useQuery(
    api.data.internalUserAdmin.viewerCanAccessInternalUserAdmin,
  );
  const dashboard = useQuery(api.data.internalUserAdmin.getDashboard) as
    | Dashboard
    | { canAccess: false }
    | undefined;
  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    {},
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);
  const resolveInCOR = useAction(
    api.data.internalUserAdminActions.resolveInternalUserInCORNow,
  );
  const verifyInCOR = useAction(
    api.data.internalUserAdminActions.verifyInternalUserInCORNow,
  );
  const setAssignments = useMutation(
    api.data.internalUserAdmin.setInternalUserAssignments,
  );

  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [clientPermissionSearch, setClientPermissionSearch] = useState("");
  const [showAssignedClientsOnly, setShowAssignedClientsOnly] = useState(false);
  const [draftFullClientIds, setDraftFullClientIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [draftBrandIds, setDraftBrandIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [resolvingUserId, setResolvingUserId] = useState<string | null>(null);
  const [verifyingUserId, setVerifyingUserId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (access && !access.canAccess) {
      router.replace("/workspace");
    }
  }, [access, router]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const canAccess = dashboard?.canAccess === true;
  const users = canAccess ? dashboard.users : [];
  const clients = canAccess ? dashboard.clients : [];

  const visibleUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term),
    );
  }, [search, users]);

  const selectedUser = useMemo(() => {
    if (users.length === 0) return null;
    return (
      users.find((user) => String(user._id) === selectedUserId) ??
      visibleUsers[0] ??
      users[0]
    );
  }, [selectedUserId, users, visibleUsers]);

  useEffect(() => {
    if (!selectedUser) {
      setSelectedUserId(null);
      return;
    }
    if (String(selectedUser._id) !== selectedUserId) {
      setSelectedUserId(String(selectedUser._id));
    }
  }, [selectedUser, selectedUserId]);

  useEffect(() => {
    if (!selectedUser) {
      setDraftFullClientIds(new Set());
      setDraftBrandIds(new Set());
      return;
    }

    setDraftFullClientIds(
      new Set(
        selectedUser.assignments
          .filter((assignment) => !assignment.brandId)
          .map((assignment) => String(assignment.clientId)),
      ),
    );
    setDraftBrandIds(
      new Set(
        selectedUser.assignments
          .filter((assignment) => assignment.brandId)
          .map((assignment) => String(assignment.brandId)),
      ),
    );
  }, [selectedUser?._id, selectedUser?.assignments]);

  const currentFullClientIds = useMemo(
    () =>
      new Set(
        selectedUser?.assignments
          .filter((assignment) => !assignment.brandId)
          .map((assignment) => String(assignment.clientId)) ?? [],
      ),
    [selectedUser],
  );
  const currentBrandIds = useMemo(
    () =>
      new Set(
        selectedUser?.assignments
          .filter((assignment) => assignment.brandId)
          .map((assignment) => String(assignment.brandId)) ?? [],
      ),
    [selectedUser],
  );
  const hasPermissionChanges =
    !sameStringSet(currentFullClientIds, draftFullClientIds) ||
    !sameStringSet(currentBrandIds, draftBrandIds);

  const summary = useMemo(() => {
    const completeUsers = users.filter(
      (user) => user.isCompleteForBrief,
    ).length;
    const missingCor = users.filter((user) => !user.corUser).length;
    const missingPermissions = users.filter(
      (user) => user.corUser && user.assignments.length === 0,
    ).length;
    return { completeUsers, missingCor, missingPermissions };
  }, [users]);

  const visiblePermissionClients = useMemo(() => {
    const term = clientPermissionSearch.trim().toLowerCase();

    return clients.filter((client) => {
      const hasFullClientAccess = draftFullClientIds.has(String(client._id));
      const hasBrandAccess = client.brands.some((brand) =>
        draftBrandIds.has(String(brand._id)),
      );
      const isAssigned = hasFullClientAccess || hasBrandAccess;

      if (showAssignedClientsOnly && !isAssigned) return false;
      if (!term) return true;

      return (
        client.name.toLowerCase().includes(term) ||
        String(client.corClientId).includes(term) ||
        client.nomenclature?.toLowerCase().includes(term) ||
        client.brands.some((brand) => brand.name.toLowerCase().includes(term))
      );
    });
  }, [
    clients,
    clientPermissionSearch,
    draftBrandIds,
    draftFullClientIds,
    showAssignedClientsOnly,
  ]);

  const handleNewThread = async () => {
    await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    router.push("/workspace");
  };

  const handleSelectThread = () => {
    router.push("/workspace");
  };

  const handleResolveInCOR = async () => {
    if (!selectedUser) return;
    try {
      setResolvingUserId(String(selectedUser._id));
      const result = await resolveInCOR({ targetUserId: selectedUser._id });
      if (!result.ok) {
        setToast({
          type: "error",
          message: result.error,
        });
        return;
      }
      setToast({
        type: "success",
        message: `Usuario validado en COR: ${result.name || result.email || result.corUserId}.`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(
          error,
          "No se pudo validar el usuario en COR.",
        ),
      });
    } finally {
      setResolvingUserId(null);
    }
  };

  const handleVerifyInCOR = async () => {
    if (!selectedUser) return;
    try {
      setVerifyingUserId(String(selectedUser._id));
      const result = await verifyInCOR({ targetUserId: selectedUser._id });
      if (!result.ok) {
        setToast({
          type: "error",
          message: result.error,
        });
        return;
      }
      setToast({
        type: "success",
        message: `Usuario verificado en COR: ${result.name || result.email || result.corUserId}.`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(
          error,
          "No se pudo verificar el usuario en COR.",
        ),
      });
    } finally {
      setVerifyingUserId(null);
    }
  };

  const handleSaveAssignments = async () => {
    if (!selectedUser) return;
    try {
      setSaving(true);
      await setAssignments({
        targetUserId: selectedUser._id,
        fullClientIds: Array.from(draftFullClientIds) as Id<"corClients">[],
        brandIds: Array.from(draftBrandIds) as Id<"clientBrands">[],
      });
      setToast({
        type: "success",
        message: "Permisos actualizados.",
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No se pudieron guardar los permisos."),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetDraft = () => {
    setDraftFullClientIds(new Set(currentFullClientIds));
    setDraftBrandIds(new Set(currentBrandIds));
  };

  const toggleFullClient = (client: AdminClient) => {
    setDraftFullClientIds((current) => {
      const next = new Set(current);
      if (next.has(String(client._id))) {
        next.delete(String(client._id));
      } else {
        next.add(String(client._id));
      }
      return next;
    });
    setDraftBrandIds((current) => {
      const next = new Set(current);
      for (const brand of client.brands) next.delete(String(brand._id));
      return next;
    });
  };

  const toggleBrand = (client: AdminClient, brandId: string) => {
    setDraftFullClientIds((current) => {
      const next = new Set(current);
      next.delete(String(client._id));
      return next;
    });
    setDraftBrandIds((current) => {
      const next = new Set(current);
      if (next.has(brandId)) next.delete(brandId);
      else next.add(brandId);
      return next;
    });
  };

  if (
    access === undefined ||
    dashboard === undefined ||
    threadsStatus === "LoadingFirstPage" ||
    !access.canAccess ||
    !canAccess
  ) {
    return <LoadingScreen />;
  }

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={handleSelectThread}
    >
      <div className="h-full flex flex-col bg-background">
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
                Administra COR y permisos de clientes para que puedan crear
                tasks con el agente de briefs.
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

        {toast && (
          <div
            className={`mx-6 mt-4 rounded-md border px-4 py-3 text-sm ${
              toast.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            }`}
          >
            {toast.message}
          </div>
        )}

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          <aside className="border-r border-border bg-card min-h-0 flex flex-col">
            <div className="p-4 border-b border-border">
              <div className="relative">
                <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar usuario"
                  className="w-full h-9 rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {visibleUsers.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No hay usuarios internos para mostrar.
                </div>
              ) : (
                <div className="space-y-1">
                  {visibleUsers.map((user) => {
                    const isSelected = String(user._id) === selectedUserId;
                    return (
                      <button
                        key={user._id}
                        type="button"
                        onClick={() => setSelectedUserId(String(user._id))}
                        className={`w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                          isSelected
                            ? "bg-primary/10 text-primary"
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
                          {user.isCompleteForBrief ? (
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

          <main className="min-h-0 overflow-y-auto">
            {!selectedUser ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Selecciona un usuario interno.
              </div>
            ) : (
              <div className="p-6 max-w-6xl space-y-5">
                <section className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={selectedUser} size="lg" />
                      <div>
                        <h2 className="text-lg font-semibold text-foreground">
                          {selectedUser.name}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {selectedUser.email || "Sin email"}
                        </p>
                      </div>
                    </div>
                    <ReadinessBadge user={selectedUser} />
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
                    <CorStatusPanel
                      user={selectedUser}
                      isResolving={resolvingUserId === String(selectedUser._id)}
                      isVerifying={verifyingUserId === String(selectedUser._id)}
                      onResolve={handleResolveInCOR}
                      onVerify={handleVerifyInCOR}
                    />
                    <PermissionStatusPanel user={selectedUser} />
                  </div>
                </section>

                <section className="rounded-lg border border-border bg-card">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
                    <div>
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                        <h3 className="text-sm font-semibold text-foreground">
                          Permisos de clientes y categorías
                        </h3>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Acceso completo al cliente permite trabajar con todas
                        sus categorías. Si no, selecciona categorías
                        específicas.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="cursor-pointer"
                        onClick={handleResetDraft}
                        disabled={!hasPermissionChanges || saving}
                      >
                        Descartar
                      </Button>
                      <Button
                        type="button"
                        className="cursor-pointer"
                        onClick={handleSaveAssignments}
                        disabled={!hasPermissionChanges || saving}
                      >
                        {saving ? "Guardando..." : "Guardar permisos"}
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
                    <div className="relative min-w-[240px] flex-1">
                      <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={clientPermissionSearch}
                        onChange={(event) =>
                          setClientPermissionSearch(event.target.value)
                        }
                        placeholder="Buscar cliente o categoría"
                        className="w-full h-9 rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>

                    <label className="inline-flex h-9 cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={showAssignedClientsOnly}
                        onChange={(event) =>
                          setShowAssignedClientsOnly(event.target.checked)
                        }
                        className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
                      />
                      Solo asignados
                    </label>
                  </div>

                  <div className="divide-y divide-border">
                    {clients.length === 0 ? (
                      <div className="px-4 py-8 text-sm text-muted-foreground">
                        No hay clientes locales sincronizados.
                      </div>
                    ) : visiblePermissionClients.length === 0 ? (
                      <div className="px-4 py-8 text-sm text-muted-foreground">
                        No hay clientes que coincidan con el filtro actual.
                      </div>
                    ) : (
                      visiblePermissionClients.map((client) => {
                        const fullSelected = draftFullClientIds.has(
                          String(client._id),
                        );
                        const selectedBrandCount = client.brands.filter(
                          (brand) => draftBrandIds.has(String(brand._id)),
                        ).length;
                        const hasCategories = client.brands.length > 0;
                        const assignmentLabel = hasCategories
                          ? fullSelected
                            ? "Todas las categorías"
                            : `${selectedBrandCount} de ${client.brands.length} categoría${
                                client.brands.length !== 1 ? "s" : ""
                              }`
                          : fullSelected
                            ? "Cliente asignado"
                            : "Sin categorías";
                        const fullAccessLabel = hasCategories
                          ? "Acceso completo"
                          : "Acceso al cliente";

                        return (
                          <div key={client._id} className="px-4 py-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-foreground">
                                  {client.name}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  COR {client.corClientId}
                                  {client.nomenclature
                                    ? ` · ${client.nomenclature}`
                                    : ""}
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center justify-end gap-3">
                                <span className="text-xs text-muted-foreground">
                                  {assignmentLabel}
                                </span>

                                <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground">
                                  <input
                                    type="checkbox"
                                    checked={fullSelected}
                                    onChange={() => toggleFullClient(client)}
                                    className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
                                  />
                                  {fullAccessLabel}
                                </label>
                              </div>
                            </div>

                            {client.brands.length > 0 && (
                              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {client.brands.map((brand) => (
                                  <label
                                    key={brand._id}
                                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                                      fullSelected
                                        ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground"
                                        : "cursor-pointer border-border bg-background text-foreground hover:bg-accent"
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      disabled={fullSelected}
                                      checked={
                                        fullSelected ||
                                        draftBrandIds.has(String(brand._id))
                                      }
                                      onChange={() =>
                                        toggleBrand(client, String(brand._id))
                                      }
                                      className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {brand.name}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
      </div>
    </WorkspaceLayout>
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

function UserAvatar({
  user,
  size = "md",
}: {
  user: AdminUser;
  size?: "md" | "lg";
}) {
  const classes = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";
  const initials = getInitials(user.name, user.email);

  if (user.image) {
    return (
      <img
        src={user.image}
        alt={user.name}
        className={`${classes} rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-medium`}
    >
      {initials}
    </div>
  );
}

function ReadinessBadge({ user }: { user: AdminUser }) {
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

function CorStatusPanel({
  user,
  isResolving,
  isVerifying,
  onResolve,
  onVerify,
}: {
  user: AdminUser;
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

function PermissionStatusPanel({ user }: { user: AdminUser }) {
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

function sameStringSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function getInitials(name: string, email: string) {
  const source = name || email || "U";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
