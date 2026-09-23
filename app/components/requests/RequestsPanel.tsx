"use client";

import boardStyles from "../board/BoardLayout.module.css";
import { Suspense } from "react";
import { RequestDialogRoute } from "./RequestDialogRoute";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { RequestsHeader } from "./RequestsHeader";
import { RequestsToolbar } from "./RequestsToolbar";
import { RequestsBoard } from "./RequestsBoard";
import { useRequestFilters } from "./useRequestFilters";
import { useNewRequest } from "./useNewRequest";
import styles from "./requestsInteractions.module.css";

export function RequestsPanel() {
  const requests = useQuery(api.data.tasks.listMyExternalRequests);
  const filters = useRequestFilters(requests ?? []);
  const newRequest = useNewRequest();
  return (
    <div data-board-theme className={`${boardStyles.page} ${styles.interactiveControls} flex h-full min-h-0 flex-col overflow-hidden`}>
      <Suspense fallback={null}><RequestDialogRoute requests={requests} /></Suspense>
      <div className="flex shrink-0 flex-col gap-3 px-4 py-3 sm:px-6 xl:flex-row xl:items-center xl:gap-6">
        <RequestsHeader clientName={filters.clients.length === 1 ? filters.clients[0].label : undefined} />
        <RequestsToolbar filters={filters} onNewRequest={newRequest.start} busy={newRequest.busy} />
      </div>
      {newRequest.error && <p role="alert" className="mx-4 mb-4 rounded-lg border border-destructive/30 bg-card p-3 text-sm text-destructive sm:mx-8">{newRequest.error}</p>}
      {requests === undefined ? <p role="status" className="px-8 py-12 text-muted-foreground">Cargando tareas…</p> : <>
        {requests.length === 0 && <p role="status" className="px-4 pb-5 text-sm text-muted-foreground sm:px-8">Todavía no creaste tareas. Usá «Nueva tarea» para empezar desde el chat.</p>}
        {requests.length > 0 && filters.filtered.length === 0 && <p role="status" className="px-4 pb-5 text-sm text-muted-foreground sm:px-8">No hay tareas que coincidan con estos filtros.</p>}
        <RequestsBoard requests={filters.filtered} />
      </>}
    </div>
  );
}
