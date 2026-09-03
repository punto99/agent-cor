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
  ChevronDown,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LinkIcon,
  Mail,
  Search,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";
import { Button } from "../../components/ui/Button";

type ExternalStatus =
  | "pending_registration"
  | "missing_categories"
  | "missing_trello"
  | "missing_boards"
  | "needs_trello_check"
  | "trello_error"
  | "ready";

type ExternalUser = {
  _id: Id<"approvedExternalUsers">;
  email: string;
  name?: string;
  userId?: Id<"users">;
  linkedUserName?: string;
  createdAt: number;
  trelloMemberId?: string;
  trelloUsername?: string;
  trelloMemberEmail?: string;
  trelloMemberFullName?: string;
  trelloMemberSyncStatus?: string;
  trelloMemberSyncError?: string;
  trelloMemberVerifiedAt?: number;
  assignments: Array<{
    _id: Id<"clientUserAssignments">;
    clientId: Id<"corClients">;
    brandId?: Id<"clientBrands">;
    assignedAt: number;
    clientName?: string;
    brandName?: string;
    trelloBoardId?: string;
  }>;
  invitedAccess: Array<{
    clientId: Id<"corClients">;
    clientName: string;
    corClientId: number;
    allBrands: boolean;
    brands: Array<{
      _id: Id<"clientBrands">;
      name: string;
      corBrandId: number;
      trelloBoardId?: string;
      trelloEnabled: boolean;
    }>;
  }>;
  assignedBrandCount: number;
  fullClientCount: number;
  brandCount: number;
  missingBoardCount: number;
  trelloRequired: boolean;
  status: ExternalStatus;
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
    trelloBoardUrl?: string;
  }>;
};

type Dashboard = {
  canAccess: true;
  users: ExternalUser[];
  clients: AdminClient[];
  generatedAt: number;
};

type Toast = {
  type: "success" | "error";
  message: string;
};

type TrelloCandidate = {
  id: string;
  username?: string;
  fullName?: string;
  email?: string;
  memberType?: string;
  confirmed?: boolean;
  matchReason: string;
};

type TrelloSearchResult = {
  brandName: string;
  boardId: string;
  candidates: TrelloCandidate[];
};

type TrelloBoardCandidate = {
  id: string;
  name: string;
  url?: string;
  shortUrl?: string;
  matchReason: string;
};

type TrelloBoardSearchResult = {
  brandName: string;
  boards: TrelloBoardCandidate[];
};

type BoardDialogBrand = {
  _id: Id<"clientBrands">;
  name: string;
  trelloBoardId?: string;
  trelloBoardUrl?: string;
};

