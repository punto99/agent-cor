"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { useRouter } from "next/navigation";
import { Building2, RefreshCcw, Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";
import { Button } from "../../components/ui/Button";
import { ExternalBoardConfirmDialog } from "./ExternalBoardConfirmDialog";

type Notice = { kind: "success" | "error" | "warning"; text: string };

export default function ClientsAdminPage() {
  const router = useRouter();
  const access = useQuery(
    api.data.internalUserAdmin.viewerCanAccessInternalUserAdmin,
  );
  const dashboard = useQuery(
    api.data.clientAdmin.getDashboard,
    access?.canAccess ? {} : "skip",
  );
  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    access?.canAccess ? {} : "skip",
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);
  const setExternalBoard = useMutation(
    api.data.clientAdmin.setExternalBoardEnabled,
  );
  const syncClients = useAction(api.data.clientAdminActions.syncClientsFromCOR);
  const [search, setSearch] = useState("");
  const [savingClientId, setSavingClientId] = useState<Id<"corClients"> | null>(
    null,
  );
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingBoard, setPendingBoard] = useState<{
    clientId: Id<"corClients">;
    name: string;
    enabled: boolean;
  } | null>(null);

  useEffect(() => {
    if ((access && !access.canAccess) || (dashboard && !dashboard.canAccess))
      router.replace("/workspace");
  }, [access, dashboard, router]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const clients = dashboard?.canAccess ? dashboard.clients : [];
  const visibleClients = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return clients.filter(
      (client) =>
        !term ||
        client.name.toLocaleLowerCase().includes(term) ||
        String(client.corClientId).includes(term),
    );
  }, [clients, search]);

  const changeBoard = async () => {
    if (!pendingBoard || savingClientId !== null) return;
    const { clientId, enabled } = pendingBoard;
    setSavingClientId(clientId);
    setNotice(null);
    try {
      await setExternalBoard({ clientId, enabled });
      setNotice({
        kind: "success",
        text: enabled
          ? "Board externo habilitado para el cliente."
          : "Board externo oculto para el cliente.",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo guardar la configuración.",
      });
    } finally {
      setSavingClientId(null);
      setPendingBoard(null);
    }
  };

  const synchronize = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await syncClients({});
      const summary = `${result.stats.created} clientes agregados · ${result.stats.updated} actualizados · ${result.stats.errors} errores.`;
      setNotice({
        kind: !result.success
          ? "error"
          : result.stats.errors
            ? "warning"
            : "success",
        text: result.success
          ? summary
          : `${result.error ?? "No se pudo completar la sincronización."} ${summary}`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo sincronizar con COR.",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleNewThread = async () => {
    const threadId = await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    router.push(`/workspace?threadId=${encodeURIComponent(threadId)}`);
  };

  if (
    !access?.canAccess ||
    !dashboard?.canAccess ||
    threadsStatus === "LoadingFirstPage"
  )
    return <LoadingScreen />;

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={(threadId) =>
        router.push(`/workspace?threadId=${encodeURIComponent(threadId)}`)
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-card px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" aria-hidden="true" />
              <h1 className="text-xl font-semibold text-foreground">
                Clientes
              </h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Configura la vista del board y sus notificaciones para usuarios
              externos.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              variant="outline"
              disabled={
                syncing || savingClientId !== null || pendingBoard !== null
              }
              onClick={synchronize}
            >
              <RefreshCcw
                aria-hidden="true"
                className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />
              {syncing ? "Sincronizando..." : "Sincronizar con COR"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Actualiza los clientes existentes y agrega los nuevos.
            </p>
          </div>
        </header>

        {notice && (
          <p
            role={notice.kind === "success" ? "status" : "alert"}
            className={`mx-6 mt-4 rounded-md border px-4 py-3 text-sm ${
              notice.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                : notice.kind === "warning"
                  ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                  : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            }`}
          >
            {notice.text}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="relative w-full max-w-sm">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              aria-label="Buscar cliente por nombre o ID COR"
              placeholder="Buscar cliente por nombre o ID COR"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {visibleClients.length} de {clients.length} clientes ·{" "}
            {
              clients.filter((client) => client.externalBoardEnabled === true)
                .length
            }{" "}
            con board visible
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[650px] text-left text-sm">
              <caption className="sr-only">
                Clientes y configuración de su vista de tareas externas
              </caption>
              <thead className="border-b border-border bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Cliente
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    ID COR
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Vista de tareas externas
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Última sincronización
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleClients.map((client) => (
                  <tr key={client._id}>
                    <th
                      scope="row"
                      className="px-4 py-3 font-medium text-foreground"
                    >
                      {client.name}
                    </th>
                    <td className="px-4 py-3 text-muted-foreground">
                      {client.corClientId}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={client.externalBoardEnabled === true}
                          aria-label={`Mostrar board externo de ${client.name}`}
                          aria-haspopup="dialog"
                          aria-busy={savingClientId === client._id}
                          disabled={
                            savingClientId !== null ||
                            syncing ||
                            pendingBoard !== null
                          }
                          onClick={() =>
                            setPendingBoard({
                              clientId: client._id,
                              name: client.name,
                              enabled: client.externalBoardEnabled !== true,
                            })
                          }
                          className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 ${client.externalBoardEnabled === true ? "bg-blue-600" : "bg-slate-300 dark:bg-zinc-700"}`}
                        >
                          <span
                            aria-hidden="true"
                            className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${client.externalBoardEnabled === true ? "translate-x-4" : "translate-x-0"}`}
                          />
                        </button>
                        <span className="text-xs text-muted-foreground">
                          {client.externalBoardEnabled === true
                            ? "Activado"
                            : "Desactivado"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(client.syncedAt).toLocaleString("es-MX")}
                    </td>
                  </tr>
                ))}
                {!visibleClients.length && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      {search.trim()
                        ? "No se encontraron clientes con esa búsqueda."
                        : "No hay clientes. Sincroniza con COR para importar el listado."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Desactivado por defecto para usuarios externos. Al activarlo,
            conservan el acceso a sus clientes y categorías asignados. No
            modifica la creación de tareas ni el acceso de usuarios internos.
          </p>
        </div>
      </div>
      {pendingBoard && (
        <ExternalBoardConfirmDialog
          clientName={pendingBoard.name}
          enabled={pendingBoard.enabled}
          saving={savingClientId !== null}
          onClose={() => {
            if (savingClientId === null) setPendingBoard(null);
          }}
          onConfirm={() => void changeBoard()}
        />
      )}
    </WorkspaceLayout>
  );
}