export default function ExternalUsersAdminPage() {
  const router = useRouter();
  const access = useQuery(
    api.data.externalUserAdmin.viewerCanAccessExternalUserAdmin,
  );
  const dashboard = useQuery(api.data.externalUserAdmin.getDashboard) as
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
  const upsertApprovedExternalUser = useMutation(
    api.data.externalUserAdmin.upsertApprovedExternalUser,
  );
  const setAssignments = useMutation(
    api.data.externalUserAdmin.setExternalUserBrandAssignments,
  );
  const setTrelloMember = useMutation(
    api.data.externalUserAdmin.setExternalTrelloMember,
  );
  const searchTrelloMembers = useAction(
    api.data.externalUserAdminActions.searchTrelloMembersForExternalUser,
  );
  const verifyTrelloAccess = useAction(
    api.data.externalUserAdminActions.verifyExternalUserTrelloAccess,
  );
  const searchTrelloBoards = useAction(
    api.data.externalUserAdminActions.searchTrelloBoardsForBrand,
  );
  const associateTrelloBoard = useAction(
    api.data.externalUserAdminActions.associateTrelloBoardToBrand,
  );

  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newClientId, setNewClientId] = useState<string | null>(null);
  const [newClientSearch, setNewClientSearch] = useState("");
  const [newBrandIds, setNewBrandIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [categorySearch, setCategorySearch] = useState("");
  const [showAssignedOnly, setShowAssignedOnly] = useState(false);
  const [draftFullClientIds, setDraftFullClientIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [draftBrandIds, setDraftBrandIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [searchingTrello, setSearchingTrello] = useState(false);
  const [verifyingTrello, setVerifyingTrello] = useState(false);
  const [trelloResult, setTrelloResult] = useState<TrelloSearchResult | null>(
    null,
  );
  const [boardDialogBrand, setBoardDialogBrand] =
    useState<BoardDialogBrand | null>(null);
  const [boardSearchTerm, setBoardSearchTerm] = useState("");
  const [boardResult, setBoardResult] =
    useState<TrelloBoardSearchResult | null>(null);
  const [searchingBoards, setSearchingBoards] = useState(false);
  const [associatingBoardId, setAssociatingBoardId] = useState<string | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (access && !access.canAccess) router.replace("/workspace");
  }, [access, router]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const canAccess = dashboard?.canAccess === true;
  const users = canAccess ? dashboard.users : [];
  const clients = canAccess ? dashboard.clients : [];
  const selectedNewClient = useMemo(
    () =>
      newClientId
        ? clients.find((client) => String(client._id) === newClientId) ?? null
        : null,
    [clients, newClientId],
  );

  useEffect(() => {
    setNewBrandIds(new Set());
  }, [newClientId]);

  const visibleUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter(
      (user) =>
        user.email.toLowerCase().includes(term) ||
        user.name?.toLowerCase().includes(term) ||
        user.linkedUserName?.toLowerCase().includes(term),
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
    setTrelloResult(null);
    setDraftFullClientIds(
      new Set(
        selectedUser?.assignments
          .filter((assignment) => !assignment.brandId)
          .map((assignment) => String(assignment.clientId)) ?? [],
      ),
    );
    setDraftBrandIds(
      new Set(
        selectedUser?.assignments
          .filter((assignment) => assignment.brandId)
          .map((assignment) => String(assignment.brandId)) ?? [],
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

  const visibleClients = useMemo(() => {
    const term = categorySearch.trim().toLowerCase();
    return clients
      .map((client) => {
        const fullSelected = draftFullClientIds.has(String(client._id));
        const clientMatches =
          !term ||
          client.name.toLowerCase().includes(term) ||
          String(client.corClientId).includes(term) ||
          client.nomenclature?.toLowerCase().includes(term);
        const brands = client.brands.filter((brand) => {
          const isAssigned = draftBrandIds.has(String(brand._id));
          if (showAssignedOnly && !fullSelected && !isAssigned) return false;
          if (!term || clientMatches) return true;
          return (
            brand.name.toLowerCase().includes(term) ||
            String(brand.corBrandId).includes(term)
          );
        });
        return { ...client, brands };
      })
      .filter((client) => {
        const fullSelected = draftFullClientIds.has(String(client._id));
        if (showAssignedOnly && fullSelected) return true;
        if (client.brands.length > 0) return true;
        if (showAssignedOnly) return false;
        const term = categorySearch.trim().toLowerCase();
        return (
          !term ||
          client.name.toLowerCase().includes(term) ||
          String(client.corClientId).includes(term) ||
          client.nomenclature?.toLowerCase().includes(term)
        );
      });
  }, [
    categorySearch,
    clients,
    draftBrandIds,
    draftFullClientIds,
    showAssignedOnly,
  ]);

  const summary = useMemo(
    () => ({
      pending: users.filter((user) => !user.userId).length,
      registered: users.filter((user) => user.userId).length,
      ready: users.filter((user) => user.status === "ready").length,
    }),
    [users],
  );

  const handleNewThread = async () => {
    await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    router.push("/workspace");
  };

  const handleSelectThread = () => router.push("/workspace");

  const handleAddExternalUser = async () => {
    const selectedClient = selectedNewClient;
    if (!newEmail.trim() || !newFirstName.trim() || !newLastName.trim()) {
      setToast({
        type: "error",
        message: "Correo, nombre y apellido son obligatorios.",
      });
      return;
    }
    if (!selectedClient) {
      setToast({ type: "error", message: "Selecciona un cliente." });
      return;
    }

    const selectedBrandIds =
      selectedClient.brands.length > 0 &&
      newBrandIds.size > 0 &&
      newBrandIds.size < selectedClient.brands.length
        ? (Array.from(newBrandIds) as Id<"clientBrands">[])
        : undefined;

    try {
      setAdding(true);
      const result = await upsertApprovedExternalUser({
        email: newEmail,
        firstName: newFirstName,
        lastName: newLastName,
        clientId: selectedClient._id,
        brandIds: selectedBrandIds,
      });
      setToast({
        type: "success",
        message: result.created
          ? "Correo aprobado. La persona ya puede ingresar con código."
          : "Correo actualizado.",
      });
      setNewEmail("");
      setNewFirstName("");
      setNewLastName("");
      setNewClientId(null);
      setNewClientSearch("");
      setNewBrandIds(new Set());
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos aprobar este correo."),
      });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveAssignments = async () => {
    if (!selectedUser) return;
    try {
      setSaving(true);
      await setAssignments({
        approvedExternalUserId: selectedUser._id,
        fullClientIds: Array.from(draftFullClientIds) as Id<"corClients">[],
        brandIds: Array.from(draftBrandIds) as Id<"clientBrands">[],
      });
      setToast({ type: "success", message: "Permisos actualizados." });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos guardar los permisos."),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetAssignments = () => {
    setDraftFullClientIds(new Set(currentFullClientIds));
    setDraftBrandIds(new Set(currentBrandIds));
  };

  const handleSearchTrello = async () => {
    if (!selectedUser) return;
    try {
      setSearchingTrello(true);
      setTrelloResult(null);
      const result = await searchTrelloMembers({
        approvedExternalUserId: selectedUser._id,
      });
      if (!result.ok) {
        setToast({ type: "error", message: result.error });
        return;
      }
      setTrelloResult(result);
      setToast({
        type: "success",
        message: "Encontramos posibles coincidencias en Trello.",
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos buscar en Trello."),
      });
    } finally {
      setSearchingTrello(false);
    }
  };

  const handleSelectTrelloCandidate = async (candidate: TrelloCandidate) => {
    if (!selectedUser) return;
    try {
      await setTrelloMember({
        approvedExternalUserId: selectedUser._id,
        trelloMemberId: candidate.id,
        trelloUsername: candidate.username,
        trelloMemberEmail: candidate.email,
        trelloMemberFullName: candidate.fullName,
      });
      setTrelloResult(null);
      setToast({
        type: "success",
        message: "Usuario de Trello vinculado. Ahora verifica sus accesos.",
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos vincular Trello."),
      });
    }
  };

  const handleVerifyTrello = async () => {
    if (!selectedUser) return;
    try {
      setVerifyingTrello(true);
      const result = await verifyTrelloAccess({
        approvedExternalUserId: selectedUser._id,
      });
      if (!result.ok) {
        setToast({ type: "error", message: result.error });
        return;
      }
      setToast({
        type: "success",
        message: `Acceso a Trello verificado en ${result.checkedBoards} tablero${
          result.checkedBoards !== 1 ? "s" : ""
        }.`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos verificar Trello."),
      });
    } finally {
      setVerifyingTrello(false);
    }
  };

  const handleOpenBoardDialog = (brand: BoardDialogBrand) => {
    setBoardDialogBrand(brand);
    setBoardSearchTerm(brand.name);
    setBoardResult(null);
    void handleSearchBoards(brand, brand.name);
  };

  const handleSearchBoards = async (
    brandOverride?: BoardDialogBrand,
    queryOverride?: string,
  ) => {
    const brand = brandOverride ?? boardDialogBrand;
    if (!brand) return;

    try {
      setSearchingBoards(true);
      const result = await searchTrelloBoards({
        clientBrandId: brand._id,
        query: queryOverride ?? boardSearchTerm,
      });
      if (!result.ok) {
        setBoardResult(null);
        setToast({ type: "error", message: result.error });
        return;
      }
      setBoardResult(result);
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(
          error,
          "No pudimos buscar tableros en Trello.",
        ),
      });
    } finally {
      setSearchingBoards(false);
    }
  };

  const handleAssociateBoard = async (board: TrelloBoardCandidate) => {
    if (!boardDialogBrand) return;

    try {
      setAssociatingBoardId(board.id);
      const result = await associateTrelloBoard({
        clientBrandId: boardDialogBrand._id,
        trelloBoardId: board.id,
      });
      if (!result.ok) {
        setToast({ type: "error", message: result.error });
        return;
      }

      setBoardDialogBrand(null);
      setBoardResult(null);
      setToast({
        type: "success",
        message:
          result.warnings.length > 0
            ? `Tablero asociado. ${result.warnings.join(" ")}`
            : `Tablero asociado: ${result.board.name}.`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: getErrorMessage(error, "No pudimos asociar ese tablero."),
      });
    } finally {
      setAssociatingBoardId(null);
    }
  };

  const toggleFullClient = (client: AdminClient) => {
    setDraftFullClientIds((current) => {
      const next = new Set(current);
      const clientId = String(client._id);
      if (next.has(clientId)) {
        next.delete(clientId);
      } else {
        next.add(clientId);
        setDraftBrandIds((brandIds) => {
          const nextBrandIds = new Set(brandIds);
          for (const brand of client.brands) {
            nextBrandIds.delete(String(brand._id));
          }
          return nextBrandIds;
        });
      }
      return next;
    });
  };

  const toggleBrand = (client: AdminClient, brandId: string) => {
    if (draftFullClientIds.has(String(client._id))) return;
    setDraftBrandIds((current) => {
      const next = new Set(current);
      if (next.has(brandId)) next.delete(brandId);
      else next.add(brandId);
      return next;
    });
  };

  const toggleNewBrand = (brandId: string) => {
    setNewBrandIds((current) => {
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
                <UserPlus className="h-5 w-5 text-primary" />
                <h1 className="text-xl font-semibold text-foreground">
                  Usuarios externos
                </h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Aprueba correos, asigna categorías y verifica acceso a Trello.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-right">
              <SummaryPill label="Pendientes" value={summary.pending} />
              <SummaryPill label="Registrados" value={summary.registered} />
              <SummaryPill label="Listos" value={summary.ready} />
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

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_1fr]">
          <aside className="border-r border-border bg-card min-h-0 flex flex-col">
            <div className="space-y-3 border-b border-border p-4">
              <div className="grid grid-cols-1 gap-2">
                <input
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="correo@cliente.com"
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
                <input
                  value={newFirstName}
                  onChange={(event) => setNewFirstName(event.target.value)}
                  placeholder="Nombre"
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
                <input
                  value={newLastName}
                  onChange={(event) => setNewLastName(event.target.value)}
                  placeholder="Apellido"
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
                <ClientSearchSelect
                  clients={clients}
                  selectedClientId={newClientId}
                  search={newClientSearch}
                  onSearchChange={setNewClientSearch}
                  onSelect={(clientId) => setNewClientId(clientId)}
                />
                {selectedNewClient && selectedNewClient.brands.length > 0 && (
                  <CategoryAccessSelect
                    brands={selectedNewClient.brands}
                    selectedBrandIds={newBrandIds}
                    onSelectAll={() => setNewBrandIds(new Set())}
                    onToggleBrand={toggleNewBrand}
                  />
                )}
                <Button
                  type="button"
                  onClick={handleAddExternalUser}
                  disabled={adding}
                  className="cursor-pointer"
                >
                  <Mail className="h-4 w-4" />
                  {adding ? "Agregando..." : "Aprobar correo"}
                </Button>
              </div>

              <div className="relative">
                <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar externo"
                  className="w-full h-9 rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {visibleUsers.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No hay usuarios externos para mostrar.
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
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {user.name || user.linkedUserName || user.email}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {user.email}
                            </div>
                          </div>
                          <StatusIcon status={user.status} />
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
                Selecciona un usuario externo.
              </div>
            ) : (
              <div className="p-6 max-w-6xl space-y-5">
                <section className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">
                        {selectedUser.name ||
                          selectedUser.linkedUserName ||
                          selectedUser.email}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {selectedUser.email}
                      </p>
                    </div>
                    <StatusBadge status={selectedUser.status} />
                  </div>

                  {!selectedUser.userId && (
                    <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                      Este correo ya puede ingresar con código. El cliente
                      y las marcas que aparecen debajo se habilitarán
                      automáticamente cuando la persona entre por primera vez.
                    </div>
                  )}
                </section>

                {selectedUser.userId ? (
                  <section className="rounded-lg border border-border bg-card">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
                        <div>
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4 text-primary" />
                            <h3 className="text-sm font-semibold text-foreground">
                              Permisos del cliente
                            </h3>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            El usuario externo solo podrá crear requerimientos
                            para estos clientes o categorías.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="cursor-pointer"
                            onClick={handleResetAssignments}
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
                            value={categorySearch}
                            onChange={(event) =>
                              setCategorySearch(event.target.value)
                            }
                            placeholder="Buscar cliente o categoría"
                            className="w-full h-9 rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                          />
                        </div>
                        <label className="inline-flex h-9 cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 text-sm text-foreground">
                          <input
                            type="checkbox"
                            checked={showAssignedOnly}
                            onChange={(event) =>
                              setShowAssignedOnly(event.target.checked)
                            }
                            className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
                          />
                          Solo asignados
                        </label>
                      </div>

                      <div className="divide-y divide-border">
                        {visibleClients.length === 0 ? (
                          <div className="px-4 py-8 text-sm text-muted-foreground">
                            No hay clientes que coincidan con el filtro actual.
                          </div>
                        ) : (
                          visibleClients.map((client) => {
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
                                        onChange={() =>
                                          toggleFullClient(client)
                                        }
                                        className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
                                      />
                                      {hasCategories
                                        ? "Acceso completo"
                                        : "Acceso al cliente"}
                                    </label>
                                  </div>
                                </div>

                                {client.brands.length > 0 && (
                                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                    {client.brands.map((brand) => {
                                      const selected =
                                        fullSelected ||
                                        draftBrandIds.has(String(brand._id));
                                      return (
                                        <div
                                          key={brand._id}
                                          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                                            fullSelected
                                              ? "border-border bg-muted/50 text-muted-foreground"
                                              : "border-border bg-background text-foreground hover:bg-accent"
                                          }`}
                                        >
                                          <label
                                            className={`flex min-w-0 flex-1 items-center gap-2 ${
                                              fullSelected
                                                ? "cursor-not-allowed"
                                                : "cursor-pointer"
                                            }`}
                                          >
                                            <input
                                              type="checkbox"
                                              disabled={fullSelected}
                                              checked={selected}
                                              onChange={() =>
                                                toggleBrand(
                                                  client,
                                                  String(brand._id),
                                                )
                                              }
                                              className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                                            />
                                            <span className="min-w-0 flex-1 truncate">
                                              {brand.name}
                                            </span>
                                          </label>
                                          {brand.trelloBoardId ? (
                                            <button
                                              type="button"
                                              className="shrink-0 cursor-pointer rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                              onClick={() =>
                                                handleOpenBoardDialog(brand)
                                              }
                                            >
                                              Cambiar
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              className="shrink-0 cursor-pointer rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950"
                                              onClick={() =>
                                                handleOpenBoardDialog(brand)
                                              }
                                            >
                                              Sin tablero
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>

                      {hasPermissionChanges && (
                        <div className="sticky bottom-0 z-10 border-t border-border bg-card/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur dark:shadow-[0_-8px_24px_rgba(0,0,0,0.28)]">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-sm">
                              <div className="font-medium text-foreground">
                                Cambios sin guardar
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Guarda o descarta los permisos seleccionados.
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                className="cursor-pointer"
                                onClick={handleResetAssignments}
                                disabled={saving}
                              >
                                Descartar
                              </Button>
                              <Button
                                type="button"
                                className="cursor-pointer"
                                onClick={handleSaveAssignments}
                                disabled={saving}
                              >
                                {saving ? "Guardando..." : "Guardar permisos"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                  </section>
                ) : (
                  <InvitedAccessPanel user={selectedUser} />
                )}

                {(selectedUser.userId || selectedUser.trelloRequired) && (
                  <TrelloPanel
                    user={selectedUser}
                    trelloResult={trelloResult}
                    searching={searchingTrello}
                    verifying={verifyingTrello}
                    onSearch={handleSearchTrello}
                    onVerify={handleVerifyTrello}
                    onSelectCandidate={handleSelectTrelloCandidate}
                  />
                )}
              </div>
            )}
          </main>
        </div>

        {boardDialogBrand && (
          <BoardAssociationDialog
            brand={boardDialogBrand}
            searchTerm={boardSearchTerm}
            result={boardResult}
            searching={searchingBoards}
            associatingBoardId={associatingBoardId}
            onSearchTermChange={setBoardSearchTerm}
            onSearch={() => handleSearchBoards()}
            onAssociate={handleAssociateBoard}
            onClose={() => {
              setBoardDialogBrand(null);
              setBoardResult(null);
            }}
          />
        )}
      </div>
    </WorkspaceLayout>
  );
}

function ClientSearchSelect({
  clients,
  selectedClientId,
  search,
  onSearchChange,
  onSelect,
}: {
  clients: AdminClient[];
  selectedClientId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (clientId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedClient = selectedClientId
    ? clients.find((client) => String(client._id) === selectedClientId)
    : null;
  const filteredClients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter(
      (client) =>
        client.name.toLowerCase().includes(term) ||
        String(client.corClientId).includes(term) ||
        client.nomenclature?.toLowerCase().includes(term),
    );
  }, [clients, search]);

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent focus:ring-2 focus:ring-primary"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            selectedClient ? "" : "text-muted-foreground"
          }`}
        >
          {selectedClient?.name ?? "Seleccionar cliente"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-10 z-30 rounded-md border border-border bg-card shadow-lg">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false);
                }}
                placeholder="Buscar cliente"
                className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filteredClients.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                Sin resultados.
              </div>
            ) : (
              filteredClients.map((client) => (
                <button
                  key={client._id}
                  type="button"
                  className={`w-full cursor-pointer rounded-md px-2 py-2 text-left text-sm transition-colors ${
                    selectedClientId === String(client._id)
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent"
                  }`}
                  onClick={() => {
                    onSelect(String(client._id));
                    onSearchChange("");
                    setOpen(false);
                  }}
                >
                  <span className="block truncate font-medium">
                    {client.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    COR {client.corClientId}
                    {client.nomenclature ? ` · ${client.nomenclature}` : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryAccessSelect({
  brands,
  selectedBrandIds,
  onSelectAll,
  onToggleBrand,
}: {
  brands: AdminClient["brands"];
  selectedBrandIds: Set<string>;
  onSelectAll: () => void;
  onToggleBrand: (brandId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const allSelected =
    selectedBrandIds.size === 0 || selectedBrandIds.size === brands.length;
  const label = allSelected
    ? "Todas las categorías"
    : `${selectedBrandIds.size} categoría${
        selectedBrandIds.size !== 1 ? "s" : ""
      }`;

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent focus:ring-2 focus:ring-primary"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-10 z-20 max-h-64 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg">
          <button
            type="button"
            className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
              allSelected
                ? "bg-primary/10 text-primary"
                : "text-foreground hover:bg-accent"
            }`}
            onClick={onSelectAll}
          >
            <input
              type="checkbox"
              checked={allSelected}
              readOnly
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="min-w-0 flex-1 truncate">Todas</span>
          </button>

          {brands.map((brand) => {
            const selected = allSelected || selectedBrandIds.has(String(brand._id));
            return (
              <button
                key={brand._id}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                onClick={() => onToggleBrand(String(brand._id))}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  readOnly
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="min-w-0 flex-1 truncate">{brand.name}</span>
              </button>
            );
          })}
        </div>
      )}
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

function BoardAssociationDialog({
  brand,
  searchTerm,
  result,
  searching,
  associatingBoardId,
  onSearchTermChange,
  onSearch,
  onAssociate,
  onClose,
}: {
  brand: BoardDialogBrand;
  searchTerm: string;
  result: TrelloBoardSearchResult | null;
  searching: boolean;
  associatingBoardId: string | null;
  onSearchTermChange: (value: string) => void;
  onSearch: () => void;
  onAssociate: (board: TrelloBoardCandidate) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">
                Asociar tablero
              </h3>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {brand.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchTerm}
                onChange={(event) => onSearchTermChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSearch();
                }}
                placeholder="Buscar tablero existente"
                className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={onSearch}
              disabled={searching}
            >
              {searching ? "Buscando..." : "Buscar"}
            </Button>
          </div>

          {brand.trelloBoardId && (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Esta categoría ya tiene un tablero asociado. Si seleccionas otro,
              se reemplazará por el nuevo tablero.
            </div>
          )}

          <div className="max-h-[420px] overflow-y-auto">
            {!result ? (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                Busca por nombre para elegir un tablero existente de Trello.
              </div>
            ) : (
              <div className="space-y-2">
                {result.boards.map((board) => {
                  const isCurrent = brand.trelloBoardId === board.id;
                  return (
                    <div
                      key={board.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-sm font-medium text-foreground">
                            {board.name}
                          </div>
                          {(board.url || board.shortUrl) && (
                            <a
                              href={board.url || board.shortUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                              aria-label="Abrir tablero en Trello"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {isCurrent ? "Tablero actual" : board.matchReason}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant={isCurrent ? "outline" : "default"}
                        className="cursor-pointer"
                        onClick={() => onAssociate(board)}
                        disabled={
                          associatingBoardId !== null || searching || isCurrent
                        }
                      >
                        {associatingBoardId === board.id
                          ? "Asociando..."
                          : isCurrent
                            ? "Asociado"
                            : "Asociar"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ExternalStatus }) {
  if (status === "ready") {
    return (
      <CheckCircle2
        className="h-4 w-4 text-emerald-500"
        aria-label="Usuario listo"
      />
    );
  }
  if (status === "pending_registration") {
    return (
      <Clock3
        className="h-4 w-4 text-blue-500"
        aria-label="Invitado pendiente de primer ingreso"
      />
    );
  }
  return (
    <AlertTriangle
      className="h-4 w-4 text-amber-500"
      aria-label="Usuario con configuración pendiente"
    />
  );
}

function StatusBadge({ status }: { status: ExternalStatus }) {
  const config = getStatusConfig(status);
  const Icon =
    status === "ready"
      ? CheckCircle2
      : status === "pending_registration"
        ? Clock3
        : AlertTriangle;
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${config.className}`}
    >
      <Icon className="h-4 w-4" />
      {config.label}
    </div>
  );
}

function getStatusConfig(status: ExternalStatus) {
  const neutral =
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  const error =
    "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200";
  if (status === "ready") {
    return {
      label: "Listo para requerimientos",
      className:
        "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    };
  }
  if (status === "pending_registration") {
    return {
      label: "Invitado · esperando primer ingreso",
      className:
        "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    };
  }
  if (status === "missing_categories") {
    return { label: "Faltan permisos", className: neutral };
  }
  if (status === "missing_trello") {
    return { label: "Falta vincular Trello", className: neutral };
  }
  if (status === "missing_boards") {
    return { label: "Faltan tableros", className: error };
  }
  if (status === "trello_error") {
    return { label: "Revisar Trello", className: error };
  }
  return { label: "Verificar Trello", className: neutral };
}

function InvitedAccessPanel({ user }: { user: ExternalUser }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Cliente y marcas de la invitación
          </h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Esta preasignación es informativa. El acceso se activará en el primer
          ingreso.
        </p>
      </div>

      {user.invitedAccess.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          Esta invitación no tiene un cliente preasignado.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {user.invitedAccess.map((access) => (
            <div key={access.clientId} className="px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {access.clientName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    COR {access.corClientId}
                  </div>
                </div>
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                  {access.allBrands
                    ? "Todas las marcas"
                    : `${access.brands.length} marca${access.brands.length !== 1 ? "s" : ""}`}
                </span>
              </div>

              {access.brands.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {access.brands.map((brand) => (
                    <span
                      key={brand._id}
                      className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    >
                      {brand.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TrelloPanel({
  user,
  trelloResult,
  searching,
  verifying,
  onSearch,
  onVerify,
  onSelectCandidate,
}: {
  user: ExternalUser;
  trelloResult: TrelloSearchResult | null;
  searching: boolean;
  verifying: boolean;
  onSearch: () => void;
  onVerify: () => void;
  onSelectCandidate: (candidate: TrelloCandidate) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
        <div>
          <div className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Trello</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Vincula a la persona con Trello y verifica que esté en los tableros
            necesarios, incluso antes de su primer ingreso.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={onSearch}
            disabled={searching}
          >
            {searching
              ? "Buscando..."
              : user.userId
                ? "Buscar en Trello"
                : "Relacionar con Trello"}
          </Button>
          <Button
            type="button"
            className="cursor-pointer"
            onClick={onVerify}
            disabled={verifying}
          >
            {verifying ? "Verificando..." : "Verificar acceso"}
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {user.trelloMemberId ? (
          <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
            <div className="font-medium text-foreground">
              {user.trelloMemberFullName ||
                user.trelloUsername ||
                "Usuario de Trello vinculado"}
            </div>
            <div className="text-xs text-muted-foreground">
              {user.trelloMemberEmail ||
                user.trelloUsername ||
                "Sin datos visibles"}
            </div>
            {user.trelloMemberSyncStatus === "verified" &&
              user.trelloMemberVerifiedAt && (
                <div className="mt-1 text-xs text-emerald-600 dark:text-emerald-300">
                  Acceso verificado{" "}
                  {formatDateTime(user.trelloMemberVerifiedAt)}
                </div>
              )}
            {user.trelloMemberSyncStatus === "error" &&
              user.trelloMemberSyncError && (
                <div className="mt-1 text-xs text-red-600 dark:text-red-300">
                  {user.trelloMemberSyncError}
                </div>
              )}
          </div>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Falta vincular esta persona con Trello.
          </div>
        )}

        {trelloResult && (
          <div>
            <div className="mb-2 text-sm font-medium text-foreground">
              Personas encontradas en {trelloResult.brandName}
            </div>
            <div className="space-y-2">
              {trelloResult.candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {candidate.fullName || candidate.username || candidate.id}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {candidate.email ||
                        candidate.username ||
                        "Sin correo visible"}{" "}
                      · {candidate.matchReason}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => onSelectCandidate(candidate)}
                  >
                    Seleccionar
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function sameStringSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
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
